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

// Positions that compete for the same jobs (nflverse's and ESPN's names).
const GROUPS = {
  T: 'OL', OT: 'OL', G: 'OL', OG: 'OL', C: 'OL', OL: 'OL', QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE',
  DL: 'DL', DE: 'DL', DT: 'DL', NT: 'DL', LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB', CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB', DB: 'DB',
};
export const positionGroup = (abbr) => GROUPS[abbr] ?? null;

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

// The snap counts CSV -> { teamCode: { weeks: [game weeks, in order], players: [{ name, pos, group, pct: { week: share } }] } }.
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
    if (!p) team.byName.set(id, (p = { name: r[col.player], names: new Set(), pos: r[col.position], group: GROUPS[r[col.position]] ?? null, pct: {} }));
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
//   week1  - a regular starter: every game since Week 1, or since coming
//            back from an earlier absence (`missed` lists it)
//   back   - returning this week: didn't play in the team's last game
//   fillin - took over for a regular who's hurt (or is listed ahead and sidelined)
//   earned - took over from a regular who's healthy and still on the team
//   trade  - played for another team earlier this season
//   new    - took over with nobody obvious losing the job (a new role)
//   part   - listed as a starter, but playing well under half the snaps
// `since` is the week the current run as a regular started, and `timeline`
// each week's share. `teams` is every team's snaps and `code` this one's;
// `injuries` maps name -> ESPN injury status for the team's roster, `roster`
// lists everyone on it (null if unknown), `starters` names everyone starting
// on this side now, `taken` collects players already named as replaced
// (each job goes to one replacement), and `proven(name)` says whether he was
// a clear starter last season. Returns null when we can't tell.
export function starterHistory(teams, code, slot, { injuries = new Map(), roster = null, starters = [], taken = new Set(), proven = () => false } = {}) {
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
  if (!me) return from() ? { tag: 'trade', from: from() } : null;

  const regular = (p, w) => (p.pct[w] ?? 0) >= bar(p);
  // His last 3 games played; the middle one, so one odd game doesn't decide it.
  const played = weeks.filter((w) => me.pct[w] != null).slice(-3);
  const typical = played.map((w) => me.pct[w]).sort((a, b) => a - b)[Math.floor((played.length - 1) / 2)] ?? 0;
  const base = { recent: played.length ? pctOf(avg(me, played)) : null, timeline: timelineOf(team, me) };
  let last = weeks.length - 1;
  while (last >= 0 && !regular(me, weeks[last])) last--;
  const latest = weeks[weeks.length - 1];
  // Sat out the team's last game but starting now: returning this week,
  // however long he was out.
  if (me.pct[latest] == null) {
    let out = weeks.length - 1;
    while (out > 0 && me.pct[weeks[out - 1]] == null) out--;
    return { tag: 'back', missed: weeks.slice(out), ...base };
  }
  // Traded in this season: a trade, whatever his snaps here so far (he's
  // often eased in), with his old team's games filled into the chart.
  const traded = tradedFrom(teams, code, slot.name);
  if (traded) {
    const old = traded.player.pct;
    const timeline = base.timeline.map((t) => (t.pct == null && old[t.week] != null ? { ...t, pct: pctOf(old[t.week]) } : t));
    return { tag: 'trade', since: weeks.find((w) => me.pct[w] != null), from: traded.code, ...base, timeline };
  }
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
  // A regular earlier, but on light snaps the last couple of games.
  if (start === 0) return { tag: 'part', ...base };
  const before = weeks.slice(0, start);
  // A regular earlier, then out or benched, and starting again for a while now.
  if (before.some((w) => regular(me, w))) {
    let gapStart = start;
    while (gapStart > 0 && !regular(me, weeks[gapStart - 1])) gapStart--;
    return { tag: 'week1', since, missed: weeks.slice(gapStart, start), ...base };
  }
  if (before.every((w) => me.pct[w] == null) && from()) return { tag: 'trade', since, from: from(), ...base };
  // Missed only the opening game or two, then started: a starter who was hurt.
  if (start < GAP && before.every((w) => me.pct[w] == null)) return { tag: 'week1', since, missed: before, ...base };
  // A clear starter last season who left the opener early or sat a game or
  // two, then took the job back: the starter, hurt early, not a fill-in.
  if (start <= GAP && proven(slot.name)) return { tag: 'week1', since, missed: before, ...base };

  // A regular for the first time from `since`: whose job was it? Someone at
  // his position who was a regular the game before and isn't now.
  // Started alongside him for more than a game of this run: not his job.
  const run = weeks.slice(start, last + 1);
  const candidates = team.players.filter((p) => p !== me && p.group && p.group === me.group
    && !regular(p, latest) && avg(p, recent) < REGULAR
    && run.filter((w) => regular(p, w)).length <= 1
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

// The healthy player at a position who has played the most snaps this season
// (missed games count as 0), leaving out `exclude` (names already on the
// heat map). For the RB2, TE2 and WR4 squares. Sidelined players ahead of him
// come back as `skipped`; anyone no longer on the roster is left out.
export function nextUp(teams, code, positions, { exclude = [], injuries = new Map(), roster = null } = {}) {
  const team = teams?.[code];
  if (!team?.weeks.length) return null;
  const known = (p, names) => names.some((n) => [...p.names].some((m) => sameName(n, m)));
  const ranked = team.players.filter((p) => positions.includes(p.pos) && !known(p, exclude))
    .map((p) => ({ p, share: avg(p, team.weeks) })).sort((a, b) => b.share - a.share);
  const skipped = [];
  for (const { p, share } of ranked) {
    const listed = roster?.find((n) => known(p, [n]));
    if (roster && !listed) continue;
    const name = listed ?? p.name;
    const status = [...injuries].find(([n]) => sameName(n, name))?.[1] ?? null;
    if (SIDELINED.includes(status)) {
      skipped.push({ name, status });
      continue;
    }
    const played = team.weeks.filter((w) => p.pct[w] != null).slice(-3);
    return { name, status, skipped, season: pctOf(share), recent: played.length ? pctOf(avg(p, played)) : null, timeline: timelineOf(team, p) };
  }
  return null;
}

// How many of the team's games this season a player has been on the field for.
export function gamesPlayed(teams, code, name) {
  const team = teams?.[code];
  const me = team && findPlayer(team, name);
  return me ? team.weeks.filter((w) => me.pct[w] != null).length : 0;
}

// A player traded (or signed) in this season: the team he played for before
// his first game for team `code`, as { code, team, player }. Only the exact
// name, the same position group, and every game there before his first one
// here, so a namesake isn't mistaken for him. Null if he's been here all along.
export function tradedFrom(teams, code, name) {
  const team = teams?.[code];
  const me = team && findPlayer(team, name);
  if (!me) return null;
  const first = team.weeks.find((w) => me.pct[w] != null);
  if (first == null || first === team.weeks[0]) return null;
  for (const [c, t] of Object.entries(teams)) {
    if (c === code) continue;
    const p = t.players.find((q) => [...q.names].some((n) => fullKey(n) === fullKey(name)));
    if (!p || p.group !== me.group) continue;
    const there = t.weeks.filter((w) => p.pct[w] != null);
    if (there.length && there.every((w) => w < first)) return { code: c, team: t, player: p };
  }
  return null;
}

// A player's snap record in a season's `teams`: on team `code`, or else
// (traded, or signed since) the one other team with that exact name, or the
// one with a close match ("D.J." / "DJ"). [team, player], or [] if unclear.
function findAnywhere(teams, code, name) {
  const own = teams?.[code] && findPlayer(teams[code], name);
  if (own) return [teams[code], own];
  const found = Object.values(teams ?? {}).map((t) => [t, findPlayer(t, name)]).filter(([, p]) => p);
  const exact = found.filter(([, p]) => [...p.names].some((n) => fullKey(n) === fullKey(name)));
  if (exact.length === 1) return exact[0];
  return found.length === 1 ? found[0] : [];
}

// Last season for a player: { share (when he played), games }, on this team
// or wherever he played. Null if he didn't play (rookies: pass no
// `lastTeams`, so a namesake isn't mistaken for them).
export function lastSeason(lastTeams, code, name) {
  const [t, p] = findAnywhere(lastTeams, code, name);
  const played = p ? t.weeks.filter((w) => p.pct[w] != null) : [];
  return played.length ? { share: avg(p, played), games: played.length } : null;
}

// A player's usual share of snaps when he plays: this season's games, or
// last season's if he's played fewer than 2 this season, like someone hurt
// early. Null if he hasn't played in either.
export function usualShare(teams, lastTeams, code, name) {
  // This season's games for his team now, or for his old one if he was
  // traded and hasn't played for the new one yet.
  const [team, me] = findAnywhere(teams, code, name);
  const played = me ? team.weeks.filter((w) => me.pct[w] != null) : [];
  const now = played.length ? avg(me, played) : null;
  // Traded in: his role on the old team counts too, since he's often eased
  // in for a game or two while learning the new offense.
  const traded = tradedFrom(teams, code, name);
  if (traded) {
    const there = traded.team.weeks.filter((w) => traded.player.pct[w] != null);
    return Math.max(now ?? 0, avg(traded.player, there));
  }
  if (played.length >= 2) return now;
  const before = lastSeason(lastTeams, code, name)?.share ?? null;
  return now == null && before == null ? null : Math.max(now ?? 0, before ?? 0);
}

// Whether `a` played ahead of `b` this season: in the games `a` played, `b`
// was a backup (under REGULAR) and `a` averaged clearly more snaps. Games
// `b` sat before his first one count as 0 for him only if he wasn't a
// regular last season (`bLast`, his share then) and came in as a backup, so
// he wasn't playing yet; otherwise he was likely hurt, like games he missed
// later, which are left out.
export function outsnapped(teams, code, a, b, bLast = 0) {
  const team = teams?.[code];
  // Traded in: his first games here, while learning the offense, don't count.
  if (tradedFrom(teams, code, b)) return false;
  // Traded in and hasn't played here yet: nothing here to compare.
  if (team && !findPlayer(team, b) && findAnywhere(teams, code, b).length) return false;
  const pa = team && findPlayer(team, a);
  if (!pa) return false;
  const pb = findPlayer(team, b);
  const first = pb && team.weeks.find((w) => pb.pct[w] != null);
  const newcomer = bLast < REGULAR && (first == null || pb.pct[first] < REGULAR);
  const debut = !newcomer ? -Infinity : first ?? Infinity;
  const weeks = team.weeks.filter((w) => pa.pct[w] != null && (pb?.pct[w] != null || w < debut));
  if (!weeks.length) return false;
  const mine = avg(pa, weeks);
  const his = pb ? avg(pb, weeks) : 0;
  return mine >= 0.25 && his < REGULAR && mine - his >= 0.1;
}

// Snap counts by season, kept in memory for a few hours (they update once a
// week, a day or two after the games). `back` = 1 for last season.
const snaps = new Map();
const SNAPS_TTL = 6 * 3600e3;
// Downloads in progress, so both teams of a game share one (the file is big).
const loading = new Map();

export async function seasonSnaps(now = new Date(), back = 0) {
  // The season is named for the year it starts (September).
  const season = (now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1) - back;
  const cached = snaps.get(season);
  if (cached && now - cached.at < SNAPS_TTL) return cached.teams;
  if (!loading.has(season)) {
    loading.set(season, (async () => {
      const res = await fetch(SNAPS_URL(season), { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`nflverse snap counts returned ${res.status}`);
      const teams = parseSnaps(await res.text());
      snaps.set(season, { at: now.getTime(), teams });
      return teams;
    })().finally(() => loading.delete(season)));
  }
  return loading.get(season);
}
