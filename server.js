import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store } from './src/store.js';
import { weekWindow, weekLabel } from './src/week.js';
import { fetchSchedule, demoSchedule, hasStarted } from './src/schedule.js';
import { tally, buildParlays, MARKETS } from './src/parlay.js';
import { validPrice } from './src/odds-math.js';

const root = dirname(fileURLToPath(import.meta.url));
const {
  GROUP_CODE = '',
  PORT = '3000',
  DATA_FILE = join(root, 'data', 'db.json'),
} = process.env;

const SCHEDULE_TTL = 30 * 60e3; // re-check ESPN every 30 min (kickoff times, game status)
const RETRY_AFTER_ERROR = 5 * 60e3;

const store = new Store(DATA_FILE);
const app = express();
app.use(express.json());
app.use(express.static(join(root, 'public')));

// Optional shared code so randoms can't mess with your picks.
app.use('/api', (req, res, next) => {
  if (!GROUP_CODE || req.get('x-group-code') === GROUP_CODE) return next();
  res.status(401).json({ error: 'Wrong or missing group code' });
});

// This week's games, refreshed from ESPN every SCHEDULE_TTL.
// Falls back to the last good copy, then to a demo slate.
async function loadWeek() {
  const win = weekWindow();
  const cached = store.data.schedule[win.key];
  let warning = null;

  if (!cached || Date.now() >= cached.retryAt) {
    try {
      const games = await fetchSchedule(win);
      store.data.schedule[win.key] = { games, retryAt: Date.now() + SCHEDULE_TTL };
    } catch (err) {
      if (cached && !cached.demo) {
        cached.retryAt = Date.now() + RETRY_AFTER_ERROR;
        warning = `Couldn't reach ESPN for schedule updates (${err.message}).`;
      } else {
        store.data.schedule[win.key] = { games: demoSchedule(win.start), demo: true, retryAt: Date.now() + RETRY_AFTER_ERROR };
      }
    }
    store.save();
  }
  if (store.data.schedule[win.key].demo) {
    warning = "Couldn't load the NFL schedule from ESPN, so these are demo games. It retries every few minutes.";
  }

  const { games, demo = false } = store.data.schedule[win.key];
  const gamesById = new Map(games.map((g) => [g.id, g]));
  return { win, games, gamesById, demo, warning };
}

const cleanName = (n) => String(n ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);

app.get('/api/week', async (req, res, next) => {
  try {
    const { win, games, demo, warning } = await loadWeek();
    const now = new Date();
    res.json({
      key: win.key,
      label: weekLabel(win),
      demo,
      warning,
      games: games.map((g) => ({ ...g, started: hasStarted(g, now) })),
      players: store.data.players,
      picks: store.data.picks[win.key] ?? {},
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/players', (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const existing = store.data.players.find((p) => p.toLowerCase() === name.toLowerCase());
  if (!existing) {
    store.data.players.push(name);
    store.save();
  }
  res.json({ name: existing ?? name, players: store.data.players });
});

// Check one typed-in pick. Returns a clean { key, point, price } or an error string.
function parsePick(raw, gamesById) {
  const [gameId, market, side] = String(raw?.key ?? '').split('|');
  const game = gamesById.get(gameId);
  if (!game || !MARKETS[market]?.includes(side)) return { error: 'Unknown game or bet' };

  const price = raw.price === '' || raw.price == null ? (market === 'ml' ? null : -110) : Number(raw.price);
  if (price === null) return { error: 'Moneyline picks need odds, like -150 or +130' };
  if (!validPrice(price)) return { error: 'Odds should look like -110 or +150' };

  let point = null;
  if (market !== 'ml') {
    point = Number(raw.point);
    if (raw.point === '' || raw.point == null || !Number.isFinite(point)) {
      return { error: market === 'total' ? 'Enter the total, like 44.5' : 'Enter the spread, like -3.5' };
    }
    if (market === 'total' && (point <= 0 || point > 120)) return { error: 'Totals should be between 0 and 120' };
    if (market === 'spread' && Math.abs(point) > 50) return { error: 'Spreads should be between -50 and +50' };
    if (Math.round(point * 2) !== point * 2) return { error: 'Lines go in half-point steps' };
  }
  return { pick: { key: `${gameId}|${market}|${side}`, point, price }, game };
}

// Replace a player's picks for the week. Picks on games that already
// kicked off can't be added, changed, or removed.
app.put('/api/picks', async (req, res, next) => {
  try {
    const name = cleanName(req.body.name);
    if (!store.data.players.includes(name)) return res.status(400).json({ error: 'Unknown player' });
    const { win, gamesById } = await loadWeek();
    const now = new Date();
    const started = (key) => {
      const game = gamesById.get(key.split('|')[0]);
      return !game || hasStarted(game, now);
    };

    const weekPicks = (store.data.picks[win.key] ??= {});
    const locked = (weekPicks[name] ?? []).filter((p) => started(p.key));

    const fresh = [];
    for (const raw of req.body.picks ?? []) {
      if (started(String(raw?.key ?? ''))) continue;
      const { pick, error } = parsePick(raw, gamesById);
      if (error) return res.status(400).json({ error });
      fresh.push(pick);
    }

    // One side per bet per game (can't take both Over and Under); last one wins.
    const byMarket = new Map();
    for (const p of [...locked, ...fresh]) byMarket.set(p.key.split('|').slice(0, 2).join('|'), p);
    weekPicks[name] = [...byMarket.values()];
    if (!weekPicks[name].length) delete weekPicks[name];
    store.save();
    res.json({ picks: weekPicks });
  } catch (err) {
    next(err);
  }
});

app.get('/api/parlays', async (req, res, next) => {
  try {
    const { win, games, gamesById } = await loadWeek();
    const picks = store.data.picks[win.key] ?? {};
    const voters = Object.keys(picks).length;
    const stake = Math.max(1, Number(req.query.stake) || 10);
    const now = new Date();
    const startedIds = new Set(games.filter((g) => hasStarted(g, now)).map((g) => g.id));
    const tallied = tally(picks, gamesById);
    res.json({ tallied, ...buildParlays(tallied, voters, { startedIds, stake }) });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(Number(PORT), () => {
  console.log(`Parlay Party on http://localhost:${PORT}`);
});
