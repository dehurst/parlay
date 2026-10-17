// NFL schedule from ESPN's public scoreboard feed (no API key needed).
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const DAY = 24 * 60 * 60 * 1000;

const ymd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');

export async function fetchSchedule({ start, end }) {
  const dates = `${ymd(start)}-${ymd(new Date(end.getTime() - DAY))}`;
  const res = await fetch(`${ESPN}?dates=${dates}&limit=100`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return parseScoreboard(await res.json());
}

export function parseScoreboard(data) {
  return (data.events ?? [])
    .map((ev) => {
      const comp = ev.competitions?.[0];
      const team = (side) => comp?.competitors?.find((c) => c.homeAway === side)?.team;
      const home = team('home');
      const away = team('away');
      if (!home || !away) return null;
      return {
        id: `espn-${ev.id}`,
        commence: new Date(ev.date).toISOString(),
        home: home.displayName,
        away: away.displayName,
        homeShort: home.shortDisplayName ?? home.displayName,
        awayShort: away.shortDisplayName ?? away.displayName,
        // 'pre' until kickoff, then 'in' / 'post'.
        state: comp.status?.type?.state ?? ev.status?.type?.state ?? 'pre',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.commence.localeCompare(b.commence));
}

// Made-up slate for when ESPN can't be reached, spread across the given week.
export function demoSchedule(start) {
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
  const nick = (name) => name.split(' ').pop();
  return matchups.map(([home, away, s], i) => ({
    id: `demo-${start.toISOString().slice(0, 10)}-${i}`,
    commence: new Date(start.getTime() + slot[s]).toISOString(),
    home,
    away,
    homeShort: nick(home),
    awayShort: nick(away),
    state: 'pre',
  }));
}

export const hasStarted = (game, now = new Date()) =>
  game.state !== 'pre' || new Date(game.commence) <= now;
