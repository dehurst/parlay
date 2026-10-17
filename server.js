import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnvFile } from './src/env.js';
import { Store } from './src/store.js';
import { weekWindow, weekLabel } from './src/week.js';
import { fetchEspnSchedule, demoSchedule, hasStarted, matchKey } from './src/schedule.js';
import { fetchOddsApiSchedule, fetchBookLines } from './src/oddsapi.js';
import { tally, buildParlays, MARKETS } from './src/parlay.js';

const root = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(root, '.env'));
const {
  ODDS_API_KEY = '',
  BOOKMAKER = 'fanduel',
  ODDS_CACHE_HOURS = '6',
  PLAYERS = 'Daniel,Asher,Matt',
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

const players = PLAYERS.split(',').map((p) => p.trim()).filter(Boolean);

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

// Submitted picks only count for the configured players (older data may have others).
function submitted(win) {
  const all = store.data.picks[win.key] ?? {};
  return Object.fromEntries(players.filter((p) => all[p]?.length).map((p) => [p, all[p]]));
}

app.get('/api/week', async (req, res, next) => {
  try {
    const { win, games, schedule, lines, warning } = await loadWeek({ refreshLines: req.query.refresh === '1' });
    const now = new Date();
    const me = players.includes(req.query.me) ? req.query.me : null;
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
      players,
      picks: submitted(win),
      // Your own unsubmitted selections; nobody else sees these.
      draft: me ? store.data.drafts[win.key]?.[me] ?? [] : [],
    });
  } catch (err) {
    next(err);
  }
});

// Which bets can still be picked: real game, not started, and the book has a line.
function pickable(key, gamesById, now = new Date()) {
  const [gameId, market, side] = String(key).split('|');
  const game = gamesById.get(gameId);
  const line = game?.lines?.[market]?.[side];
  return MARKETS[market]?.includes(side) && line && !hasStarted(game, now) ? line : null;
}

function checkPlayer(req, res) {
  const name = req.body?.name;
  if (!players.includes(name)) {
    res.status(400).json({ error: 'Pick your name first' });
    return null;
  }
  return name;
}

// Save your unsubmitted selections (just the bet keys; lines are set on submit).
app.put('/api/draft', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    const { win, gamesById } = await loadWeek();
    if (store.data.picks[win.key]?.[name]?.length) {
      return res.status(409).json({ error: "You've already submitted this week's picks." });
    }
    const keys = [...new Set(req.body.keys ?? [])].filter((k) => pickable(k, gamesById));
    // One side per bet per game (can't take both Over and Under); last one wins.
    const byMarket = new Map(keys.map((k) => [k.split('|').slice(0, 2).join('|'), k]));
    const drafts = (store.data.drafts[win.key] ??= {});
    drafts[name] = [...byMarket.values()];
    store.save();
    res.json({ draft: drafts[name] });
  } catch (err) {
    next(err);
  }
});

// Lock in your picks at the book's current lines. No changes after this.
app.post('/api/submit', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    const { win, gamesById } = await loadWeek();
    const weekPicks = (store.data.picks[win.key] ??= {});
    if (weekPicks[name]?.length) return res.status(409).json({ error: "You've already submitted this week's picks." });

    const draft = store.data.drafts[win.key]?.[name] ?? [];
    const picks = [];
    const dropped = [];
    for (const key of draft) {
      const line = pickable(key, gamesById);
      if (line) picks.push({ key, point: line.point, price: line.price });
      else dropped.push(key);
    }
    if (!picks.length) {
      return res.status(400).json({ error: dropped.length ? 'Those games already started.' : 'Pick at least one bet first.' });
    }
    weekPicks[name] = picks;
    delete store.data.drafts[win.key][name];
    store.save();
    res.json({ picks: submitted(win), dropped: dropped.length });
  } catch (err) {
    next(err);
  }
});

app.get('/api/parlays', async (req, res, next) => {
  try {
    const { win, games, gamesById } = await loadWeek();
    const picks = submitted(win);
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
  console.log(`Players: ${players.join(', ')}`);
  console.log(ODDS_API_KEY
    ? `Using ${bookName} lines from The Odds API.`
    : 'No ODDS_API_KEY set: picks need sportsbook lines, so add a key to .env (see README).');
});
