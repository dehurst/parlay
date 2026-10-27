import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnvFile } from './env.js';
import { createStore } from './store.js';
import { weekWindow, weekLabel, lastSlot, nextSlot } from './week.js';
import { fetchEspnSchedule, fetchEspnRecords, demoSchedule, hasStarted, matchKey, teamKey } from './schedule.js';
import { fetchOddsApiSchedule, fetchBookLines, fetchEventIds, fetchEventProps } from './oddsapi.js';
import { isProp, validProp, propLine, parseProps, parseBoxScore, PROP_MARKETS } from './props.js';
import { tally, buildParlays, priceParlay, selectionLabel, MARKETS } from './parlay.js';
import { gradeLeg, gradeParlay, actualDecimal } from './grading.js';
import { fetchEspnScores, fetchOddsApiScores, fetchEspnPlayerStats } from './results.js';
import { computeStats } from './stats.js';
import { createHash } from 'node:crypto';
import { parseLogins, checkLogin, makeToken, readToken, cookieValue, sessionCookie, COOKIE } from './auth.js';
import { analyzeWeek } from './analysis.js';
import { seasonYear, fetchSeasonWeek, parseSeasonWeek, mergeWeek, fetchGameLine, buildTeams, fetchGameTeamStats, REGULAR_SEASON_WEEKS } from './research.js';
import { fetchTeamRoster, fetchTeamDepthChart, teamInjuries, dropStaleHistory, weekOf } from './injuries.js';
import { canSpend, spend, limitFor, easternDate, easternWeekday, LINES_COST, SCORES_COST } from './credits.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnvFile(join(root, '.env'));
const {
  ODDS_API_KEY = '',
  BOOKMAKER = 'fanduel',
  DAILY_CREDIT_LIMIT = '16',
  SUNDAY_CREDIT_LIMIT = '30',
  PLAYERS = 'Daniel,Asher,Matt',
  GROUP_CODE = '',
  LOGINS = '', // "matt:password,daniel:password,..." (set in Vercel, never in the code)
  SESSION_SECRET = '',
  DATA_FILE = join(root, 'data', 'db.json'),
} = process.env;

const SCHEDULE_TTL = 30 * 60e3; // re-check the schedule every 30 min (it's free)
const RETRY_AFTER_ERROR = 5 * 60e3;
// Lines update at 11 AM and 6 PM Eastern (the first visit after each), plus up
// to 2 manual refreshes on Sundays. Props update Thursday and Sunday at 11 AM.
// That keeps a month under the free plan's 500 credits (see README).
const LINE_HOURS = [11, 18];
const PROPS_HOURS = [11];
const PROPS_DAYS = [4, 0]; // Thursday, Sunday
const SUNDAY_MANUAL_REFRESHES = 2;
const MANUAL_REFRESH_GAP = 5 * 60e3; // so a double tap doesn't spend two refreshes
// Props pause when the month's credits left would drop under this, so lines
// keep working through the end of the month.
const PROPS_RESERVE = 75;
const limits = { daily: Number(DAILY_CREDIT_LIMIT), sunday: Number(SUNDAY_CREDIT_LIMIT) };
const creditLimit = () => limitFor(new Date(), limits);
const BOOK_NAMES = { fanduel: 'FanDuel', draftkings: 'DraftKings', betmgm: 'BetMGM', williamhill_us: 'Caesars' };
const bookName = BOOK_NAMES[BOOKMAKER] ?? BOOKMAKER;

const players = PLAYERS.split(',').map((p) => p.trim()).filter(Boolean);

// Logins: on once LOGINS is set. Sessions are signed with SESSION_SECRET, or
// one derived from LOGINS (changing a password logs everyone out).
const logins = parseLogins(LOGINS, players);
const authOn = logins.size > 0;
const sessionSecret = SESSION_SECRET || createHash('sha256').update(`parlay-session:${LOGINS}`).digest('hex');
if (!authOn) console.log('No LOGINS set: the site is open to anyone with the link.');

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

// Log in with a username and password; sets a 60-day session cookie.
const httpsReq = (req) => !!process.env.VERCEL || req.secure || req.get('x-forwarded-proto') === 'https';
app.post('/api/login', async (req, res) => {
  if (!authOn) return res.json({ me: null, auth: false });
  const player = checkLogin(logins, req.body?.username, req.body?.password);
  if (!player) {
    await new Promise((r) => setTimeout(r, 700)); // slow down guessing
    return res.status(401).json({ error: 'Wrong username or password.', login: true });
  }
  res.setHeader('Set-Cookie', sessionCookie(makeToken(player, sessionSecret), { secure: httpsReq(req) }));
  res.json({ me: player, auth: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie(null, { secure: httpsReq(req) }));
  res.json({ ok: true });
});

// Everything else needs a login (once LOGINS is set). The session decides who
// you are, so nobody can pick or bet as someone else.
app.use('/api', (req, res, next) => {
  if (!authOn) return next();
  const player = readToken(cookieValue(req.headers.cookie, COOKIE), sessionSecret);
  if (!player || !players.includes(player)) return res.status(401).json({ error: 'Please log in.', login: true });
  req.player = player;
  next();
});

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
async function loadWeek({ refreshLines = false, key = null } = {}) {
  const win = weekWindow();
  if (key && key < win.key) return loadPastWeek(key);
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

  // Paid refreshes: the first visit after 11 AM and after 6 PM Eastern (or
  // right away if this week has no lines yet), plus Sunday's manual ones,
  // within the daily credit cap. Skipped once every game has kicked off.
  let lines = store.data.lines[win.key];
  let limitHit = false;
  const now = new Date();
  const anyUpcoming = schedule.games.some((g) => !hasStarted(g, now));
  if (ODDS_API_KEY && !schedule.demo && anyUpcoming) {
    const age = lines ? Date.now() - lines.fetchedAt : Infinity;
    const due = !lines || lines.fetchedAt < lastSlot(now, LINE_HOURS).getTime();
    const manual = !due && refreshLines && manualLeft(now) > 0 && age > MANUAL_REFRESH_GAP;
    const wanted = due || manual;
    limitHit = wanted && !canSpend(store.data, LINES_COST, creditLimit());
    if (wanted && !limitHit) {
      try {
        const fresh = await fetchBookLines(ODDS_API_KEY, BOOKMAKER, win);
        // Merge so games that already kicked off keep their last line.
        lines = { ...fresh, byMatchup: { ...lines?.byMatchup, ...fresh.byMatchup }, fetchedAt: Date.now() };
        store.data.lines[win.key] = lines;
        spend(store.data, LINES_COST);
        noteRemaining(fresh.remaining);
        if (manual) {
          const today = easternDate(now);
          store.data.manualRefreshes = { [today]: (store.data.manualRefreshes?.[today] ?? 0) + 1 };
        }
        await save();
      } catch (err) {
        console.error(`${bookName} lines failed: ${describe(err)}`);
        problems.push(`Couldn't get ${bookName} lines: ${describe(err)}`);
      }
    }
  }

  if (ODDS_API_KEY && !schedule.demo && anyUpcoming) await refreshProps(win, schedule, now);

  const { games, gamesById } = withLines(win, schedule, lines);
  let warning = problems.join(' ') || null;
  if (schedule.demo) {
    warning = `Couldn't load the NFL schedule, so these are demo games. It retries every few minutes. ${warning ?? ''}`.trim();
  }
  return { win, games, gamesById, schedule, lines, warning, limitHit };
}

// Sunday's manual line refreshes left today (none on other days).
function manualLeft(now = new Date()) {
  if (easternWeekday(now) !== 'Sun') return 0;
  return Math.max(0, SUNDAY_MANUAL_REFRESHES - (store.data.manualRefreshes?.[easternDate(now)] ?? 0));
}

// The Odds API reports the month's credits left on every paid call.
function noteRemaining(remaining) {
  const n = Number(remaining);
  if (remaining != null && Number.isFinite(n)) store.data.apiRemaining = { value: n, at: Date.now() };
}

// Player props, Thursday and Sunday at 11 AM Eastern (the first visit after),
// for games that haven't started. ~2 credits a game. Paused if the month's
// credits would drop under PROPS_RESERVE.
//
// In between, games that came back with no props (the book hadn't posted
// them yet, common for night games, or the request failed) get another look
// every few hours until kickoff. The Odds API charges only for markets it
// returns, so a look that finds nothing costs nothing.
const PROPS_RECHECK = 3 * 3600e3;
async function refreshProps(win, schedule, now) {
  const props = store.data.props[win.key];
  // Someone else's visit is already fetching (or it just failed): wait.
  if (props?.retryAt > Date.now()) return;
  const upcoming = schedule.games.filter((g) => !hasStarted(g, now));
  if (!upcoming.length) return;
  const slot = lastSlot(now, PROPS_HOURS, PROPS_DAYS);
  const scheduled = slot && slot >= win.start && !(props?.fetchedAt >= slot.getTime());
  const has = (g) => props?.byGame?.[g.id]?.td?.length || props?.byGame?.[g.id]?.ptd?.length;
  const missing = upcoming.filter((g) => !has(g));
  const recheck = !scheduled && props?.fetchedAt && missing.length
    && Date.now() - (props.checkedAt ?? props.fetchedAt) > PROPS_RECHECK;
  if (!scheduled && !recheck) return;
  const targets = scheduled ? upcoming : missing;
  const markets = Object.values(PROP_MARKETS);
  const cost = targets.length * markets.length;
  const left = store.data.apiRemaining?.value;
  if (left != null && left - cost < PROPS_RESERVE) {
    store.data.props[win.key] = { ...props, byGame: props?.byGame ?? {}, paused: true, retryAt: Date.now() + 3600e3 };
    await save();
    return;
  }
  store.data.props[win.key] = { ...props, byGame: props?.byGame ?? {}, retryAt: Date.now() + 3 * 60e3 };
  await save();
  try {
    const ids = await fetchEventIds(ODDS_API_KEY, win); // free
    const byGame = { ...props?.byGame }; // games that started keep their last props
    let remaining = null;
    let ok = 0;
    // A few at a time to stay polite to the API.
    for (let i = 0; i < targets.length; i += 4) {
      const batch = await Promise.allSettled(targets.slice(i, i + 4).map(async (g) => {
        const id = ids[matchKey(g.away, g.home)];
        if (!id) return null;
        const res = await fetchEventProps(ODDS_API_KEY, BOOKMAKER, id, markets);
        return { gameId: g.id, props: parseProps(res.event, BOOKMAKER), remaining: res.remaining };
      }));
      for (const r of batch) {
        if (r.status === 'rejected') console.error(`${bookName} props failed: ${describe(r.reason)}`);
        else if (r.value) {
          byGame[r.value.gameId] = r.value.props;
          ok++;
          const n = Number(r.value.remaining);
          if (Number.isFinite(n)) remaining = remaining == null ? n : Math.min(remaining, n);
        }
      }
    }
    if (remaining != null) noteRemaining(remaining);
    // Nothing came back (API down?): try again in 30 minutes, not every visit.
    // A recheck keeps the scheduled time as "props from" and notes when it looked.
    store.data.props[win.key] = ok
      ? { byGame, fetchedAt: scheduled ? Date.now() : props.fetchedAt, checkedAt: Date.now() }
      : { byGame, fetchedAt: props?.fetchedAt, checkedAt: props?.checkedAt, retryAt: Date.now() + 30 * 60e3 };
  } catch (err) {
    console.error(`${bookName} props failed: ${describe(err)}`);
    store.data.props[win.key] = { ...store.data.props[win.key], retryAt: Date.now() + 30 * 60e3 };
  }
  await save();
}

// The book's current line for one side of a bet (props included).
function lineFor(game, market, side) {
  if (!game) return null;
  return isProp(market) ? propLine(game.props, market, side) : game.lines?.[market]?.[side] ?? null;
}

// Attach the book's line to each game. Games that kicked off drop out of the
// odds feed, so keep whatever lines we last saw for them.
function withLines(win, schedule, lines) {
  const records = schedule.records ?? {};
  const games = schedule.games.map((g) => ({
    ...g,
    lines: lines?.byMatchup[matchKey(g.away, g.home)] ?? null,
    homeRecord: records[teamKey(g.home)] ?? null,
    awayRecord: records[teamKey(g.away)] ?? null,
    // Player props (Thursday and Sunday), if the book has them.
    props: store.data.props[win.key]?.byGame?.[g.id] ?? null,
    // Final score, once known (looked up for games someone bet on).
    result: store.data.results[win.key]?.[g.id] ?? null,
  }));
  return { games, gamesById: new Map(games.map((g) => [g.id, g])) };
}

// A past week, read-only: only what's saved, nothing fetched. Old weeks'
// lines are pruned, so games only show odds through the picks people made.
function loadPastWeek(key) {
  const win = weekWindow(new Date(`${key}T16:00:00Z`));
  const schedule = store.data.schedule[key] ?? { games: [], source: null };
  const lines = store.data.lines[key] ?? null;
  return { win, ...withLines(win, schedule, lines), schedule, lines, warning: null, limitHit: false, past: true };
}

// The week a request asks for (?week=YYYY-MM-DD, or body.week); null means
// the current week. Only past weeks are allowed.
function requestedWeek(req) {
  const key = String(req.query.week ?? req.body?.week ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && key < weekWindow().key ? key : null;
}

// Weeks you can look back at: ones with picks or bets, newest first.
function pastWeeks(currentKey) {
  const keys = new Set([...Object.keys(store.data.picks), ...Object.keys(store.data.stakes)]);
  return [...keys]
    .filter((k) => k < currentKey && !k.startsWith('demo') && store.data.schedule[k] && !store.data.schedule[k].demo)
    .sort()
    .reverse()
    .map((key) => ({ key, label: weekLabel({ key }) }));
}

// Submitted picks only count for the configured players (older data may have others).
function submitted(win) {
  const all = store.data.picks[win.key] ?? {};
  return Object.fromEntries(players.filter((p) => all[p]?.length).map((p) => [p, all[p]]));
}

app.get('/api/week', async (req, res, next) => {
  try {
    await refreshResults(); // free (ESPN), at most every 10 min, so finished games show scores
    const past = requestedWeek(req);
    const { win, games, schedule, lines, warning, limitHit } = await loadWeek({ refreshLines: !past && req.query.refresh === '1', key: past });
    const now = new Date();
    const me = req.player ?? (players.includes(req.query.me) ? req.query.me : null);
    const currentKey = weekWindow().key;
    const live = !past && ODDS_API_KEY;
    res.json({
      key: win.key,
      label: weekLabel(win),
      me, // who's logged in (or the name you picked, without logins)
      auth: authOn,
      authMissing: !authOn && !!process.env.VERCEL, // hosted with no LOGINS set
      past: !!past,
      // Every week you can switch to, this one first.
      weeks: [{ key: currentKey, label: weekLabel(weekWindow()), current: true }, ...pastWeeks(currentKey)],
      demo: !!schedule.demo,
      source: schedule.source,
      book: ODDS_API_KEY ? bookName : null,
      linesUpdated: live ? lines?.fetchedAt ?? null : null,
      creditsLeft: live ? store.data.apiRemaining?.value ?? lines?.remaining ?? null : null,
      nextLinesAt: live ? nextSlot(now, LINE_HOURS)?.getTime() ?? null : null,
      propsUpdated: store.data.props[win.key]?.fetchedAt ?? null,
      nextPropsAt: live ? nextSlot(now, PROPS_HOURS, PROPS_DAYS)?.getTime() ?? null : null,
      propsPaused: live ? !!store.data.props[win.key]?.paused : false,
      warning,
      games: games.map((g) => ({ ...g, started: hasStarted(g, now) })),
      players,
      picks: submitted(win),
      // Your own unsubmitted selections (null if you have none); nobody else sees these.
      draft: (!past && me && store.data.drafts[win.key]?.[me]) || null,
      nextRefreshAt: live && lines ? lines.fetchedAt + MANUAL_REFRESH_GAP : null,
      // Manual refreshes: Sundays only.
      manualLeft: live ? manualLeft(now) : 0,
      manualPerSunday: SUNDAY_MANUAL_REFRESHES,
      limitHit,
    });
  } catch (err) {
    next(err);
  }
});

// Which bets can still be picked: real game, not started, and the book has a line.
function pickable(key, gamesById, now = new Date()) {
  const [gameId, market, side] = String(key).split('|');
  const game = gamesById.get(gameId);
  const valid = isProp(market) ? validProp(market, side) : MARKETS[market]?.includes(side);
  const line = lineFor(game, market, side);
  return valid && line && !hasStarted(game, now) ? line : null;
}

// A bet that can be logged as already placed: a real line we saved, on a game
// that hasn't started or is still in progress (no final score, under ~3½
// hours since kickoff), so nobody logs a bet after knowing how it ended.
function loggable(key, gamesById, win, now = Date.now()) {
  const [gameId, market, side] = String(key).split('|');
  const game = gamesById.get(gameId);
  const valid = isProp(market) ? validProp(market, side) : MARKETS[market]?.includes(side);
  const line = lineFor(game, market, side);
  if (!valid || !line || store.data.results[win.key]?.[gameId]) return null;
  return now - new Date(game.commence).getTime() < 3.5 * 3600e3 ? line : null;
}

function checkPlayer(req, res) {
  // Logged in: always you. Without logins: the name the page sends.
  const name = req.player ?? req.body?.name;
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

// Mark a parlay as placed at the sportsbook (or undo). Placed parlays lock
// their stakes so the slip keeps matching the real bet.
app.post('/api/placed', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    const win = weekWindow();
    const saved = store.data.stakes[win.key]?.[String(req.body.id ?? '')];
    if (!saved) return res.status(404).json({ error: 'That parlay isn’t on the slip anymore. Refresh and try again.' });
    if (req.body.placed) {
      // Optional: the real total payout from the sportsbook (stake included).
      let payout = null;
      if (req.body.payout != null && req.body.payout !== '') {
        payout = Math.round(Number(req.body.payout) * 100) / 100;
        const total = Object.values(saved.stakes).reduce((a, b) => a + b, 0);
        if (!Number.isFinite(payout) || payout <= total || payout > 10000000) {
          return res.status(400).json({ error: `Enter the total payout FanDuel shows (more than the $${total.toFixed(2)} bet).` });
        }
      }
      // Editing the payout keeps who placed it and when.
      saved.placed = { by: saved.placed?.by ?? name, at: saved.placed?.at ?? Date.now(), payout };
    } else delete saved.placed;
    await save();
    res.json({ placed: saved.placed ?? null });
  } catch (err) {
    next(err);
  }
});

// Mark a won (or pushed) parlay as paid out to everyone who was in, or undo.
app.post('/api/paidout', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    await refreshResults();
    // Past weeks too: a win from weeks ago can still get marked paid.
    const { win, gamesById, result } = await currentParlays(requestedWeek(req));
    const id = String(req.body.id ?? '');
    const saved = store.data.stakes[win.key]?.[id];
    if (!saved) return res.status(404).json({ error: 'That parlay isn’t on the slip anymore. Refresh and try again.' });
    if (req.body.paid) {
      const graded = gradedParlays(win, gamesById, new Set(result.options.map((o) => o.id))).find((p) => p.id === id);
      if (!['won', 'push'].includes(graded?.status)) {
        return res.status(409).json({ error: 'Only parlays that won or pushed have anything to pay out.' });
      }
      saved.paidOut = { by: name, at: Date.now() };
    } else delete saved.paidOut;
    await save();
    res.json({ paidOut: saved.paidOut ?? null });
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
async function currentParlays(key = null) {
  const { win, games, gamesById } = await loadWeek({ key });
  const picks = submitted(win);
  const voters = Object.keys(picks).length;
  const now = new Date();
  const startedIds = new Set(games.filter((g) => hasStarted(g, now)).map((g) => g.id));
  const tallied = tally(picks, gamesById).map((s) => ({
    ...s,
    current: lineFor(gamesById.get(s.gameId), s.market, s.side),
  }));
  const result = buildParlays(tallied, voters, { startedIds });
  for (const opt of result.options) opt.id = parlayId(opt.legs.map((l) => l.key));
  return { win, games, gamesById, tallied, result };
}

// Stakes for the parlays people are in on: { player: dollars }.
function stakesFor(win, id) {
  const stakes = store.data.stakes[win.key]?.[id]?.stakes ?? {};
  return Object.fromEntries(Object.entries(stakes).filter(([p]) => players.includes(p)));
}

app.get('/api/parlays', async (req, res, next) => {
  try {
    await refreshResults();
    const { win, gamesById, tallied, result } = await currentParlays(requestedWeek(req));
    // Parlays with money on them, split by where they stand: decided (won,
    // lost, or push), or in play (a game has started, not decided yet).
    const graded = gradedParlays(win, gamesById, new Set(result.options.map((o) => o.id)));
    const settled = graded
      .filter((p) => p.status !== 'pending')
      .sort((a, b) => (a.status === 'won' ? 0 : 1) - (b.status === 'won' ? 0 : 1) || b.total - a.total);
    const inPlay = graded
      .filter((p) => p.status === 'pending' && customStarted(p, gamesById))
      .sort((a, b) => b.total - a.total);
    const settledIds = new Set([...settled, ...inPlay].map((p) => p.id));
    for (const opt of result.options) {
      opt.stakes = stakesFor(win, opt.id);
      // A suggested parlay someone renamed keeps its new name.
      const saved = store.data.stakes[win.key]?.[opt.id];
      if (saved?.renamed) opt.name = saved.name;
      opt.placed = store.data.stakes[win.key]?.[opt.id]?.placed ?? null;
    }
    const custom = Object.values(store.data.stakes[win.key] ?? {})
      .filter((p) => p.custom && !settledIds.has(p.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((p) => ({
        ...p,
        stakes: stakesFor(win, p.id),
        started: customStarted(p, gamesById),
        legs: p.legs.map((l) => ({ ...l, current: lineFor(gamesById.get(l.gameId), l.market, l.side) })),
      }));
    const reactions = { parlays: {}, parlayDowns: {}, legs: {}, ...store.data.reactions[win.key] };
    res.json({ tallied, book: ODDS_API_KEY ? bookName : null, players, ...result, custom, inPlay, settled, reactions });
  } catch (err) {
    next(err);
  }
});

// True once any game in a parlay has kicked off.
function customStarted(p, gamesById, now = new Date()) {
  return p.legs.some((l) => {
    const game = gamesById.get(l.gameId);
    return !game || hasStarted(game, now);
  });
}

// Post your own parlay ("Daniel's Parlay 2") with your stake; others can join.
// Legs are priced at the book's current lines and saved as they are now.
app.post('/api/custom', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    // late: logging a bet already placed at the sportsbook (the game may be
    // under way), with everyone's stakes at once. Saved as placed.
    const late = req.body.late === true;
    let stakes;
    if (late) {
      stakes = {};
      for (const [who, value] of Object.entries(req.body.stakes ?? {})) {
        if (!players.includes(who)) continue;
        const amt = Math.round(Number(value || 0) * 100) / 100;
        if (!Number.isFinite(amt) || amt < 0 || amt > 10000) return res.status(400).json({ error: 'Stakes go from $0 to $10,000.' });
        if (amt > 0) stakes[who] = amt;
      }
      if (!Object.keys(stakes).length) return res.status(400).json({ error: 'Enter at least one person’s stake.' });
    } else {
      const amount = Math.round(Number(req.body.amount || 0) * 100) / 100;
      if (!(amount > 0) || amount > 10000) return res.status(400).json({ error: 'Enter how much you want on it ($1 to $10,000).' });
      stakes = { [name]: amount };
    }
    const { win, gamesById } = await loadWeek();
    const keys = [...new Set(Array.isArray(req.body.keys) ? req.body.keys.map(String) : [])];
    // One bet is a straight bet; two or more is a parlay.
    if (keys.length < 1) return res.status(400).json({ error: 'Pick at least one bet.' });
    const games = keys.map((k) => k.split('|')[0]);
    if (new Set(games).size < games.length) {
      return res.status(400).json({ error: 'A parlay can’t have two bets from the same game (FanDuel prices those differently).' });
    }
    const legs = [];
    for (const key of keys) {
      const line = late ? loggable(key, gamesById, win) : pickable(key, gamesById);
      if (!line) {
        return res.status(409).json({ error: late
          ? 'One of those games is over (or has no saved line), so it can’t be logged.'
          : 'One of those bets has started or lost its line. Refresh and try again.' });
      }
      const [gameId, market, side] = key.split('|');
      const game = gamesById.get(gameId);
      legs.push({
        key, gameId, market, side,
        label: selectionLabel(game, market, side, line.point),
        matchup: `${game.away} @ ${game.home}`,
        point: line.point, price: line.price, commence: game.commence,
      });
    }
    const weekStakes = (store.data.stakes[win.key] ??= {});
    const mine = Object.values(weekStakes).filter((p) => p.custom && p.owner === name);
    const number = Math.max(0, ...mine.map((p) => p.number)) + 1;
    const id = `custom:${name}:${number}`;
    const priced = priceParlay(legs.map((l) => ({ ...l, fairProb: 0.5 })));
    weekStakes[id] = {
      id, custom: true, owner: name, number, createdAt: Date.now(),
      name: `${name}'s ${legs.length === 1 ? 'Bet' : 'Parlay'} ${number}`,
      // Made with Copy & edit from another parlay: that parlay's name.
      basedOn: typeof req.body.from === 'string' && req.body.from.trim() ? req.body.from.trim().slice(0, 80) : null,
      legs, decimal: priced.decimal, american: priced.american,
      stakes,
      ...(late ? { late: true, placed: { by: name, at: Date.now(), payout: null } } : {}),
    };
    await save();
    res.json({ id, name: weekStakes[id].name });
  } catch (err) {
    next(err);
  }
});

// Like a parlay or dislike one of its legs (or take it back). Likes follow a
// parlay's exact set of legs; a leg dislike is on that bet for the whole week.
app.post('/api/react', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    const { kind, on } = req.body;
    const id = String(req.body.id ?? '');
    const isParlay = kind === 'parlay' || kind === 'parlay-down';
    const valid = isParlay ? id.length > 0 && id.length <= 2000 : kind === 'leg' && /^[^|]+\|(spread|total|ml)\|(home|away|over|under)$/.test(id);
    if (!valid) return res.status(400).json({ error: 'Nothing to react to.' });
    const win = weekWindow();
    const week = (store.data.reactions[win.key] ??= { parlays: {}, legs: {} });
    week.parlayDowns ??= {};
    const set = (bucket, add) => {
      const who = new Set(bucket[id] ?? []);
      if (add) who.add(name);
      else who.delete(name);
      if (who.size) bucket[id] = [...who];
      else delete bucket[id];
    };
    if (kind === 'leg') set(week.legs, on);
    else {
      // A parlay is a 👍 or a 👎, not both: setting one clears the other.
      const [mine, other] = kind === 'parlay' ? [week.parlays, week.parlayDowns] : [week.parlayDowns, week.parlays];
      set(mine, on);
      if (on) set(other, false);
    }
    await save();
    res.json({ reactions: week });
  } catch (err) {
    next(err);
  }
});

// Rename a saved parlay (a custom one, or a suggested one with money on it).
app.post('/api/rename', async (req, res, next) => {
  try {
    const name = checkPlayer(req, res);
    if (!name) return;
    const title = String(req.body.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 40) return res.status(400).json({ error: 'Give it a name of 1 to 40 characters.' });
    const saved = store.data.stakes[weekWindow().key]?.[String(req.body.id ?? '')];
    if (!saved) return res.status(404).json({ error: 'Only parlays that are saved (custom, or with money on them) can be renamed.' });
    saved.name = title;
    saved.renamed = true;
    await save();
    res.json({ name: title });
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
    const { win, gamesById, result } = await currentParlays();
    const weekStakes = (store.data.stakes[win.key] ??= {});
    const id = String(req.body.id ?? '');
    const saved = weekStakes[id];
    const option = result.options.find((o) => o.id === id);
    if (saved?.placed) {
      return res.status(409).json({ error: `${saved.placed.by} already placed this bet, so stakes are locked. They can undo "placed" on the Bet Slip.` });
    }

    if (amount > 0 && saved?.custom) {
      // Custom parlays keep their legs and odds; you can only join before kickoff.
      if (customStarted(saved, gamesById)) {
        return res.status(409).json({ error: 'A game in that parlay already started, so it can’t take new money.' });
      }
      saved.stakes[name] = amount;
    } else if (amount > 0) {
      if (!option) return res.status(409).json({ error: 'That parlay changed. Refresh and try again.' });
      weekStakes[id] = {
        id,
        name: saved?.renamed ? saved.name : option.name,
        ...(saved?.renamed ? { renamed: true } : {}),
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
// Every parlay with money on it this week, graded against final scores:
// each leg's result, the parlay's status, and what it pays back.
function gradedParlays(win, gamesById, optionIds) {
  const results = store.data.results[win.key] ?? {};
  return Object.values(store.data.stakes[win.key] ?? {})
    .map((p) => {
      const stakes = stakesFor(win, p.id);
      const total = Object.values(stakes).reduce((a, b) => a + b, 0);
      const legs = p.legs.map((l) => ({
        ...l,
        current: lineFor(gamesById.get(l.gameId), l.market, l.side),
        grade: gradeLeg(l, results[l.gameId]),
      }));
      const decimal = actualDecimal(p, total);
      const { status, returned } = gradeParlay(legs, total, decimal / p.decimal);
      const stillOption = p.custom || optionIds.has(p.id);
      return { ...p, stakes, total, estimate: total * p.decimal, decimal, payout: total * decimal, stillOption, legs, status, returned };
    })
    .filter((p) => p.total > 0);
}

app.get('/api/slip', async (req, res, next) => {
  try {
    await refreshResults();
    const { win, gamesById, result } = await currentParlays(requestedWeek(req));
    const totals = {};
    const parlays = gradedParlays(win, gamesById, new Set(result.options.map((o) => o.id)));
    for (const p of parlays) for (const [who, amt] of Object.entries(p.stakes)) totals[who] = (totals[who] ?? 0) + amt;
    parlays
      // Still to place first, then placed; bigger bets first within each.
      .sort((a, b) => !!a.placed - !!b.placed || b.total - a.total);
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
    // Games with a prop bet also need the players' stats once they're final.
    const propGames = new Set();
    for (const picks of Object.values(store.data.picks[week] ?? {})) for (const p of picks) if (isProp(p.key.split('|')[1])) propGames.add(p.key.split('|')[0]);
    for (const p of Object.values(store.data.stakes[week] ?? {})) for (const l of p.legs) if (isProp(l.key.split('|')[1])) propGames.add(l.gameId);
    const needsStats = () => games.filter((g) => propGames.has(g.id) && results[g.id] && !results[g.id].players);
    const due = games.filter((g) => bet.has(g.id) && !results[g.id] && Date.now() > new Date(g.commence).getTime() + GAME_LENGTH);
    if ((!due.length && !needsStats().length) || Date.now() - (store.data.scoresCheckedAt[week] ?? 0) < SCORES_RECHECK) continue;

    store.data.scoresCheckedAt[week] = Date.now();
    changed = true;
    let found = {};
    try {
      found = await fetchEspnScores(week, due);
    } catch (err) {
      console.error(`ESPN scores failed: ${describe(err)}`);
      const recent = due.some((g) => Date.now() - new Date(g.commence).getTime() < 3 * 24 * 3600e3);
      if (ODDS_API_KEY && recent && canSpend(store.data, SCORES_COST, creditLimit())) {
        try {
          found = await fetchOddsApiScores(ODDS_API_KEY, week);
          spend(store.data, SCORES_COST);
        } catch (err2) {
          console.error(`The Odds API scores failed: ${describe(err2)}`);
        }
      }
    }
    for (const g of due) if (found[g.id]) results[g.id] = found[g.id];

    // Player stats for prop bets, from ESPN's box score (free).
    const stats = needsStats();
    if (stats.length) {
      try {
        // Scores from the backup source don't carry ESPN's game ID.
        if (stats.some((g) => !results[g.id].espnId)) {
          const espn = await fetchEspnScores(week, stats);
          for (const g of stats) results[g.id].espnId ??= espn[g.id]?.espnId ?? null;
        }
        await Promise.all(stats.filter((g) => results[g.id].espnId).map(async (g) => {
          const players = await fetchEspnPlayerStats(results[g.id].espnId);
          if (players) results[g.id].players = players;
        }));
      } catch (err) {
        console.error(`ESPN box scores failed: ${describe(err)}`);
      }
    }
  }
  if (changed) await save();
}

app.get('/api/stats', async (req, res, next) => {
  try {
    await refreshResults();
    // ?week=YYYY-MM-DD (any week, this one included) narrows stats to that week.
    const key = String(req.query.week ?? '');
    res.json(computeStats(store.data, players, /^\d{4}-\d{2}-\d{2}$/.test(key) ? { week: key } : {}));
  } catch (err) {
    next(err);
  }
});

// Analysis tab: win chances, alternatives, and a look back for one week.
app.get('/api/analysis', async (req, res, next) => {
  try {
    await refreshResults();
    const past = requestedWeek(req);
    const { win, games, gamesById, result } = await currentParlays(past);
    const now = new Date();
    const withStarted = games.map((g) => ({ ...g, started: hasStarted(g, now) }));
    const me = req.player ?? (players.includes(req.query.me) ? req.query.me : null);
    // Your picks to rate: what you're editing (or selecting) if anything,
    // else what you submitted. Bets you'd submitted keep the line you got.
    const submittedPicks = (me && submitted(win)[me]) ?? [];
    const draft = !past && me ? store.data.drafts[win.key]?.[me] : null;
    const myPicks = draft
      ? draft.map((key) => submittedPicks.find((p) => p.key === key) ?? { key, ...pickable(key, gamesById, now) })
      : submittedPicks;
    res.json({
      label: weekLabel(win),
      book: ODDS_API_KEY ? bookName : null,
      ...analyzeWeek({
        games: withStarted,
        picks: submitted(win),
        myPicks,
        parlays: gradedParlays(win, gamesById, new Set(result.options.map((o) => o.id))),
        stats: {
          week: computeStats(store.data, players, { week: win.key }),
          season: computeStats(store.data, players),
        },
      }),
    });
  } catch (err) {
    next(err);
  }
});

// Research tab: every team's season from ESPN's scoreboard (free). Finished
// weeks are kept for good; weeks with games still to play are re-checked
// (every 15 minutes while games are on, else every 6 hours).
async function loadResearch(team = null, now = new Date()) {
  const season = seasonYear(now);
  if (store.data.research?.season !== season) store.data.research = { season, weeks: {} };
  const r = store.data.research;
  const stale = [];
  for (let n = 1; n <= REGULAR_SEASON_WEEKS; n++) {
    const w = r.weeks[n];
    // Weeks saved before game IDs were kept get fetched once more.
    if (w?.final && w.games.every((g) => g.espnId)) continue;
    const live = w?.games.some((g) => !g.final && new Date(g.date) <= now);
    if (!w || now - w.fetchedAt > (live ? 15 * 60e3 : 6 * 3600e3)) stale.push(n);
  }
  if (stale.length) {
    const fetched = await Promise.allSettled(stale.map((n) => fetchSeasonWeek(season, n)));
    let ok = 0;
    fetched.forEach((res, i) => {
      if (res.status === 'rejected') return console.error(`ESPN week ${stale[i]} failed: ${describe(res.reason)}`);
      const games = mergeWeek(r.weeks[stale[i]]?.games, parseSeasonWeek(res.value, stale[i]));
      r.weeks[stale[i]] = { games, fetchedAt: Date.now(), final: games.length > 0 && games.every((g) => g.final) };
      ok++;
    });
    if (ok) await save();
  }
  const games = Object.values(r.weeks).flatMap((w) => w.games);
  await loadBoxScores(r, games);
  await loadInjuries(r, games, now);

  // Finished games with no line: look up the closing line on ESPN's game
  // page and keep it for good. The team you're viewing goes first; up to
  // LINE_LOOKUPS a visit so the whole league fills in over a few visits.
  const LINE_LOOKUPS = 24;
  // Bump to look again at games already checked (e.g. after a parsing fix).
  const LINE_LOOKUP_VERSION = 1;
  const needs = games.filter((g) => g.final && g.espnId && g.homeLine == null && g.lineChecked !== LINE_LOOKUP_VERSION);
  const mine = (g) => g.home.name === team || g.away.name === team;
  const todo = [...needs.filter(mine), ...needs.filter((g) => !mine(g))].slice(0, LINE_LOOKUPS);
  if (todo.length) {
    for (let i = 0; i < todo.length; i += 6) {
      await Promise.all(todo.slice(i, i + 6).map(async (g) => {
        try {
          const found = await fetchGameLine(g);
          if (found) {
            g.homeLine = found.homeLine;
            g.total ??= found.total;
          }
          g.lineChecked = LINE_LOOKUP_VERSION; // looked, found or not: don't ask again
        } catch (err) {
          console.error(`ESPN line for game ${g.espnId} failed: ${describe(err)}`); // try again next visit
        }
      }));
    }
    await save();
  }
  return games;
}

// Team-level box score (yards, sacks, turnovers, downs, red zone,
// possession, penalties) for every finished game, fetched once and kept
// forever since a final box score doesn't change.
async function loadBoxScores(r, games) {
  r.boxscores ??= {};
  const missing = games.filter((g) => g.final && g.espnId != null && !r.boxscores[g.espnId]);
  if (!missing.length) return;
  const fetched = await Promise.allSettled(missing.map((g) => fetchGameTeamStats(g.espnId)));
  let ok = 0;
  fetched.forEach((res, i) => {
    if (res.status === 'rejected') return console.error(`ESPN box score ${missing[i].espnId} failed: ${describe(res.reason)}`);
    if (res.value) { r.boxscores[missing[i].espnId] = res.value; ok++; }
  });
  if (ok) await save();
}

// Every team's current injury report (yards/sacks-style free ESPN data):
// each player's tag (Questionable/Doubtful/Out/Injured Reserve/Suspension),
// roster position, and depth-chart standing. Refreshed every 6 hours; team
// ids come from the scoreboard games already fetched above.
async function loadInjuries(r, games, now) {
  r.injuries ??= { fetchedAt: 0, teams: {}, history: {} };
  if (now - r.injuries.fetchedAt < 6 * 3600e3) return;
  const teamIds = new Map();
  for (const g of games) {
    if (g.home.id != null) teamIds.set(g.home.abbr, g.home.id);
    if (g.away.id != null) teamIds.set(g.away.abbr, g.away.id);
  }
  const currentWeek = weekOf(now);
  const entries = [...teamIds.entries()];
  const fetched = await Promise.allSettled(entries.map(([, id]) => Promise.all([fetchTeamRoster(id), fetchTeamDepthChart(id)])));
  const teams = { ...r.injuries.teams };
  let ok = 0;
  fetched.forEach((res, i) => {
    const [abbr] = entries[i];
    if (res.status === 'rejected') return console.error(`ESPN injuries for ${abbr} failed: ${describe(res.reason)}`);
    const [roster, depthChart] = res.value;
    teams[abbr] = teamInjuries(roster, depthChart, r.injuries.history, currentWeek);
    ok++;
  });
  const seen = new Set(Object.values(teams).flat().map((p) => p.id));
  dropStaleHistory(r.injuries.history, seen);
  r.injuries.teams = teams;
  r.injuries.fetchedAt = now.getTime();
  if (ok) await save();
}

// For games ESPN has no line for: the FanDuel line this app saved (the last
// one before kickoff), if anyone opened the site that week.
function savedLine(game) {
  const lines = store.data.lines[weekWindow(new Date(game.date)).key]?.byMatchup?.[matchKey(game.away.name, game.home.name)];
  if (!lines) return null;
  return { homeLine: lines.spread?.home?.point ?? null, total: lines.total?.over?.point ?? null };
}

app.get('/api/research', async (req, res, next) => {
  try {
    const games = await loadResearch(typeof req.query.team === 'string' ? req.query.team : null);
    if (!games.length) return res.status(503).json({ error: 'Couldn’t reach ESPN for team stats. Try again in a few minutes.' });
    const teams = buildTeams(games, savedLine, store.data.research.boxscores);
    const injuries = store.data.research.injuries?.teams ?? {};
    for (const t of teams) t.injuries = injuries[t.abbr] ?? [];
    res.json({ season: store.data.research.season, teams, book: ODDS_API_KEY ? bookName : null });
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
