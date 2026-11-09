// Game-day status alerts: players listed Questionable or Doubtful who matter
// to a live bet (a prop on them, or a heat map starter on either team in a
// game we bet on) get one alert when the inactives come out, about 90
// minutes before kickoff: active or inactive.

import { fullKey } from './starters.js';

export const WATCH = ['Questionable', 'Doubtful'];
// Teams have to name their inactives 90 minutes before kickoff; checked from
// a little after that so ESPN has them.
export const DECIDE_AT = 85 * 60e3;
// Start watching (recording who's Q/D) this long before kickoff.
export const WATCH_FROM = 6 * 3600e3;

// The heat map's players for one team: today's starters plus anyone skipped
// over as hurt (a Doubtful starter is skipped), by name.
export function tileNames(sides) {
  const names = new Set();
  for (const side of [sides?.offense, sides?.defense]) {
    for (const slot of Object.values(side ?? {}).flat()) {
      if (slot.name) names.add(slot.name);
      for (const p of slot.skipped ?? []) names.add(p.name);
    }
  }
  return names;
}

// Who to watch on one team: the Q/D players on ESPN's roster whose names are
// in `names`. Returns { espnId: { name, team, status } }.
export function watchList(roster, names, team) {
  const want = new Set([...names].map(fullKey));
  const out = {};
  for (const a of (roster?.athletes ?? []).flatMap((g) => g.items ?? [g])) {
    const status = a.injuries?.[0]?.status;
    if (WATCH.includes(status) && want.has(fullKey(a.displayName))) out[a.id] = { name: a.displayName, team, status };
  }
  return out;
}

// ESPN's game-day roster for one team: the ESPN ids of players who won't
// play (inactive). Null until ESPN has the list.
export async function fetchInactives(eventId, teamId) {
  const url = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${eventId}/competitions/${eventId}/competitors/${teamId}/roster`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  return parseInactives(await res.json());
}
export function parseInactives(data) {
  const entries = data?.entries ?? [];
  const out = entries.filter((e) => e.didNotPlay).map((e) => String(e.playerId));
  return out.length ? new Set(out) : null;
}

// Each watched player who hasn't been called yet: active or inactive.
// `watch` is { espnId: { name, team, status, done } }, `inactives` is
// { team: Set(espnId) } with only the teams whose list is out.
export function decide(watch, inactives) {
  const out = [];
  for (const [id, p] of Object.entries(watch)) {
    if (p.done || !inactives[p.team]) continue;
    out.push({ id, name: p.name, team: p.team, was: p.status, now: inactives[p.team].has(String(id)) ? 'Inactive' : 'Active' });
  }
  return out;
}
