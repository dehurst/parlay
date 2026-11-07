import { makeGame } from './schedule.js';
import { parseBoxScore } from './props.js';
import { sport, espnSite } from './sport.js';

// Final scores, keyed by our game IDs: { gameId: { homeScore, awayScore } }.
const oddsScores = () => `https://api.the-odds-api.com/v4/sports/${sport().oddsKey}/scores`;

// ESPN's scoreboard dates are US Eastern days.
export const easternDay = (iso) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso)).replaceAll('-', '');

// Every game on an ESPN scoreboard, keyed by our game IDs: { state ('pre',
// 'in' or 'post'), completed, homeScore, awayScore, detail ("4:12 - 3rd",
// "Halftime", "Final/OT"), espnId }.
export function parseEspnBoard(board, weekKey) {
  const out = {};
  for (const ev of board.events ?? []) {
    const comp = ev.competitions?.[0];
    const status = comp?.status?.type ?? ev.status?.type;
    const side = (s) => comp?.competitors?.find((c) => c.homeAway === s);
    const home = side('home');
    const away = side('away');
    if (!home || !away) continue;
    const id = makeGame({ weekKey, home: home.team.displayName, away: away.team.displayName, commence: ev.date }).id;
    out[id] = {
      state: status?.completed ? 'post' : status?.state ?? 'pre',
      completed: !!status?.completed,
      homeScore: Number(home.score ?? 0),
      awayScore: Number(away.score ?? 0),
      detail: status?.shortDetail ?? status?.detail ?? '',
      // ESPN's own game ID, for looking up the box score (player props).
      espnId: ev.id ?? null,
    };
  }
  return out;
}

// Final scores only: { gameId: { homeScore, awayScore, espnId } }.
export function parseEspnScores(board, weekKey) {
  return Object.fromEntries(Object.entries(parseEspnBoard(board, weekKey))
    .filter(([, g]) => g.completed)
    .map(([id, g]) => [id, { homeScore: g.homeScore, awayScore: g.awayScore, espnId: g.espnId }]));
}

// Touchdowns per player for one finished game (free). Null if ESPN's box
// score isn't filled in yet, so it's tried again later instead of grading
// every prop as a void.
export async function fetchEspnPlayerStats(espnId) {
  const res = await fetch(`${espnSite('summary')}?event=${encodeURIComponent(espnId)}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ESPN box score returned ${res.status}`);
  const players = parseBoxScore(await res.json());
  return Object.keys(players).length >= 10 ? players : null;
}

// Fetch final scores for the given games (only the days they were played).
export async function fetchEspnScores(weekKey, games) {
  return Object.assign({}, ...(await fetchBoards(games)).map((b) => parseEspnScores(b, weekKey)));
}

// Live and final scores for the given games (free).
export async function fetchEspnLive(weekKey, games) {
  return Object.assign({}, ...(await fetchBoards(games)).map((b) => parseEspnBoard(b, weekKey)));
}

async function fetchBoards(games) {
  const days = [...new Set(games.map((g) => easternDay(g.commence)))];
  return Promise.all(days.map(async (day) => {
    const res = await fetch(`${espnSite('scoreboard')}?dates=${day}${sport().espnQuery}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`ESPN scores returned ${res.status}`);
    return res.json();
  }));
}

// Backup source. Costs 2 API credits and only reaches back 3 days.
export async function fetchOddsApiScores(apiKey, weekKey) {
  const res = await fetch(`${oddsScores()}?${new URLSearchParams({ apiKey, daysFrom: '3' })}`, {
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
