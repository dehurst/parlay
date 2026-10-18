import { makeGame, matchKey } from './schedule.js';

// The Odds API (https://the-odds-api.com). The events list is free; odds cost
// one credit per market per bookmaker group, so h2h+spreads+totals = 3 credits.
const BASE = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl';

const isoNoMs = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function get(path, params) {
  const res = await fetch(`${BASE}/${path}?${new URLSearchParams(params)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`The Odds API returned ${res.status}${body.message ? `: ${body.message}` : ''}`);
  }
  return {
    data: await res.json(),
    remaining: res.headers.get('x-requests-remaining'),
    // Credits this call cost, as reported by The Odds API.
    last: res.headers.get('x-requests-last'),
  };
}

const timeRange = ({ start, end }) => ({ commenceTimeFrom: isoNoMs(start), commenceTimeTo: isoNoMs(end) });

export async function fetchOddsApiSchedule(apiKey, win) {
  const { data } = await get('events', { apiKey, ...timeRange(win) });
  return data
    .map((ev) => makeGame({ weekKey: win.key, home: ev.home_team, away: ev.away_team, commence: ev.commence_time }))
    .sort((a, b) => a.commence.localeCompare(b.commence));
}

export async function fetchBookLines(apiKey, book, win) {
  const { data, remaining } = await get('odds', {
    apiKey,
    bookmakers: book,
    markets: 'h2h,spreads,totals',
    oddsFormat: 'american',
    ...timeRange(win),
  });
  return { byMatchup: parseLines(data, book), remaining };
}

// { "broncos@chiefs": { spread: { home: { point, price }, away }, total: { over, under }, ml: { home, away } } }
export function parseLines(events, book) {
  const out = {};
  for (const ev of events) {
    const bm = ev.bookmakers?.find((b) => b.key === book);
    if (!bm) continue;
    const outcomes = (key) => bm.markets?.find((m) => m.key === key)?.outcomes ?? [];
    const side = (o) => (o.name === ev.home_team ? 'home' : 'away');
    const lines = {};
    for (const o of outcomes('h2h')) (lines.ml ??= {})[side(o)] = { point: null, price: o.price };
    for (const o of outcomes('spreads')) (lines.spread ??= {})[side(o)] = { point: o.point, price: o.price };
    for (const o of outcomes('totals')) (lines.total ??= {})[o.name.toLowerCase()] = { point: o.point, price: o.price };
    out[matchKey(ev.away_team, ev.home_team)] = lines;
  }
  return out;
}

// Alternate spreads and totals for every listed game, one request per game
// (2 credits each: one per market). Games are matched to The Odds API's
// events by team names, using its free events list.
// Returns { byGame: { gameId: { spread: { home: [...], away: [...] }, total: { over, under } } },
//           credits, remaining, failed }.
export async function fetchAltLines(apiKey, book, win, games) {
  const { data: events } = await get('events', { apiKey, ...timeRange(win) });
  const eventFor = new Map(events.map((ev) => [matchKey(ev.away_team, ev.home_team), ev]));
  const byGame = {};
  let credits = 0;
  let remaining = null;
  let failed = 0;
  await Promise.all(games.map(async (g) => {
    const ev = eventFor.get(matchKey(g.away, g.home));
    if (!ev) return;
    try {
      const res = await get(`events/${ev.id}/odds`, {
        apiKey, bookmakers: book, markets: 'alternate_spreads,alternate_totals', oddsFormat: 'american',
      });
      credits += Number(res.last ?? 2) || 0;
      if (res.remaining != null) remaining = Math.min(remaining ?? Infinity, Number(res.remaining));
      const alt = parseAltLines(res.data, book);
      if (alt) byGame[g.id] = alt;
    } catch {
      failed++;
    }
  }));
  return { byGame, credits, remaining: remaining === Infinity ? null : remaining, failed };
}

export function parseAltLines(event, book) {
  const bm = event.bookmakers?.find((b) => b.key === book);
  if (!bm) return null;
  const outcomes = (key) => bm.markets?.find((m) => m.key === key)?.outcomes ?? [];
  const byPoint = (a, b) => a.point - b.point;
  const pick = (list, test) => list.filter(test).map((o) => ({ point: o.point, price: o.price })).sort(byPoint);
  const spreads = outcomes('alternate_spreads');
  const totals = outcomes('alternate_totals');
  const alt = {
    spread: { home: pick(spreads, (o) => o.name === event.home_team), away: pick(spreads, (o) => o.name === event.away_team) },
    total: { over: pick(totals, (o) => o.name === 'Over'), under: pick(totals, (o) => o.name === 'Under') },
  };
  const count = alt.spread.home.length + alt.spread.away.length + alt.total.over.length + alt.total.under.length;
  return count ? alt : null;
}
