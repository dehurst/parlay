// Hot and cold streaks for the heat map: a starter who's been in the top 10
// at his position in the stat that matters most for it, several of his
// team's games in a row (2 on offense, 3 on defense), is on fire; the
// bottom 10 that many in a row, ice cold.
//   QB      ESPN QBR (ESPN's qualified quarterbacks)
//   RB      rushing yards
//   WR, TE  receiving yards (each against his own position)
//   OL      the line's sack rate (sacks per dropback), a unit, against every team
//   DL      sacks + QB hits
//   LB      tackles
//   DB      passes defended + interceptions
// Skill and defensive players are compared with others at their position
// who played at least half their team's snaps that week, so backups with a
// few plays don't crowd the bottom 10.
import { fullKey, shortKey } from './starters.js';

// Outside linebackers rush the passer (in a 3-4 they're the edge rushers), so
// they're judged with the defensive line on sacks + QB hits; inside
// linebackers on tackles.
export const poolGroup = (p) => (p?.pos === 'OLB' ? 'DL' : p?.group);

// Games in a row it takes: offense swings more week to week, so 2 there.
export const STREAK_GAMES = { QB: 2, RB: 2, WR: 2, TE: 2, OL: 2, DL: 3, LB: 3, DB: 3 };
const TOP = 10;
const PLAYED = 0.5; // share of the team's snaps that puts a player in that week's pool
export const METRICS = {
  QB: { label: 'QBR' },
  RB: { label: 'rush yds', value: (s) => s.rushYds },
  WR: { label: 'rec yds', value: (s) => s.recYds },
  TE: { label: 'rec yds', value: (s) => s.recYds },
  OL: { label: 'sack rate allowed', lowIsGood: true },
  DL: { label: 'sacks + QB hits', value: (s) => s.pressure },
  LB: { label: 'tackles', value: (s) => s.tackles },
  DB: { label: 'passes defended + INTs', value: (s) => s.coverage },
};

// Where one value stands in a week's pool: hot if it and everyone tied with it
// fit in the top 10, cold if in the bottom 10 (a big tie at 0 is neither).
export function standing(values, mine, lowIsGood = false) {
  const better = values.filter((v) => (lowIsGood ? v < mine : v > mine)).length;
  const worse = values.filter((v) => (lowIsGood ? v > mine : v < mine)).length;
  const tied = values.length - better - worse;
  const out = { rank: better + 1, of: values.length };
  if (values.length < TOP * 2) return out;
  return { ...out, hot: better + tied <= TOP, cold: worse + tied <= TOP };
}

// Everything the weekly rankings need, built once per load of the data:
// `teams` is this season's snap counts, `weekly` each game's stat lines,
// `qbr` each qualified QB's weekly QBR.
export function streakBook(teams, weekly, qbr) {
  // Stat lines by full name, and by first initial + last name for names
  // written differently ("Greg" / "Gregory"), when that's one player on the team.
  const lines = new Map(weekly.map((r) => [`${r.week}|${r.team}|${fullKey(r.name)}`, r]));
  const short = new Map();
  for (const r of weekly) {
    const k = `${r.week}|${r.team}|${shortKey(r.name)}`;
    short.set(k, short.has(k) ? null : r);
  }
  const lineFor = (week, team, names) => names.map((n) => lines.get(`${week}|${team}|${fullKey(n)}`) ?? short.get(`${week}|${team}|${shortKey(n)}`)).find(Boolean);
  const pools = new Map(); // `${week}|${group}` -> [{ team, key, value }]
  const pool = (week, group) => {
    const id = `${week}|${group}`;
    if (pools.has(id)) return pools.get(id);
    const m = METRICS[group];
    let list = [];
    if (group === 'QB') {
      list = qbr.filter((q) => q.week === week).map((q) => ({ key: q.espnId, value: q.qbr }));
    } else if (group === 'OL') {
      // The line as a unit: each team's sacks per dropback that week.
      const byTeam = new Map();
      for (const r of weekly) {
        if (r.week !== week || !r.dropbacks) continue;
        const t = byTeam.get(r.team) ?? { dropbacks: 0, sacked: 0 };
        t.dropbacks += r.dropbacks;
        t.sacked += r.sacked;
        byTeam.set(r.team, t);
      }
      list = [...byTeam].map(([team, t]) => ({ key: team, value: t.sacked / t.dropbacks }));
    } else {
      for (const [team, t] of Object.entries(teams)) {
        for (const p of t.players) {
          if (poolGroup(p) !== group || !((p.pct[week] ?? 0) >= PLAYED)) continue;
          // No stat line: a receiver or back with no catches or carries has
          // none, so that's 0 yards. A defensive starter with no stats at all
          // is unusual enough that it's more likely his name didn't match, so
          // he's left out rather than counted as a zero.
          const line = lineFor(week, team, [...p.names]);
          if (line) list.push({ key: `${team}|${fullKey(p.name)}`, value: m.value(line) });
          else if (['RB', 'WR', 'TE'].includes(group)) list.push({ key: `${team}|${fullKey(p.name)}`, value: 0 });
        }
      }
    }
    pools.set(id, list);
    return list;
  };
  return { pool };
}

// A starter's streak: 'hot', 'cold' or null, with each game's rank, over his
// team's last STREAK_GAMES[group] games. `group` is QB/RB/WR/TE/OL/DL/LB/DB, `code`
// his team, `espnId` (QBs) his ESPN id, and `snapsPlayer` his snap record.
export function streakFor(book, teams, { group: slotGroupName, code, name, espnId, snapsPlayer }) {
  // Skill and defensive players are pooled by their position in the snap
  // counts (an OLB listed at a linebacker spot rushes the passer).
  const group = ['QB', 'OL'].includes(slotGroupName) || !snapsPlayer ? slotGroupName : poolGroup(snapsPlayer);
  const m = METRICS[group];
  const team = teams?.[code];
  if (!m || !team) return null;
  // His team's last games that have stats yet (QBR and the weekly stats can
  // run a game behind the snap counts).
  const need = STREAK_GAMES[group];
  const weeks = team.weeks.filter((w) => book.pool(w, group).length).slice(-need);
  if (weeks.length < need) return null;
  const games = [];
  for (const week of weeks) {
    // He has to have played that game (QBs: qualified; the line: the team
    // played; everyone else: half the snaps).
    if (group !== 'QB' && group !== 'OL' && !((snapsPlayer?.pct[week] ?? 0) >= PLAYED)) return null;
    const list = book.pool(week, group);
    const key = group === 'QB' ? espnId : group === 'OL' ? code : `${code}|${fullKey(snapsPlayer.name)}`;
    const me = list.find((x) => x.key === key);
    if (!me) return null;
    games.push({ week, value: me.value, ...standing(list.map((x) => x.value), me.value, m.lowIsGood) });
  }
  const kind = games.every((g) => g.hot) ? 'hot' : games.every((g) => g.cold) ? 'cold' : null;
  if (!kind) return null;
  return {
    kind, metric: m.label,
    games: games.map((g) => ({ week: g.week, rank: g.rank, of: g.of, value: group === 'OL' ? Math.round(g.value * 1000) / 10 : Math.round(g.value * 10) / 10 })),
  };
}
