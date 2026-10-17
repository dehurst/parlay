// Games come from The Odds API (when there's a key) or ESPN's public
// scoreboard, so IDs are built from the week and teams rather than either
// source's own IDs. That way picks survive switching between sources.
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const DAY = 24 * 60 * 60 * 1000;

export const nickname = (name) => name.trim().split(/\s+/).pop();
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

// Matches the same game across sources ("Denver Broncos" vs "Broncos").
export const matchKey = (away, home) => `${slug(nickname(away))}@${slug(nickname(home))}`;

export function makeGame({ weekKey, home, away, commence, state = 'pre', homeShort, awayShort }) {
  return {
    id: `${weekKey}-${slug(nickname(away))}-at-${slug(nickname(home))}`,
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
    const res = await fetch(`${ESPN}?dates=${day}`, { signal: AbortSignal.timeout(8000) });
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

export function parseScoreboard(data, weekKey) {
  return (data.events ?? [])
    .map((ev) => {
      const comp = ev.competitions?.[0];
      const team = (side) => comp?.competitors?.find((c) => c.homeAway === side)?.team;
      const home = team('home');
      const away = team('away');
      if (!home || !away) return null;
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
export function demoSchedule({ key, start }) {
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
  // Offsets from Tuesday 12:00 UTC to typical ET kickoffs (EDT, UTC-4).
  const at = (day, h, m) => ((day * 24 + h) * 60 + m) * 60 * 1000;
  const slot = { thu: at(2, 12, 15), sun1: at(5, 5, 0), sun4: at(5, 8, 25), snf: at(5, 12, 20), mnf: at(6, 12, 15) };
  return matchups.map(([home, away, s]) =>
    makeGame({ weekKey: `demo-${key}`, home, away, commence: start.getTime() + slot[s] }));
}

export const hasStarted = (game, now = new Date()) =>
  game.state !== 'pre' || new Date(game.commence) <= now;
