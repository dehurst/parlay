// Players view (Stats/Data tab), NFL only: each player's numbers three ways,
// all from nflverse's free stat files:
//   season - this regular season's totals and per-game averages
//   form   - his last 3 games (bye weeks and games he missed don't count)
//   career - every regular season since 1999 (src/career-data.js, made by
//            scripts/build-career.js) plus this one
import { parseCsv } from './nflstats.js';
import { findPlayer } from './starters.js';

// The stats shown, as [key, label]. Most are nflverse columns, summed; a few
// are worked out from them (see statsOf). `rate` stats are per-game shares,
// averaged rather than summed; `max` keeps the best; `bad` ones are better low.
export const STAT_DEFS = {
  cmp: { label: 'Completions', col: 'completions' },
  att: { label: 'Pass attempts', col: 'attempts' },
  passYds: { label: 'Pass yds', col: 'passing_yards' },
  passTd: { label: 'Pass TD', col: 'passing_tds' },
  int: { label: 'INT thrown', col: 'passing_interceptions', bad: true },
  sacked: { label: 'Sacked', col: 'sacks_suffered', bad: true },
  car: { label: 'Carries', col: 'carries' },
  rushYds: { label: 'Rush yds', col: 'rushing_yards' },
  rushTd: { label: 'Rush TD', col: 'rushing_tds' },
  tgt: { label: 'Targets', col: 'targets' },
  rec: { label: 'Receptions', col: 'receptions' },
  recYds: { label: 'Rec yds', col: 'receiving_yards' },
  recTd: { label: 'Rec TD', col: 'receiving_tds' },
  anyTd: { label: 'Total TD' }, // scored himself: rushing, receiving, returns (what anytime TD pays on)
  tgtShare: { label: 'Target share', col: 'target_share', rate: true },
  airShare: { label: 'Air yds share', col: 'air_yards_share', rate: true },
  tkl: { label: 'Tackles' }, // solo + assisted
  sacks: { label: 'Sacks', col: 'def_sacks' },
  qbHits: { label: 'QB hits', col: 'def_qb_hits' },
  tfl: { label: 'Tackles for loss', col: 'def_tackles_for_loss' },
  defInt: { label: 'INT', col: 'def_interceptions' },
  pd: { label: 'Passes defended', col: 'def_pass_defended' },
  ff: { label: 'Forced fumbles', col: 'def_fumbles_forced' },
  fgm: { label: 'FG made', col: 'fg_made' },
  fga: { label: 'FG tried', col: 'fg_att' },
  fgLong: { label: 'Longest FG', col: 'fg_long', max: true },
  xpm: { label: 'Extra points', col: 'pat_made' },
};
// Stats that only make sense game by game (not in career totals).
export const CAREER_KEYS = Object.keys(STAT_DEFS).filter((k) => !STAT_DEFS[k].rate);

// Which stats each position shows, in order.
const DEFENSE = ['tkl', 'sacks', 'qbHits', 'tfl', 'defInt', 'pd', 'ff'];
export const SHOWN = {
  QB: ['cmp', 'att', 'passYds', 'passTd', 'int', 'sacked', 'car', 'rushYds', 'rushTd', 'anyTd'],
  RB: ['car', 'rushYds', 'rushTd', 'tgt', 'rec', 'recYds', 'recTd', 'anyTd', 'tgtShare'],
  WR: ['tgt', 'rec', 'recYds', 'recTd', 'anyTd', 'tgtShare', 'airShare', 'car', 'rushYds'],
  TE: ['tgt', 'rec', 'recYds', 'recTd', 'anyTd', 'tgtShare', 'airShare'],
  DL: DEFENSE, LB: DEFENSE, DB: DEFENSE,
  SPEC: ['fgm', 'fga', 'fgLong', 'xpm'],
};
// The order positions are listed in.
export const GROUP_ORDER = ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB', 'SPEC'];
const FORM_GAMES = 3;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
// One nflverse row (season or game) -> { key: value } for every stat.
export function statsOf(r) {
  const out = {};
  for (const [k, d] of Object.entries(STAT_DEFS)) out[k] = d.col ? num(r[d.col]) : 0;
  out.tkl = num(r.def_tackles_solo) + num(r.def_tackle_assists);
  out.anyTd = num(r.rushing_tds) + num(r.receiving_tds) + num(r.special_teams_tds) + num(r.def_tds);
  return out;
}

// The weekly stat file -> regular-season game lines:
// [{ id, name, pos, group, team, opp, week, stats }].
export function parseGames(text) {
  return parseCsv(text).filter((r) => r.season_type === 'REG' && r.player_id && SHOWN[r.position_group]).map((r) => ({
    id: r.player_id, name: r.player_display_name, pos: r.position, group: r.position_group,
    team: r.team, opp: r.opponent_team, week: Number(r.week), home: r.game_id?.endsWith(`_${r.team}`) ?? null,
    stats: statsOf(r), fantasy: num(r.fantasy_points_ppr),
  }));
}

// Adds up game lines (or season lines): sums, except shares (averaged over the
// games that have one) and bests (the highest).
export function totalOf(lines, keys = Object.keys(STAT_DEFS)) {
  const out = {};
  for (const k of keys) {
    const d = STAT_DEFS[k];
    const vals = lines.map((l) => l[k] ?? 0);
    if (d.max) out[k] = vals.length ? Math.max(...vals) : 0;
    else if (d.rate) {
      const had = vals.filter((v) => v > 0);
      out[k] = had.length ? had.reduce((a, b) => a + b, 0) / had.length : 0;
    } else out[k] = vals.reduce((a, b) => a + b, 0);
  }
  return out;
}

// A zero stat line, for a game he played without touching the ball (nflverse
// only lists players who record a stat).
const zeroLine = () => Object.fromEntries(Object.keys(STAT_DEFS).map((k) => [k, 0]));

// Every player on team `code` this season, with the three views. `games` is
// parseGames' list (whole league), `career` the past seasons by player id
// ({ seasons: [first, last], n: number of seasons, games, stats }), `snaps`
// seasonSnaps' teams (or null), used to find games he played but didn't
// make the stat sheet. `season` is this season's year.
export function teamPlayers(games, code, { career = {}, snaps = null, season } = {}) {
  // A player belongs to the team he played for most recently.
  const byId = new Map();
  for (const g of games) (byId.get(g.id) ?? byId.set(g.id, []).get(g.id)).push(g);
  // The team's opponent each week, from anyone's stat line.
  const opps = new Map();
  for (const g of games) if (g.team === code && !opps.has(g.week)) opps.set(g.week, { opp: g.opp, home: g.home });
  const teamSnaps = snaps?.[code] ?? null;
  const out = [];
  for (const [id, lines] of byId) {
    lines.sort((a, b) => a.week - b.week);
    const last = lines[lines.length - 1];
    if (last.team !== code) continue;
    // Games he was on the field for but recorded nothing: from the snap counts.
    const log = lines.map((l) => ({ week: l.week, team: l.team, opp: l.opp, home: l.home, stats: l.stats }));
    const snap = teamSnaps && findPlayer(teamSnaps, last.name);
    if (snap) {
      for (const week of teamSnaps.weeks) {
        if (snap.pct[week] == null || log.some((l) => l.week === week) || !opps.has(week)) continue;
        log.push({ week, team: code, ...opps.get(week), stats: zeroLine(), quiet: true });
      }
      log.sort((a, b) => a.week - b.week);
    }
    const seasonTotal = totalOf(log.map((l) => l.stats));
    // Past seasons only, in case the career file already includes this one.
    const past = career[id]?.seasons?.[1] < season ? career[id] : null;
    const careerTotal = totalOf([past?.stats ?? {}, seasonTotal], CAREER_KEYS);
    out.push({
      id, name: last.name, pos: last.pos, group: last.group,
      season: { games: log.length, stats: seasonTotal },
      // Bye weeks have no line, and neither do games he missed, so these are
      // simply his last 3 games played.
      form: log.slice(-FORM_GAMES).reverse(),
      // Every game played this season, newest first, for hit rates.
      log: log.slice().reverse().map((l) => ({ week: l.week, opp: l.opp, home: l.home, stats: l.stats, ...(l.quiet ? { quiet: true } : {}) })),
      career: {
        games: (past?.games ?? 0) + log.length,
        seasons: (past?.n ?? 0) + 1,
        from: past?.seasons?.[0] ?? season,
        stats: careerTotal,
      },
      rank: SHOWN[last.group] === DEFENSE ? seasonTotal.tkl + seasonTotal.sacks * 4 + seasonTotal.defInt * 6 : lines.reduce((t, l) => t + l.fantasy, 0),
    });
  }
  // By position, then by how much he's done this season.
  return out.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || b.rank - a.rank)
    .map(({ rank, ...p }) => p);
}
