import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnvFile } from './env.js';
import { createStore } from './store.js';
import { weekWindow, weekLabel } from './week.js';
import { fetchEspnSchedule, fetchEspnRecords, demoSchedule, hasStarted, matchKey, teamKey } from './schedule.js';
import { fetchOddsApiSchedule, fetchBookLines } from './oddsapi.js';
import { tally, buildParlays, MARKETS } from './parlay.js';
import { gradeLeg, gradeParlay } from './grading.js';
import { fetchEspnScores, fetchOddsApiScores } from './results.js';
import { computeStats } from './stats.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnvFile(join(root, '.env'));
const {
  ODDS_API_KEY = '',
  BOOKMAKER = 'fanduel',
  ODDS_CACHE_HOURS = '6',
  PLAYERS = 'Daniel,Asher,Matt',
  GROUP_CODE = '',
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

const SCORES_RECHECK = 10 * 60e3;
const GAME_LENGTH = 3 * 3600e3; // don't look for a final score until ~3h after kickoff

let store;
const save = () => store.save(weekWindow().key);

const app = express();
// Vercel may have already parsed the body; only parse it ourselves if not.
const json = express.json();
app.use((req, res, next) => (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? next() : json(req, res, next)));
// On Vercel, public/ is served by its CDN instead; this is for local runs.
app.use(express.static(join(root, 'public')));

// Load the latest data for every API request.
app.use('/api', async (req, res, next) => {
  try {
    store ??= createStore(process.env, DATA_FILE);
    await store.load();
    next();
  } catch (err) {
    next(err);
  }
});

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
  // Schedules saved before team records existed get refreshed right away.
  if (!cached || Date.now() >= cached.retryAt || (!cached.demo && !cached.records)) {
    const fresh = await fetchSchedule(win, problems);
    if (fresh) {
      // Finished games can drop out of a feed; keep the ones we already had.
      const ids = new Set(fresh.games.map((g) => g.id));
      const gone = (cached?.demo ? [] : cached?.games ?? []).filter((g) => !ids.has(g.id) && hasStarted(g));
      const games = [...fresh.games, ...gone].sort((a, b) => a.commence.localeCompare(b.commence));
      // Team records come from ESPN; keep the last ones if it's unreachable.
      let records = cached?.records ?? {};
      try {
        records = { ...records, ...(await fetchEspnRecords(games)) };
      } catch (err) {
        console.error(`ESPN records failed: ${describe(err)}`);
      }
      store.data.schedule[win.key] = { ...fresh, games, records, retryAt: Date.now() + SCHEDULE_TTL };
    } else if (cached && !cached.demo) {
      cached.retryAt = Date.now() + RETRY_AFTER_ERROR;
    } else {
      store.data.schedule[win.key] = { games: demoSchedule(win), source: 'demo', demo: true, retryAt: Date.now() + RETRY_AFTER_ERROR };
    }
    for (const p of problems) console.error(p);
    await save();
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
        await save();
      } catch (err) {
        console.error(`${bookName} lines failed: ${describe(err)}`);
        problems.push(`Couldn't get ${bookName} lines: ${describe(err)}`);
      }
    }
  }

  // Attach the book's line to each game. Games that kicked off drop out of the
  // odds feed, so keep whatever lines we last saw for them.
  const records = schedule.records ?? {};
  const games = schedule.games.map((g) => ({
    ...g,
    lines: lines?.byMatchup[matchKey(g.away, g.home)] ?? null,
    homeRecord: records[teamKey(g.home)] ?? null,
    awayRecord: records[teamKey(g.away)] ?? null,
  }));
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
      // Your own unsubmitted selections (null if you have none); nobody else sees these.
      draft: (me && store.data.drafts[win.key]?.[me]) ?? null,
      nextRefreshAt: lines ? lines.fetchedAt + MANUAL_REFRESH_GAP : null,
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
// After submitting, a draft means you're editing; submitted picks still count
// until you resubmit.
app.put('/api/draft', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    const { win, gamesById } = await loadWeek();
    const keys = [...new Set(req.body.keys ?? [])].filter((k) => pickable(k, gamesById));
    // One side per bet per game (can't take both Over and Under); last one wins.
    const byMarket = new Map(keys.map((k) => [k.split('|').slice(0, 2).join('|'), k]));
    const drafts = (store.data.drafts[win.key] ??= {});
    drafts[name] = [...byMarket.values()];
    await save();
    res.json({ draft: drafts[name] });
  } catch (err) {
    next(err);
  }
});

// Throw away edits and keep what you submitted.
app.delete('/api/draft', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    const { win } = await loadWeek();
    if (store.data.drafts[win.key]) delete store.data.drafts[win.key][name];
    await save();
    res.json({ draft: null });
  } catch (err) {
    next(err);
  }
});

// Submit (or resubmit) your picks. Bets you already had keep the line you got;
// new ones take the book's current line. Picks on started games can't change.
app.post('/api/submit', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    const { win, gamesById } = await loadWeek();
    const weekPicks = (store.data.picks[win.key] ??= {});
    const before = weekPicks[name] ?? [];
    const now = new Date();
    const started = (key) => {
      const game = gamesById.get(key.split('|')[0]);
      return !game || hasStarted(game, now);
    };

    const draft = store.data.drafts[win.key]?.[name] ?? [];
    const picks = before.filter((p) => started(p.key));
    const dropped = [];
    for (const key of draft) {
      if (picks.some((p) => p.key === key)) continue;
      const kept = before.find((p) => p.key === key);
      const line = pickable(key, gamesById, now);
      if (kept && line) picks.push(kept);
      else if (line) picks.push({ key, point: line.point, price: line.price });
      else dropped.push(key);
    }
    if (!picks.length) {
      return res.status(400).json({ error: dropped.length ? 'Those games already started.' : 'Pick at least one bet first.' });
    }
    weekPicks[name] = picks;
    delete store.data.drafts[win.key][name];
    await save();
    res.json({ picks: submitted(win), dropped: dropped.length });
  } catch (err) {
    next(err);
  }
});

// A parlay is identified by its legs, so stakes follow the same set of bets
// even if its name or position on the page changes.
const parlayId = (keys) => [...keys].sort().join(',');

// The current parlay options built from everyone's submitted picks.
async function currentParlays() {
  const { win, games, gamesById } = await loadWeek();
  const picks = submitted(win);
  const voters = Object.keys(picks).length;
  const now = new Date();
  const startedIds = new Set(games.filter((g) => hasStarted(g, now)).map((g) => g.id));
  const tallied = tally(picks, gamesById).map((s) => ({
    ...s,
    current: gamesById.get(s.gameId).lines?.[s.market]?.[s.side] ?? null,
  }));
  const result = buildParlays(tallied, voters, { startedIds });
  for (const opt of result.options) opt.id = parlayId(opt.legs.map((l) => l.key));
  return { win, gamesById, tallied, result };
}

// Stakes for the parlays people are in on: { player: dollars }.
function stakesFor(win, id) {
  const stakes = store.data.stakes[win.key]?.[id]?.stakes ?? {};
  return Object.fromEntries(Object.entries(stakes).filter(([p]) => players.includes(p)));
}

app.get('/api/parlays', async (req, res, next) => {
  try {
    const { win, tallied, result } = await currentParlays();
    for (const opt of result.options) opt.stakes = stakesFor(win, opt.id);
    res.json({ tallied, book: ODDS_API_KEY ? bookName : null, players, ...result });
  } catch (err) {
    next(err);
  }
});

// Put money on a parlay (or change/remove it with amount 0). The parlay is
// saved as it is right now, so it stays on the bet slip even after kickoff or
// if picks later change.
app.post('/api/stake', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    const amount = Math.round(Number(req.body.amount || 0) * 100) / 100;
    if (!Number.isFinite(amount) || amount < 0 || amount > 10000) {
      return res.status(400).json({ error: 'Enter an amount between $0 and $10,000' });
    }
    const { win, result } = await currentParlays();
    const weekStakes = (store.data.stakes[win.key] ??= {});
    const id = String(req.body.id ?? '');
    const saved = weekStakes[id];
    const option = result.options.find((o) => o.id === id);

    if (amount > 0) {
      if (!option) return res.status(409).json({ error: 'That parlay changed. Refresh and try again.' });
      weekStakes[id] = {
        id,
        name: option.name,
        legs: option.legs.map(({ key, gameId, market, label, matchup, point, price, commence }) =>
          ({ key, gameId, market, side: key.split('|')[2], label, matchup, point, price, commence })),
        decimal: option.decimal,
        american: option.american,
        stakes: { ...saved?.stakes, [name]: amount },
      };
    } else if (saved) {
      delete saved.stakes[name];
      if (!Object.keys(saved.stakes).length) delete weekStakes[id];
    }
    await save();
    res.json({ id, stakes: stakesFor(win, id) });
  } catch (err) {
    next(err);
  }
});

// Everything the person placing bets needs: each parlay with money on it,
// who's in for how much, and whether any line has moved since.
app.get('/api/slip', async (req, res, next) => {
  try {
    await refreshResults();
    const { win, gamesById, result } = await currentParlays();
    const results = store.data.results[win.key] ?? {};
    const optionIds = new Set(result.options.map((o) => o.id));
    const totals = {};
    const parlays = Object.values(store.data.stakes[win.key] ?? {})
      .map((p) => {
        const stakes = stakesFor(win, p.id);
        const total = Object.values(stakes).reduce((a, b) => a + b, 0);
        for (const [who, amt] of Object.entries(stakes)) totals[who] = (totals[who] ?? 0) + amt;
        const legs = p.legs.map((l) => ({
          ...l,
          current: gamesById.get(l.gameId)?.lines?.[l.market]?.[l.side] ?? null,
          grade: gradeLeg(l, results[l.gameId]),
        }));
        const { status, returned } = gradeParlay(legs, total);
        return { ...p, stakes, total, payout: total * p.decimal, stillOption: optionIds.has(p.id), legs, status, returned };
      })
      .filter((p) => p.total > 0)
      .sort((a, b) => b.total - a.total);
    res.json({ book: ODDS_API_KEY ? bookName : null, parlays, totals });
  } catch (err) {
    next(err);
  }
});

// Look up final scores for games people bet on that should be over by now.
// ESPN is free; The Odds API (2 credits) is the backup.
async function refreshResults() {
  const weeks = new Set([...Object.keys(store.data.picks), ...Object.keys(store.data.stakes)]);
  let changed = false;
  for (const week of weeks) {
    const games = store.data.schedule[week]?.games ?? [];
    const results = (store.data.results[week] ??= {});
    const bet = new Set();
    for (const picks of Object.values(store.data.picks[week] ?? {})) for (const p of picks) bet.add(p.key.split('|')[0]);
    for (const p of Object.values(store.data.stakes[week] ?? {})) for (const l of p.legs) bet.add(l.gameId);
    const due = games.filter((g) => bet.has(g.id) && !results[g.id] && Date.now() > new Date(g.commence).getTime() + GAME_LENGTH);
    if (!due.length || Date.now() - (store.data.scoresCheckedAt[week] ?? 0) < SCORES_RECHECK) continue;

    store.data.scoresCheckedAt[week] = Date.now();
    changed = true;
    let found = {};
    try {
      found = await fetchEspnScores(week, due);
    } catch (err) {
      console.error(`ESPN scores failed: ${describe(err)}`);
      const recent = due.some((g) => Date.now() - new Date(g.commence).getTime() < 3 * 24 * 3600e3);
      if (ODDS_API_KEY && recent) {
        try {
          found = await fetchOddsApiScores(ODDS_API_KEY, week);
        } catch (err2) {
          console.error(`The Odds API scores failed: ${describe(err2)}`);
        }
      }
    }
    for (const g of due) if (found[g.id]) results[g.id] = found[g.id];
  }
  if (changed) await save();
}

app.get('/api/stats', async (req, res, next) => {
  try {
    await refreshResults();
    res.json(computeStats(store.data, players));
  } catch (err) {
    next(err);
  }
});

// Clear your picks for the week: submitted ones and unsubmitted selections.
// Picks on games that already started stay, since those bets are live.
app.delete('/api/picks', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    const { win, gamesById } = await loadWeek();
    const now = new Date();
    const weekPicks = store.data.picks[win.key] ?? {};
    const kept = (weekPicks[name] ?? []).filter((p) => {
      const game = gamesById.get(p.key.split('|')[0]);
      return game && hasStarted(game, now);
    });
    if (kept.length) weekPicks[name] = kept;
    else delete weekPicks[name];
    if (store.data.drafts[win.key]) delete store.data.drafts[win.key][name];
    await save();
    res.json({ picks: submitted(win), kept: kept.length });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

export const config = { players, bookName, hasOddsKey: !!ODDS_API_KEY };
export default app;
