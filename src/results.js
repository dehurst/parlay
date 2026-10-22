import { makeGame } from './schedule.js';
import { parseBoxScore } from './props.js';

// Final scores, keyed by our game IDs: { gameId: { homeScore, awayScore } }.
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ESPN_SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';
const ODDS_SCORES = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/scores';

// ESPN's scoreboard dates are US Eastern days.
export const easternDay = (iso) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso)).replaceAll('-', '');

export function parseEspnScores(board, weekKey) {
  const out = {};
  for (const ev of board.events ?? []) {
    const comp = ev.competitions?.[0];
    const status = comp?.status?.type ?? ev.status?.type;
    if (!status?.completed) continue;
    const side = (s) => comp.competitors?.find((c) => c.homeAway === s);
    const home = side('home');
    const away = side('away');
    if (!home || !away) continue;
    const id = makeGame({ weekKey, home: home.team.displayName, away: away.team.displayName, commence: ev.date }).id;
    // ESPN's own game ID, for looking up the box score (player props).
    out[id] = { homeScore: Number(home.score), awayScore: Number(away.score), espnId: ev.id ?? null };
  }
  return out;
}

// Touchdowns per player for one finished game (free). Null if ESPN's box
// score isn't filled in yet, so it's tried again later instead of grading
// every prop as a void.
export async function fetchEspnPlayerStats(espnId) {
  const res = await fetch(`${ESPN_SUMMARY}?event=${encodeURIComponent(espnId)}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ESPN box score returned ${res.status}`);
  const players = parseBoxScore(await res.json());
  return Object.keys(players).length >= 10 ? players : null;
}

// Fetch final scores for the given games (only the days they were played).
export async function fetchEspnScores(weekKey, games) {
  const days = [...new Set(games.map((g) => easternDay(g.commence)))];
  const boards = await Promise.all(days.map(async (day) => {
    const res = await fetch(`${ESPN}?dates=${day}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`ESPN scores returned ${res.status}`);
    return res.json();
  }));
  return Object.assign({}, ...boards.map((b) => parseEspnScores(b, weekKey)));
}

// Backup source. Costs 2 API credits and only reaches back 3 days.
export async function fetchOddsApiScores(apiKey, weekKey) {
  const res = await fetch(`${ODDS_SCORES}?${new URLSearchParams({ apiKey, daysFrom: '3' })}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`The Odds API scores returned ${res.status}`);
  const out = {};
  for (const ev of await res.json()) {
    if (!ev.completed || !ev.scores) continue;
    const score = (team) => Number(ev.scores.find((s) => s.name === team)?.score);
    const id = makeGame({ weekKey, home: ev.home_team, away: ev.away_team, commence: ev.commence_time }).id;
    out[id] = { homeScore: score(ev.home_team), awayScore: score(ev.away_team) };
  }
  return out;
}
