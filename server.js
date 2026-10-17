import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnvFile } from './src/env.js';
import { Store } from './src/store.js';
import { weekWindow, weekLabel } from './src/week.js';
import { fetchEspnSchedule, demoSchedule, hasStarted, matchKey } from './src/schedule.js';
import { fetchOddsApiSchedule, fetchBookLines } from './src/oddsapi.js';
import { tally, buildParlays, MARKETS } from './src/parlay.js';
import { validPrice } from './src/odds-math.js';

const root = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(root, '.env'));
const {
  ODDS_API_KEY = '',
  BOOKMAKER = 'fanduel',
  ODDS_CACHE_HOURS = '6',
  GROUP_CODE = '',
  PORT = '3000',
  DATA_FILE = join(root, 'data', 'db.json'),
} = process.env;

const SCHEDULE_TTL = 30 * 60e3; // re-check the schedule every 30 min (it's free)
const RETRY_AFTER_ERROR = 5 * 60e3;
const LINES_TTL = Number(ODDS_CACHE_HOURS) * 3600e3;
const MANUAL_REFRESH_GAP = 15 * 60e3; // protects API credits from refresh-button mashing
const BOOK_NAMES = { fanduel: 'FanDuel', draftkings: 'DraftKings', betmgm: 'BetMGM', williamhill_us: 'Caesars' };
const bookName = BOOK_NAMES[BOOKMAKER] ?? BOOKMAKER;

const describe = (err) => `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`;

const store = new Store(DATA_FILE);
const app = express();
app.use(express.json());
app.use(express.static(join(root, 'public')));

// Optional shared code so randoms can't mess with your picks.
app.use('/api', (req, res, next) => {
  if (!GROUP_CODE || req.get('x-group-code') === GROUP_CODE) return next();
  res.status(401).json({ error: 'Wrong or missing group code' });
});

// Schedule sources in order of preference. The Odds API's event list is free.
async function fetchSchedule(win, problems) {
  if (ODDS_API_KEY) {
    try {
      return { games: await fetchOddsApiSchedule(ODDS_API_KEY, win), source: 'The Odds API' };
    } catch (err) {
      problems.push(`The Odds API schedule failed: ${describe(err)}`);
    }
  }
  try {
    return { games: await fetchEspnSchedule(win), source: 'ESPN' };
  } catch (err) {
    problems.push(`ESPN schedule failed: ${describe(err)}`);
  }
  return null;
}

// This week's games plus the book's current lines. Falls back to the last
// good schedule, then to a demo slate.
async function loadWeek({ refreshLines = false } = {}) {
  const win = weekWindow();
  const problems = [];

  const cached = store.data.schedule[win.key];
  if (!cached || Date.now() >= cached.retryAt) {
    const fresh = await fetchSchedule(win, problems);
    if (fresh) {
      // Finished games can drop out of a feed; keep the ones we already had.
      const ids = new Set(fresh.games.map((g) => g.id));
      const gone = (cached?.demo ? [] : cached?.games ?? []).filter((g) => !ids.has(g.id) && hasStarted(g));
      const games = [...fresh.games, ...gone].sort((a, b) => a.commence.localeCompare(b.commence));
      store.data.schedule[win.key] = { ...fresh, games, retryAt: Date.now() + SCHEDULE_TTL };
    } else if (cached && !cached.demo) {
      cached.retryAt = Date.now() + RETRY_AFTER_ERROR;
    } else {
      store.data.schedule[win.key] = { games: demoSchedule(win), source: 'demo', demo: true, retryAt: Date.now() + RETRY_AFTER_ERROR };
    }
    for (const p of problems) console.error(p);
    store.save();
  }
  const schedule = store.data.schedule[win.key];

  let lines = store.data.lines[win.key];
  if (ODDS_API_KEY && !schedule.demo) {
    const age = lines ? Date.now() - lines.fetchedAt : Infinity;
    if (age > LINES_TTL || (refreshLines && age > MANUAL_REFRESH_GAP)) {
      try {
        const fresh = await fetchBookLines(ODDS_API_KEY, BOOKMAKER, win);
        // Merge so games that already kicked off keep their last line.
        lines = { ...fresh, byMatchup: { ...lines?.byMatchup, ...fresh.byMatchup }, fetchedAt: Date.now() };
        store.data.lines[win.key] = lines;
        store.save();
      } catch (err) {
        console.error(`${bookName} lines failed: ${describe(err)}`);
        problems.push(`Couldn't get ${bookName} lines: ${describe(err)}`);
      }
    }
  }

  // Attach the book's line to each game. Games that kicked off drop out of the
  // odds feed, so keep whatever lines we last saw for them.
  const games = schedule.games.map((g) => ({ ...g, lines: lines?.byMatchup[matchKey(g.away, g.home)] ?? null }));
  const gamesById = new Map(games.map((g) => [g.id, g]));

  let warning = problems.join(' ') || null;
  if (schedule.demo) {
    warning = `Couldn't load the NFL schedule, so these are demo games. It retries every few minutes. ${warning ?? ''}`.trim();
  }
  return { win, games, gamesById, schedule, lines, warning };
}

const cleanName = (n) => String(n ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);

app.get('/api/week', async (req, res, next) => {
  try {
    const { win, games, schedule, lines, warning } = await loadWeek({ refreshLines: req.query.refresh === '1' });
    const now = new Date();
    res.json({
      key: win.key,
      label: weekLabel(win),
      demo: !!schedule.demo,
      source: schedule.source,
      book: ODDS_API_KEY ? bookName : null,
      linesUpdated: lines?.fetchedAt ?? null,
      creditsLeft: lines?.remaining ?? null,
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
    const tallied = tally(picks, gamesById).map((s) => ({
      ...s,
      current: gamesById.get(s.gameId).lines?.[s.market]?.[s.side] ?? null,
    }));
    res.json({ tallied, book: ODDS_API_KEY ? bookName : null, ...buildParlays(tallied, voters, { startedIds, stake }) });
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
  console.log(ODDS_API_KEY ? `Using ${bookName} lines from The Odds API.` : 'No ODDS_API_KEY: schedule from ESPN, lines typed in by hand.');
});
