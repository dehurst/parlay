// Heat map (beta), NFL only: each team's offense and defense from ESPN's
// depth chart (free), with who would actually line up at each spot once
// injured players are skipped. The colors on the page come from how far down
// the depth chart that player is: starter, backup, or third string.

import { espnSite } from './sport.js';
import { teamKey } from './schedule.js';
import { fetchTeamDepthChart, fetchTeamRoster } from './injuries.js';
import { seasonSnaps, teamCode, starterHistory, nextUp, positionGroup, usualShare, gamesPlayed, lastSeason, outsnapped, findPlayer, fullKey } from './starters.js';
import { seasonFile, injuryHistory, statRanks, honorsFor } from './honors.js';
import { streakBook, streakFor } from './streaks.js';

// The weekly rankings behind the streaks, built once per download of the data.
const books = new WeakMap();
const bookFor = (teams, weekly, qbr) => {
  if (!books.has(weekly) || books.get(weekly).teams !== teams || books.get(weekly).qbr !== qbr) books.set(weekly, { teams, qbr, book: streakBook(teams, weekly, qbr) });
  return books.get(weekly).book;
};

// Tags that keep a player off the field; Questionable players still count.
const SIDELINED = ['Out', 'Doubtful', 'Injured Reserve', 'Suspension'];

// Units that face each other, with each side's slots in the order they line
// up, so receivers sit across from corners and tackles from edge rushers.
// ESPN's slot ids vary with the formation (4-3 vs 3-4), so unknown ones go last.
export const UNITS = [
  { id: 'line', offense: 'Offensive line', defense: 'Defensive line', o: ['lt', 'lg', 'c', 'rg', 'rt'], d: ['rde', 'rdt', 'nt', 'ldt', 'lde', 'de', 'dt'] },
  { id: 'pass', offense: 'Receivers', defense: 'Secondary', o: ['wr1', 'wr2', 'wr3', 'wr4', 'te', 'te2'], d: ['lcb', 'rcb', 'nb', 'ss', 'fs', 'cb', 's'] },
  { id: 'back', offense: 'Backfield', defense: 'Linebackers', o: ['qb', 'rb', 'rb2'], d: ['wlb', 'lilb', 'mlb', 'rilb', 'slb', 'olb', 'ilb', 'lb'] },
];
const DEFENSE = /(de|dt|nt|lb|cb|nb|ss|fs|^s)$/;

// One depth-chart slot: who plays (the first player not sidelined), how deep
// that is (1 = starter), and anyone skipped ahead of them.
export function fillSlot(slot) {
  const athletes = slot.athletes ?? [];
  const skipped = [];
  for (const [i, a] of athletes.entries()) {
    const status = a.injuries?.[0]?.status ?? null;
    if (SIDELINED.includes(status)) {
      skipped.push({ name: a.displayName, status });
      continue;
    }
    return { pos: slot.position?.abbreviation ?? '', name: a.displayName, rank: i + 1, status, skipped, depth: athletes.length };
  }
  return { pos: slot.position?.abbreviation ?? '', name: null, rank: null, status: null, skipped, depth: athletes.length };
}

// A team's depth chart -> { offense: { line: [...], ... }, defense: { ... } }.
export function teamSides(depthChart) {
  const groups = depthChart?.depthchart ?? [];
  const offense = groups.find((g) => g.positions?.qb);
  const defense = groups.find((g) => g !== offense && Object.keys(g.positions ?? {}).some((k) => DEFENSE.test(k)));
  const side = (group, key) => {
    // No fullbacks: the RB2 square (from snap counts) takes that spot.
    const slots = Object.entries(group?.positions ?? {}).filter(([id]) => id !== 'fb');
    const out = {};
    const used = new Set();
    for (const unit of UNITS) {
      const order = unit[key];
      const mine = slots.filter(([id]) => order.includes(id) || unitFor(id) === unit.id);
      mine.sort(([a], [b]) => rankOf(order, a) - rankOf(order, b));
      out[unit.id] = mine.filter(([id]) => !used.has(id)).map(([id, slot]) => {
        used.add(id);
        return { slot: id, ...fillSlot(slot) };
      });
    }
    return out;
  };
  return { offense: side(offense, 'o'), defense: side(defense, 'd') };
}

const rankOf = (order, id) => (order.includes(id) ? order.indexOf(id) : order.length);
// Squares the depth chart doesn't have, filled from this season's snap counts:
// the healthy RB and TE with the most snaps after the starter, and a 4th WR.
const EXTRAS = [
  { slot: 'rb2', unit: 'back', pos: 'RB2', from: ['RB', 'HB'], chart: ['rb'], nth: '2nd RB' },
  { slot: 'wr4', unit: 'pass', pos: 'WR', from: ['WR'], chart: ['wr1', 'wr2', 'wr3'], nth: '4th WR' },
  { slot: 'te2', unit: 'pass', pos: 'TE2', from: ['TE'], chart: ['te'], nth: '2nd TE' },
];

export function addExtras(offense, teams, code, opts) {
  const all = () => Object.values(offense).flat();
  for (const x of EXTRAS) {
    if (!offense[x.unit]) continue;
    const exclude = all().flatMap((s) => [s.name, ...s.skipped.map((p) => p.name)]).filter(Boolean);
    const pick = nextUp(teams, code, x.from, { ...opts, exclude });
    if (!pick) continue;
    // These squares are part of the normal rotation, so the usual guy here is
    // green. Yellow once the room is short: a starter at the position is out
    // (so this player moved up), or someone with more snaps is sidelined.
    const starters = offense[x.unit].filter((s) => x.chart.includes(s.slot));
    const short = pick.skipped.length > 0 || starters.some((s) => s.rank !== 1 || s.history?.tag === 'fillin');
    offense[x.unit].push({
      slot: x.slot, pos: x.pos, name: pick.name, rank: short ? 2 : 1, status: pick.status,
      skipped: pick.skipped, extra: { nth: x.nth, season: pick.season }, history: { timeline: pick.timeline, recent: pick.recent },
    });
    const order = UNITS.find((u) => u.id === x.unit).o;
    offense[x.unit].sort((a, b) => rankOf(order, a.slot) - rankOf(order, b.slot));
  }
}

// The position group a depth-chart slot belongs to.
export function slotGroup(id) {
  if (/^(lt|lg|c|rg|rt)$/.test(id)) return 'OL';
  if (/(de|dt|nt)$/.test(id)) return 'DL';
  if (/lb$/.test(id)) return 'LB';
  if (/(cb|nb|ss|fs|^s)$/.test(id)) return 'DB';
  return { qb: 'QB', rb: 'RB', hb: 'RB', te: 'TE', wr: 'WR' }[id.replace(/\d+$/, '')] ?? null;
}

// Sidelined players under this usual share aren't counted as starters.
const STARTER_SHARE = 0.25;
// A clear starter last season: this share of snaps over this many games.
const PROVEN = { share: 0.6, games: 6 };

// Each position group at full strength: today's starters plus anyone
// sidelined at that position, best first. A starter who wouldn't make that
// lineup is filling in for one who's out, whatever the depth chart says
// (ESPN often lists the hurt starter last, or moves the backup up); two or
// more spots short of it makes him a deep fill-in (red). Best first is by
// usual snap share, except that a hurt player who out-snapped a starter
// earlier this season ranks ahead of him. `sidelined` is [{ name, status,
// group }], `share(name)` a usual snap share (or null), and `ahead(a, b)`
// whether hurt player `a` played ahead of starter `b`.
// `starterShare(name)` scores today's starters (default: `share`), so a clear
// starter last season isn't judged on a few limited games this season, and
// a hurt player has to beat a starter by EDGE to rank ahead of him (a near
// tie isn't enough to call the starter a fill-in).
// A starter who makes that full-strength lineup isn't a fill-in, even if his
// snaps alone said he took over for someone hurt (he missed the opener, was
// eased back in, or was just traded), as long as he plays more than that
// player and `settled(name)` (enough games to go on); the depth chart listing
// him behind someone sidelined still decides.
const EDGE = 0.05;
export function markFillIns(side, sidelined, { share, starterShare = share, ahead = () => false, settled = () => true }) {
  const slots = Object.values(side).flat().filter((s) => s.name && !s.extra);
  const names = new Set(slots.map((s) => s.name));
  const groups = new Map();
  for (const s of slots) {
    const g = slotGroup(s.slot);
    if (g) groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  for (const [group, mine] of groups) {
    const out = sidelined.filter((p) => p.group === group && !names.has(p.name))
      .map((p) => ({ ...p, score: share(p.name) ?? 0 })).filter((p) => p.score >= STARTER_SHARE);
    const starters = mine.map((slot) => ({ slot, name: slot.name, score: (starterShare(slot.name) ?? 0) + EDGE }));
    for (const x of out) {
      for (const y of [...starters].sort((a, b) => b.score - a.score)) {
        if (x.score <= y.score && ahead(x.name, y.name)) x.score = y.score + 1e-6;
      }
    }
    const pool = [...starters, ...out].sort((a, b) => b.score - a.score);
    for (const [i, p] of pool.entries()) {
      if (!p.slot) continue;
      if (i < mine.length) {
        const h = p.slot.history;
        const mineNow = starterShare(p.name) ?? 0;
        if (h?.tag === 'fillin' && !p.slot.skipped?.length && settled(p.name) && (!h.replaced || (share(h.replaced) ?? 0) < mineNow)) {
          const { replaced, replacedStatus, replacedRecent, deep, ahead: _, ...rest } = h;
          p.slot.history = { ...rest, tag: 'week1' };
        }
        continue;
      }
      const above = pool.slice(0, i).filter((q) => !q.slot);
      const deep = i - mine.length + 1;
      const { name, status } = above.at(-1);
      const h = p.slot.history?.tag === 'fillin' ? p.slot.history
        : { tag: 'fillin', replaced: name, replacedStatus: status, recent: p.slot.history?.recent, timeline: p.slot.history?.timeline };
      p.slot.history = { ...h, deep, ahead: above.map((q) => ({ name: q.name, status: q.status })) };
    }
  }
}

// Slots not in the lists above (other formations), by their name.
function unitFor(id) {
  if (/(de|dt|nt)$|^(lt|lg|c|rg|rt)$/.test(id)) return 'line';
  if (/lb$|^(qb|rb|hb)\d*$/.test(id)) return 'back';
  if (/(cb|nb|ss|fs|^s)$|^(wr|te)\d*$/.test(id)) return 'pass';
  return null;
}

// ESPN team ids by our team key, and each team's depth chart, kept in memory
// for half an hour, so trades and injury moves show up soon after ESPN has them.
let teamIds = null;
const charts = new Map();
const CHART_TTL = 30 * 60e3;

async function espnTeamId(name) {
  if (!teamIds) {
    const res = await fetch(espnSite('teams'), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`ESPN teams returned ${res.status}`);
    const data = await res.json();
    teamIds = new Map((data.sports?.[0]?.leagues?.[0]?.teams ?? []).map(({ team }) => [teamKey(team.displayName), team.id]));
  }
  return teamIds.get(teamKey(name)) ?? null;
}

// A player's college from ESPN's roster: its abbreviation and a small logo
// (the regular one, since it's shown on a white circle). Null without both.
export function collegeOf(c) {
  if (!c?.abbrev) return null;
  const logo = c.logos?.find((l) => l.rel?.includes('default')) ?? c.logos?.[0];
  const path = logo?.href?.match(/^https:\/\/a\.espncdn\.com(\/i\/[\w/-]+\.png)$/)?.[1];
  if (!path) return null;
  return { abbrev: c.abbrev, name: c.name ?? c.abbrev, logo: `https://a.espncdn.com/combiner/i?img=${path}&w=40&h=40` };
}

// "Form": a group's yards per game over its team's last FORM_GAMES games
// (only weeks a team played have stat lines, so byes are skipped), ranked
// against every team. QB: passing yards; RB: rushing yards by running
// backs; WR/TE: receiving yards by receivers and tight ends. The number
// shown is the plain average; the ranking (the pill's color) counts the best
// and worst games half, so one blowout or dud doesn't swing it.
const FORM_GAMES = 5;
// Each game's weight: the highest and lowest 0.5 (one of each, even on a
// tie), the rest 1. Under 3 games, a plain average.
export function weightedAvg(yds) {
  if (yds.length < 3) return { avg: yds.reduce((t, y) => t + y, 0) / yds.length, weights: yds.map(() => 1) };
  const order = yds.map((y, i) => i).sort((a, b) => yds[a] - yds[b]);
  const weights = yds.map(() => 1);
  weights[order[0]] = 0.5;
  weights[order.at(-1)] = 0.5;
  return { avg: yds.reduce((t, y, i) => t + y * weights[i], 0) / (yds.length - 1), weights };
}
const FORM = {
  QB: { stat: 'passing yards', value: (r) => r.passYds },
  RB: { stat: 'rushing yards by RBs', value: (r) => (r.group === 'RB' ? r.rushYds : 0) },
  'WR/TE': { stat: 'receiving yards by WRs and TEs', value: (r) => (['WR', 'TE'].includes(r.group) ? r.recYds : 0) },
};
const forms = new WeakMap();
export function formTable(weekly, n = FORM_GAMES) {
  if (forms.has(weekly)) return forms.get(weekly);
  const byTeam = new Map(); // team -> week -> { QB, RB, 'WR/TE' }
  for (const r of weekly) {
    const weeks = byTeam.get(r.team) ?? new Map();
    byTeam.set(r.team, weeks);
    const w = weeks.get(r.week) ?? Object.fromEntries(Object.keys(FORM).map((k) => [k, 0]));
    weeks.set(r.week, w);
    for (const [k, f] of Object.entries(FORM)) w[k] += f.value(r) || 0;
  }
  const table = {};
  for (const k of Object.keys(FORM)) {
    const rows = [...byTeam].map(([team, weeks]) => {
      const games = [...weeks].sort(([a], [b]) => a - b).slice(-n).map(([week, w]) => ({ week, yds: Math.round(w[k]) }));
      return { team, games, avg: games.reduce((t, g) => t + g.yds, 0) / games.length, score: weightedAvg(games.map((g) => g.yds)).avg };
    });
    for (const row of rows) {
      const rank = rows.filter((x) => x.score > row.score).length + 1;
      // Ninths of the league, 1 (best) to 9 (worst).
      const ninth = Math.min(9, Math.ceil((rank / rows.length) * 9));
      (table[row.team] ??= {})[k] = { stat: FORM[k].stat, avg: Math.round(row.avg), games: row.games, rank, of: rows.length, ninth };
    }
  }
  forms.set(weekly, table);
  return table;
}

export async function teamHeatmap(name, now = Date.now()) {
  const id = await espnTeamId(name);
  if (!id) return null;
  const cached = charts.get(id);
  if (cached && now - cached.at < CHART_TTL) return cached.sides;
  // The roster (for injuries, IR included) and snap counts only add the
  // "how they got the job" tags, so the heat map still works without them.
  const [chart, roster, snaps, lastSnaps, stats, injuryReports, weekly, qbr] = await Promise.allSettled([fetchTeamDepthChart(id), fetchTeamRoster(id),
    seasonSnaps(new Date(now)), seasonSnaps(new Date(now), 1), seasonFile('stats', new Date(now)), seasonFile('injuries', new Date(now)),
    seasonFile('weekly', new Date(now)), seasonFile('qbr', new Date(now))]);
  if (chart.status === 'rejected') throw chart.reason;
  const sides = teamSides(chart.value);
  const teams = snaps.status === 'fulfilled' ? snaps.value : null;
  if (snaps.status === 'rejected') console.error(`Snap counts failed: ${snaps.reason?.message ?? snaps.reason}`);
  const athletes = roster.status === 'fulfilled' ? (roster.value.athletes ?? []).flatMap((g) => g.items ?? [g]) : null;
  const injuries = new Map((athletes ?? []).filter((a) => a.injuries?.length).map((a) => [a.displayName, a.injuries[0].status]));
  const names = athletes?.map((a) => a.displayName) ?? null;
  // Rookies: ESPN lists them with 0 years in the league.
  const rookies = new Set((athletes ?? []).filter((a) => a.experience?.years === 0).map((a) => a.displayName));
  const colleges = new Map((athletes ?? []).map((a) => [a.displayName, collegeOf(a.college)]).filter(([, c]) => c));
  const tagPlayer = (slot) => {
    slot.rookie = rookies.has(slot.name);
    slot.college = colleges.get(slot.name) ?? null;
  };
  const code = teamCode(name);
  // Last season tells us about veterans only; rookies have none.
  const last = (n) => (rookies.has(n) || lastSnaps.status !== 'fulfilled' ? null : lastSnaps.value);
  // A clear starter last season, here or anywhere.
  const proven = (n) => {
    const before = lastSeason(last(n), code, n);
    return Boolean(before && before.games >= PROVEN.games && before.share >= PROVEN.share);
  };
  for (const side of Object.values(sides)) {
    const slots = Object.values(side).flat();
    for (const slot of slots) tagPlayer(slot);
    const starters = slots.map((s) => s.name).filter(Boolean);
    const opts = { injuries, roster: names, starters, proven };
    // Each job lost goes to one replacement: whoever took over first.
    const first = new Map(slots.map((s) => [s, starterHistory(teams, teamCode(name), s, opts)?.since ?? Infinity]));
    const taken = new Set();
    for (const slot of [...slots].sort((a, b) => first.get(a) - first.get(b))) {
      slot.history = starterHistory(teams, teamCode(name), slot, { ...opts, taken });
    }
    if (teams && athletes) {
      // Someone out since before Week 1 is missed only if he was a clear
      // starter last season; otherwise the team has built around his absence.
      const sidelined = athletes.filter((a) => SIDELINED.includes(a.injuries?.[0]?.status) && (gamesPlayed(teams, code, a.displayName) > 0 || proven(a.displayName)))
        .map((a) => ({ name: a.displayName, status: a.injuries[0].status, group: positionGroup(a.position?.abbreviation) }));
      const share = (n) => usualShare(teams, last(n), code, n);
      // A clear starter for this team last season who's starting now keeps
      // that standing, however few or light his games this season (hurt,
      // eased back in). Only this team: a starter elsewhere last season may
      // be a backup here (traded players are handled by the trade rule).
      const provenHere = (n) => {
        const lastTeam = last(n)?.[code];
        const p = lastTeam && findPlayer(lastTeam, n);
        const played = p ? lastTeam.weeks.filter((w) => p.pct[w] != null) : [];
        const avg = played.length ? played.reduce((t, w) => t + p.pct[w], 0) / played.length : 0;
        return played.length >= PROVEN.games && avg >= PROVEN.share ? avg : null;
      };
      // Only over a small sample: after a few games, this season's role decides.
      const starterShare = (n) => {
        const before = gamesPlayed(teams, code, n) < 4 ? provenHere(n) : null;
        return before == null ? share(n) : Math.max(share(n) ?? 0, before);
      };
      markFillIns(side, sidelined, {
        share, starterShare,
        // One or two games here can't overrule a fill-in, unless he was a
        // clear starter here last season.
        settled: (n) => gamesPlayed(teams, code, n) >= 3 || provenHere(n) != null,
        ahead: (a, b) => provenHere(b) == null && outsnapped(teams, code, a, b, lastSeason(last(b), code, b)?.share),
      });
    }
  }
  if (teams) {
    addExtras(sides.offense, teams, teamCode(name), { injuries, roster: names });
    for (const slot of Object.values(sides.offense).flat()) tagPlayer(slot);
  }
  // The back of each card: birthday (for his age), injuries that cost games
  // this season, honors, and stat leaders. Each part is extra: a source
  // that's down just leaves it out.
  const byAthlete = new Map((athletes ?? []).map((a) => [a.displayName, a]));
  const statRows = stats.status === 'fulfilled' ? stats.value : null;
  const reports = injuryReports.status === 'fulfilled' ? injuryReports.value : null;
  if (stats.status === 'rejected') console.error(`Season stats failed: ${stats.reason?.message ?? stats.reason}`);
  if (injuryReports.status === 'rejected') console.error(`Injury reports failed: ${injuryReports.reason?.message ?? injuryReports.reason}`);
  // Hot and cold streaks: top or bottom 10 at his position 2 games running
  // (offense) or 3 (defense).
  if (weekly.status === 'rejected') console.error(`Weekly stats failed: ${weekly.reason?.message ?? weekly.reason}`);
  if (qbr.status === 'rejected') console.error(`QBR failed: ${qbr.reason?.message ?? qbr.reason}`);
  const book = teams && weekly.status === 'fulfilled' ? bookFor(teams, weekly.value, qbr.status === 'fulfilled' ? qbr.value : []) : null;
  for (const [sideName, side] of Object.entries(sides)) {
    const s = sideName === 'offense' ? 'O' : 'D';
    for (const slot of Object.values(side).flat()) {
      if (!slot.name) continue;
      const a = byAthlete.get(slot.name);
      // Linemen aren't rated one by one (no free data says which one gave up
      // a sack); the line's streak goes on its header instead.
      slot.streak = book && slotGroup(slot.slot) !== 'OL' ? streakFor(book, teams, {
        group: slotGroup(slot.slot), code, name: slot.name, espnId: a?.id, snapsPlayer: findPlayer(teams[code] ?? { players: [] }, slot.name),
      }) : null;
      // RB2 and TE2 are backups by design, with smaller roles, so they can
      // be on fire but aren't called ice cold.
      if (['rb2', 'te2'].includes(slot.slot) && slot.streak?.kind === 'cold') slot.streak = null;
      const teamsHere = [code, slot.history?.from].filter(Boolean);
      const mine = reports?.get(fullKey(slot.name))?.filter((r) => teamsHere.includes(r.team)) ?? [];
      slot.card = {
        born: a?.dateOfBirth ?? null,
        height: a?.displayHeight ?? null, weight: a?.displayWeight ?? null,
        injuries: reports ? injuryHistory(slot.history?.timeline, mine) : [],
        ranks: statRows ? statRanks(statRows, slot.name, s) : [],
        ...honorsFor(slot.name, s, a?.id),
      };
    }
  }
  // The offensive line's streak, as a unit (its sack rate allowed). Set
  // after the loops over the sides above, which expect only offense/defense.
  sides.lineStreak = book ? streakFor(book, teams, { group: 'OL', code }) : null;
  sides.form = weekly.status === 'fulfilled' ? formTable(weekly.value)[code] ?? null : null;
  // Without snap counts the RB2/WR4/TE2 squares and tags are missing, so
  // don't keep that version: the next load tries again.
  // Same without the roster: no colleges, rookies or injuries.
  if (roster.status === 'rejected') console.error(`Roster failed: ${roster.reason?.message ?? roster.reason}`);
  if (snaps.status === 'fulfilled' && lastSnaps.status === 'fulfilled' && roster.status === 'fulfilled') charts.set(id, { at: now, sides });
  return sides;
}
