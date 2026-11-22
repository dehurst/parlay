import { makeGame, matchKey } from './schedule.js';
import { sport } from './sport.js';

// The Odds API (https://the-odds-api.com). The events list is free; odds cost
// one credit per market per bookmaker group, so h2h+spreads+totals = 3 credits.
const base = () => `https://api.the-odds-api.com/v4/sports/${sport().oddsKey}`;

const isoNoMs = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function get(path, params) {
  const res = await fetch(`${base()}/${path}?${new URLSearchParams(params)}`, {
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
  const params = { apiKey, bookmakers: book, markets: 'h2h,spreads,totals', oddsFormat: 'american', ...timeRange(win) };
  let got;
  try {
    // The book's own links (FanDuel: "add to bet slip") and ids, when it has them.
    got = await get('odds', { ...params, includeLinks: 'true', includeSids: 'true' });
  } catch (err) {
    // Turned down (a bad request, not a key or quota problem): plain lines.
    if (!/returned 4(00|22)/.test(err.message)) throw err;
    got = await get('odds', params);
  }
  return { byMatchup: parseLines(got.data, book), remaining: got.remaining };
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
    // The book's link to add that bet to its bet slip, when it gave one.
    const link = (o) => (typeof o.link === 'string' && /^https:\/\//.test(o.link) ? { link: o.link } : {});
    for (const o of outcomes('h2h')) (lines.ml ??= {})[side(o)] = { point: null, price: o.price, ...link(o) };
    for (const o of outcomes('spreads')) (lines.spread ??= {})[side(o)] = { point: o.point, price: o.price, ...link(o) };
    for (const o of outcomes('totals')) (lines.total ??= {})[o.name.toLowerCase()] = { point: o.point, price: o.price, ...link(o) };
    out[matchKey(ev.away_team, ev.home_team)] = lines;
  }
  return out;
}

// The Odds API's own event IDs for this week's games, by matchup (free call).
export async function fetchEventIds(apiKey, win) {
  const { data } = await get('events', { apiKey, ...timeRange(win) });
  return Object.fromEntries(data.map((ev) => [matchKey(ev.away_team, ev.home_team), ev.id]));
}

// One game's player props from the book. Costs 1 credit per market the book
// has for that game (so up to 2: anytime TD and passing TDs).
export async function fetchEventProps(apiKey, book, eventId, markets) {
  const { data, remaining } = await get(`events/${eventId}/odds`, {
    apiKey,
    bookmakers: book,
    markets: markets.join(','),
    oddsFormat: 'american',
  });
  return { event: data, remaining };
}
