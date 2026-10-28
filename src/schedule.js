// Games come from The Odds API (when there's a key) or ESPN's public
// scoreboard, so IDs are built from the week and teams rather than either
// source's own IDs. That way picks survive switching between sources.
import { sport, inSlate, espnSite } from './sport.js';

const scoreboard = (day) => `${espnSite('scoreboard')}?dates=${day}${sport().espnQuery}`;
const DAY = 24 * 60 * 60 * 1000;

export const nickname = (name) => name.trim().split(/\s+/).pop();
// Accents dropped first, so "San José State" and "San Jose State" match.
const slug = (s) => s.normalize('NFD').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Identifies a team across sources: the NFL by nickname ("Denver Broncos" ->
// "broncos"), college by full name ("LSU Tigers" -> "lsutigers").
export const teamKey = (name) => slug(sport().fullNames ? name : nickname(name));

// Matches the same game across sources ("Denver Broncos" vs "Broncos").
export const matchKey = (away, home) => `${teamKey(away)}@${teamKey(home)}`;

export function makeGame({ weekKey, home, away, commence, state = 'pre', homeShort, awayShort }) {
  return {
    id: `${weekKey}-${teamKey(away)}-at-${teamKey(home)}`,
    commence: new Date(commence).toISOString(),
    home,
    away,
    homeShort: homeShort ?? nickname(home),
    awayShort: awayShort ?? nickname(away),
    // 'pre' until kickoff, then 'in' / 'post' (only ESPN reports this).
    state,
  };
}

const ymd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');

// ESPN rejected date ranges (400), so ask for each day of the week separately.
// A single YYYYMMDD date is the form its scoreboard reliably accepts.
export async function fetchEspnSchedule({ key, start }) {
  const days = Array.from({ length: 7 }, (_, i) => ymd(new Date(start.getTime() + i * DAY)));
  const boards = await Promise.all(days.map(async (day) => {
    const res = await fetch(scoreboard(day), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
    return res.json();
  }));
  const games = new Map();
  for (const board of boards) {
    for (const g of parseScoreboard(board, key)) {
      // Only keep games inside this Tuesday-to-Tuesday week.
      if (new Date(g.commence) >= start) games.set(g.id, g);
    }
  }
  return [...games.values()].sort((a, b) => a.commence.localeCompare(b.commence));
}

// Season records from ESPN's scoreboard, like { broncos: '3-2' }. ESPN lists
// several (home, road, ...); the overall one is the season record.
export function parseEspnRecords(data) {
  const out = {};
  for (const ev of data.events ?? []) {
    for (const c of ev.competitions?.[0]?.competitors ?? []) {
      const rec = c.records?.find((r) => r.type === 'total' || r.name === 'overall') ?? c.records?.[0];
      if (c.team?.displayName && rec?.summary) out[teamKey(c.team.displayName)] = rec.summary;
    }
  }
  return out;
}

// Records for the teams playing on the given games' days (free), plus each
// team's ESPN details (see parseEspnTeams).
export async function fetchEspnRecords(games) {
  const day = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso)).replaceAll('-', '');
  const days = [...new Set(games.map((g) => day(g.commence)))];
  const boards = await Promise.all(days.map(async (d) => {
    const res = await fetch(scoreboard(d), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
    return res.json();
  }));
  return {
    records: Object.assign({}, ...boards.map(parseEspnRecords)),
    teams: Object.assign({}, ...boards.map(parseEspnTeams)),
  };
}

// Name, school, abbreviation, logo, and conference for every team on ESPN's
// scoreboard, by full name. The page uses these for college logos and short
// names; the NFL's come from its own nickname table.
export function parseEspnTeams(data) {
  const out = {};
  for (const ev of data.events ?? []) {
    for (const c of ev.competitions?.[0]?.competitors ?? []) {
      const t = c.team;
      if (!t?.displayName) continue;
      out[t.displayName] = {
        short: t.shortDisplayName ?? t.location ?? t.displayName,
        abbr: t.abbreviation ?? null,
        logo: t.logo ?? (t.id ? `https://a.espncdn.com/i/teamlogos/ncaa/500/${t.id}.png` : null),
        conf: t.conferenceId ?? null,
      };
    }
  }
  return out;
}

export function parseScoreboard(data, weekKey) {
  return (data.events ?? [])
    .map((ev) => {
      const comp = ev.competitions?.[0];
      const team = (side) => comp?.competitors?.find((c) => c.homeAway === side)?.team;
      const home = team('home');
      const away = team('away');
      if (!home || !away) return null;
      // College: only games with a Power 5 team.
      if (!inSlate(home.conferenceId) && !inSlate(away.conferenceId)) return null;
      return makeGame({
        weekKey,
        commence: ev.date,
        home: home.displayName,
        away: away.displayName,
        homeShort: home.shortDisplayName,
        awayShort: away.shortDisplayName,
        state: comp.status?.type?.state ?? ev.status?.type?.state ?? 'pre',
      });
    })
    .filter(Boolean)
    .sort((a, b) => a.commence.localeCompare(b.commence));
}

// Made-up slate for when no source can be reached, spread across the given week.
export function demoSchedule({ key }, league = 'nfl') {
  if (league === 'cfb') return demoCollegeSchedule(key);
  const matchups = [
    ['Buffalo Bills', 'Miami Dolphins', 'thu'],
    ['Kansas City Chiefs', 'Denver Broncos', 'sun1'],
    ['Philadelphia Eagles', 'Dallas Cowboys', 'sun1'],
    ['Baltimore Ravens', 'Cincinnati Bengals', 'sun1'],
    ['Detroit Lions', 'Green Bay Packers', 'sun1'],
    ['Houston Texans', 'Jacksonville Jaguars', 'sun1'],
    ['Tampa Bay Buccaneers', 'New Orleans Saints', 'sun1'],
    ['Pittsburgh Steelers', 'Cleveland Browns', 'sun1'],
    ['San Francisco 49ers', 'Los Angeles Rams', 'sun4'],
    ['Seattle Seahawks', 'Arizona Cardinals', 'sun4'],
    ['Los Angeles Chargers', 'Las Vegas Raiders', 'sun4'],
    ['Minnesota Vikings', 'Chicago Bears', 'snf'],
    ['New York Jets', 'New England Patriots', 'mnf'],
  ];
  // Offsets from the week's Tuesday at 12:00 UTC to typical ET kickoffs (EDT, UTC-4).
  const base = new Date(`${key}T12:00:00Z`).getTime();
  const at = (day, h, m) => ((day * 24 + h) * 60 + m) * 60 * 1000;
  const slot = { thu: at(2, 12, 15), sun1: at(5, 5, 0), sun4: at(5, 8, 25), snf: at(5, 12, 20), mnf: at(6, 12, 15) };
  return matchups.map(([home, away, s]) =>
    makeGame({ weekKey: `demo-${key}`, home, away, commence: base + slot[s] }));
}

function demoCollegeSchedule(key) {
  const matchups = [
    ['Georgia Bulldogs', 'Florida Gators', 'noon'],
    ['Ohio State Buckeyes', 'Penn State Nittany Lions', 'noon'],
    ['Texas Longhorns', 'Oklahoma Sooners', 'aft'],
    ['Clemson Tigers', 'Florida State Seminoles', 'aft'],
    ['Utah Utes', 'BYU Cougars', 'aft'],
    ['Oregon Ducks', 'Washington Huskies', 'night'],
    ['Alabama Crimson Tide', 'LSU Tigers', 'night'],
  ];
  // Saturday kickoffs (ET, EDT) from the week's Tuesday at 12:00 UTC.
  const base = new Date(`${key}T12:00:00Z`).getTime();
  const at = (day, h, m) => ((day * 24 + h) * 60 + m) * 60 * 1000;
  const slot = { noon: at(4, 4, 0), aft: at(4, 7, 30), night: at(4, 11, 30) };
  return matchups.map(([home, away, s]) => {
    const school = (name) => name.split(' ').slice(0, -1).join(' ');
    return makeGame({ weekKey: `demo-${key}`, home, away, commence: base + slot[s], homeShort: school(home), awayShort: school(away) });
  });
}

export const hasStarted = (game, now = new Date()) =>
  game.state !== 'pre' || new Date(game.commence) <= now;
