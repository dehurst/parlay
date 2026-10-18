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
  return { data: await res.json(), remaining: res.headers.get('x-requests-remaining') };
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
