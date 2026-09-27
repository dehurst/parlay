import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store } from './src/store.js';
import { weekWindow, weekLabel } from './src/week.js';
import { fetchOdds, normalizeEvents, demoEvents } from './src/odds.js';
import { tally, buildParlays } from './src/parlay.js';

const root = dirname(fileURLToPath(import.meta.url));
const {
  ODDS_API_KEY = '',
  BOOKMAKER = 'draftkings',
  ODDS_CACHE_HOURS = '6',
  GROUP_CODE = '',
  PORT = '3000',
  DATA_FILE = join(root, 'data', 'db.json'),
} = process.env;

const store = new Store(DATA_FILE);
const app = express();
app.use(express.json());
app.use(express.static(join(root, 'public')));

// Optional shared code so randoms can't mess with your picks.
app.use('/api', (req, res, next) => {
  if (!GROUP_CODE || req.get('x-group-code') === GROUP_CODE) return next();
  res.status(401).json({ error: 'Wrong or missing group code' });
});

// Return this week's games, fetching from the API at most every ODDS_CACHE_HOURS.
async function loadWeek({ force = false } = {}) {
  const win = weekWindow();
  const cached = store.data.odds[win.key];
  const stale = !cached || Date.now() - cached.fetchedAt > Number(ODDS_CACHE_HOURS) * 3600e3;
  let warning = null;
  let fresh = null;

  if (!ODDS_API_KEY) {
    if (!cached) fresh = { fetchedAt: Date.now(), events: demoEvents(win.start), demo: true };
  } else if (stale || (force && Date.now() - cached.fetchedAt > 15 * 60e3)) {
    // Manual refreshes are capped at one per 15 minutes to protect API credits.
    try {
      const { events, remaining } = await fetchOdds({ apiKey: ODDS_API_KEY, ...win });
      fresh = { fetchedAt: Date.now(), events, remaining };
    } catch (err) {
      if (!cached) throw err;
      warning = `Couldn't refresh odds (${err.message}); showing lines from ${new Date(cached.fetchedAt).toLocaleString()}.`;
    }
  }

  if (fresh) {
    // Games drop out of the API feed once they kick off, so keep every event
    // seen this week; picks on started games still need their lines.
    const { events, ...meta } = fresh;
    const bucket = { ...(cached?.events ?? {}) };
    for (const ev of events) bucket[ev.id] = ev;
    store.data.odds[win.key] = { ...meta, events: bucket };
    store.save();
  }

  const snap = store.data.odds[win.key];
  const games = normalizeEvents(Object.values(snap.events), BOOKMAKER);
  const selections = new Map();
  for (const g of games) {
    for (const s of g.selections) {
      selections.set(s.key, { ...s, commence: g.commence, matchup: `${g.away} @ ${g.home}` });
    }
  }
  return { win, snap, games, selections, warning };
}

const cleanName = (n) => String(n ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);

app.get('/api/week', async (req, res, next) => {
  try {
    const { win, snap, games, warning } = await loadWeek({ force: req.query.refresh === '1' });
    res.json({
      key: win.key,
      label: weekLabel(win),
      demo: !!snap.demo,
      fetchedAt: snap.fetchedAt,
      remaining: snap.remaining ?? null,
      warning,
      games,
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

// Replace a player's picks for the week. Picks on games that already
// kicked off can't be added or removed.
app.put('/api/picks', async (req, res, next) => {
  try {
    const name = cleanName(req.body.name);
    if (!store.data.players.includes(name)) return res.status(400).json({ error: 'Unknown player' });
    const { win, selections } = await loadWeek();
    const now = new Date();
    const started = (key) => new Date(selections.get(key)?.commence) <= now;

    const weekPicks = (store.data.picks[win.key] ??= {});
    const before = weekPicks[name] ?? [];
    const requested = [...new Set(req.body.picks ?? [])].filter((k) => selections.has(k));

    const locked = before.filter(started);
    const fresh = requested.filter((k) => !started(k));
    const kept = [...locked, ...fresh];

    // One side per market per game: can't take both Over and Under.
    const byMarket = new Map();
    for (const k of kept) byMarket.set(k.split('|').slice(0, 2).join('|'), k);
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
    const { win, selections } = await loadWeek();
    const picks = store.data.picks[win.key] ?? {};
    const voters = Object.keys(picks).length;
    const stake = Math.max(1, Number(req.query.stake) || 10);
    const tallied = tally(picks, selections);
    res.json({ tallied, ...buildParlays(tallied, voters, { stake }) });
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
  if (!ODDS_API_KEY) console.log('No ODDS_API_KEY set: using demo odds.');
});
