// How each heat map starter got the job, from this season's snap counts
// (nflverse's free weekly data, from Pro Football Reference): there since the
// first games, filling in for someone hurt, or took the job from someone
// still healthy. The depth chart alone only says who's listed first today.

const SNAPS_URL = (season) => `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${season}.csv`;

// Playing close to half the snaps or more makes someone a regular that week.
// Defensive linemen rotate the most, so their bar is a little lower.
const REGULAR = 0.45;
const REGULAR_DL = 0.4;
const bar = (p) => (p.group === 'DL' ? REGULAR_DL : REGULAR);
// Missing (or barely playing) this many games in a row ends a run as a
// regular; one off game, like leaving early hurt, doesn't.
const GAP = 2;
// Tags that keep a player off the field (same as the heat map).
const SIDELINED = ['Out', 'Doubtful', 'Injured Reserve', 'Suspension'];

// nflverse's team codes, by nickname.
const TEAM_CODES = {
  cardinals: 'ARI', falcons: 'ATL', ravens: 'BAL', bills: 'BUF', panthers: 'CAR', bears: 'CHI', bengals: 'CIN',
  browns: 'CLE', cowboys: 'DAL', broncos: 'DEN', lions: 'DET', packers: 'GB', texans: 'HOU', colts: 'IND',
  jaguars: 'JAX', chiefs: 'KC', raiders: 'LV', chargers: 'LAC', rams: 'LA', dolphins: 'MIA', vikings: 'MIN',
  patriots: 'NE', saints: 'NO', giants: 'NYG', jets: 'NYJ', eagles: 'PHI', steelers: 'PIT', '49ers': 'SF',
  seahawks: 'SEA', buccaneers: 'TB', titans: 'TEN', commanders: 'WAS',
};
export const teamCode = (name) => TEAM_CODES[String(name).split(' ').pop().toLowerCase()] ?? null;

// Positions that compete for the same jobs.
const GROUPS = {
  T: 'OL', G: 'OL', C: 'OL', OL: 'OL', QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE',
  DL: 'DL', DE: 'DL', DT: 'DL', NT: 'DL', LB: 'LB', CB: 'DB', S: 'DB', DB: 'DB',
};

// Names differ between sources ("D.J." / "DJ", "James Cook" / "James Cook III"),
// and some use nicknames ("Greg" / "Gregory"), so match on a cleaned-up full
// name first, then on first initial + last name.
const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;
const nameParts = (name) => String(name).toLowerCase().split(/\s+/).filter((p) => !SUFFIX.test(p)).map((p) => p.replace(/[^a-z]/g, '')).filter(Boolean);
export const fullKey = (name) => nameParts(name).join('');
export const shortKey = (name) => {
  const parts = nameParts(name);
  return parts.length < 2 ? parts.join('') : `${parts[0][0]}${parts.slice(1).join('')}`;
};

// The snap counts CSV -> { teamCode: { weeks: [game weeks, in order], players: [{ name, group, pct: { week: share } }] } }.
export function parseSnaps(csv) {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  const col = Object.fromEntries(header.split(',').map((h, i) => [h, i]));
  const teams = {};
  for (const line of rows) {
    const r = line.split(',');
    if (r[col.game_type] !== 'REG') continue;
    const team = (teams[r[col.team]] ??= { weeks: new Set(), byName: new Map() });
    const week = Number(r[col.week]);
    team.weeks.add(week);
    // By player id: the listed name can change mid-season ("DeAundre" -> "Dee").
    const id = r[col.pfr_player_id] || r[col.player];
    let p = team.byName.get(id);
    if (!p) team.byName.set(id, (p = { name: r[col.player], names: new Set(), group: GROUPS[r[col.position]] ?? null, pct: {} }));
    p.names.add(r[col.player]);
    p.pct[week] = Math.max(Number(r[col.offense_pct]) || 0, Number(r[col.defense_pct]) || 0);
  }
  return Object.fromEntries(Object.entries(teams).map(([code, t]) => [code, { weeks: [...t.weeks].sort((a, b) => a - b), players: [...t.byName.values()] }]));
}

const sameName = (a, b) => fullKey(a) === fullKey(b) || shortKey(a) === shortKey(b);

// A player's snap record on a team, by name.
export function findPlayer(team, name) {
  const full = fullKey(name);
  const exact = team.players.find((p) => [...p.names].some((n) => fullKey(n) === full));
  if (exact) return exact;
  const short = team.players.filter((p) => [...p.names].some((n) => shortKey(n) === shortKey(name)));
  return short.length === 1 ? short[0] : null;
}

const avg = (p, weeks) => (weeks.length ? weeks.reduce((t, w) => t + (p.pct[w] ?? 0), 0) / weeks.length : 0);
const pctOf = (x) => Math.round(x * 100);

// A player's share of snaps in each of the team's games (null: didn't play).
export const timelineOf = (team, p) => team.weeks.map((week) => ({ week, pct: p?.pct[week] == null ? null : pctOf(p.pct[week]) }));

// How the player in one heat map square got there, from every week's snaps:
//   week1  - a regular in every game since Week 1
//   back   - a regular earlier, then out or benched, and starting again
//   fillin - took over for a regular who's hurt (or is listed ahead and sidelined)
//   earned - took over from a regular who's healthy and still on the team
//   new    - took over with nobody obvious losing the job (a trade, a new role)
//   part   - listed as a starter, but playing well under half the snaps
// `since` is the week the current run as a regular started, and `timeline`
// each week's share. `teams` is every team's snaps and `code` this one's;
// `injuries` maps name -> ESPN injury status for the team's roster, `roster`
// lists everyone on it (null if unknown), `starters` names everyone starting
// on this side now, and `taken` collects players already named as replaced
// (each job goes to one replacement). Returns null when we can't tell.
export function starterHistory(teams, code, slot, { injuries = new Map(), roster = null, starters = [], taken = new Set() } = {}) {
  const team = teams?.[code];
  if (!team || !slot.name || !team.weeks.length) return null;
  const me = findPlayer(team, slot.name);
  const weeks = team.weeks;
  const recent = weeks.slice(-3);
  // Listed behind someone sidelined right now: a fill-in, whatever the snaps say.
  const ahead = slot.skipped?.[0];
  if (ahead) return { tag: 'fillin', replaced: ahead.name, replacedStatus: ahead.status, recent: me ? pctOf(avg(me, recent)) : null, timeline: timelineOf(team, me) };
  // Played for someone else this season: traded or signed since.
  const from = () => Object.entries(teams).find(([c, t]) => c !== code && findPlayer(t, slot.name))?.[0] ?? null;
  if (!me) return from() ? { tag: 'new', from: from() } : null;

  const regular = (p, w) => (p.pct[w] ?? 0) >= bar(p);
  // His last 3 games played; the middle one, so one odd game doesn't decide it.
  const played = weeks.filter((w) => me.pct[w] != null).slice(-3);
  const typical = played.map((w) => me.pct[w]).sort((a, b) => a - b)[Math.floor((played.length - 1) / 2)] ?? 0;
  const base = { recent: played.length ? pctOf(avg(me, played)) : null, timeline: timelineOf(team, me) };
  let last = weeks.length - 1;
  while (last >= 0 && !regular(me, weeks[last])) last--;
  const latest = weeks[weeks.length - 1];
  // A regular earlier who missed games lately: coming back, maybe eased in.
  if (last >= 0 && !regular(me, latest) && recent.some((w) => me.pct[w] == null)) return { tag: 'back', missed: weeks.slice(last + 1), ...base };
  // Part-time: well under half the snaps in a typical recent game, and not a
  // regular in the latest one either (that's someone just taking over).
  if (last < 0 || (played.length && typical < bar(me) && !regular(me, latest))) return { tag: 'part', ...base };
  // His latest run of games as a regular. One off game in the middle (say he
  // left early hurt) doesn't end it; GAP in a row does.
  let start = last;
  while (start > 0) {
    if (regular(me, weeks[start - 1])) start--;
    else if (start >= GAP && regular(me, weeks[start - GAP])) start -= GAP;
    else break;
  }
  const since = weeks[start];
  const after = weeks.slice(last + 1); // games since that run, not as a regular
  if (start === 0 && after.length < GAP) return { tag: 'week1', since, ...base };
  // A regular earlier, then out or benched: back in the lineup (or about to be).
  if (start === 0) return { tag: 'back', missed: after, ...base };
  const before = weeks.slice(0, start);
  if (before.some((w) => regular(me, w))) {
    let gapStart = start;
    while (gapStart > 0 && !regular(me, weeks[gapStart - 1])) gapStart--;
    return { tag: 'back', since, missed: weeks.slice(gapStart, start), ...base };
  }
  if (before.every((w) => me.pct[w] == null) && from()) return { tag: 'new', since, from: from(), ...base };

  // A regular for the first time from `since`: whose job was it? Someone at
  // his position who was a regular the game before and isn't now.
  const candidates = team.players.filter((p) => p !== me && p.group && p.group === me.group
    && !regular(p, latest) && avg(p, recent) < REGULAR
    && ![...starters, ...taken].some((n) => sameName(n, p.name)));
  const prev = weeks[start - 1];
  const replaced = candidates.filter((p) => regular(p, prev)).sort((a, b) => b.pct[prev] - a.pct[prev])[0]
    ?? candidates.filter((p) => before.some((w) => regular(p, w))).sort((a, b) => avg(b, before) - avg(a, before))[0];
  if (!replaced) return { tag: 'new', since, ...base };
  taken.add(replaced.name);
  const status = [...injuries].find(([n]) => sameName(n, replaced.name))?.[1] ?? null;
  const out = { since, ...base, replaced: replaced.name, replacedStatus: status, replacedRecent: pctOf(avg(replaced, recent)) };
  if (status && (SIDELINED.includes(status) || status === 'Questionable')) return { tag: 'fillin', ...out };
  const onTeam = !roster || roster.some((n) => sameName(n, replaced.name));
  // Healthy and still on the team: lost the job. Not playing with no tag
  // usually means hurt, so call that a fill-in; gone from the team, neither.
  if (!onTeam) return { tag: 'new', ...out, replacedGone: true };
  return { tag: out.replacedRecent > 0 ? 'earned' : 'fillin', ...out };
}

// This season's snap counts, kept in memory for a few hours (they update once
// a week, a day or two after the games).
let snaps = null;
const SNAPS_TTL = 6 * 3600e3;

export async function seasonSnaps(now = new Date()) {
  if (snaps && now - snaps.at < SNAPS_TTL) return snaps.teams;
  // The season is named for the year it starts (September).
  const season = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  const res = await fetch(SNAPS_URL(season), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`nflverse snap counts returned ${res.status}`);
  snaps = { at: now.getTime(), teams: parseSnaps(await res.text()) };
  return snaps.teams;
}
