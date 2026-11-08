// Heat map (beta), NFL only: each team's offense and defense from ESPN's
// depth chart (free), with who would actually line up at each spot once
// injured players are skipped. The colors on the page come from how far down
// the depth chart that player is: starter, backup, or third string.

import { espnSite } from './sport.js';
import { teamKey } from './schedule.js';
import { fetchTeamDepthChart, fetchTeamRoster } from './injuries.js';
import { seasonSnaps, teamCode, starterHistory, nextUp, positionGroup, usualShare, gamesPlayed, lastSeason, outsnapped } from './starters.js';

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
export function markFillIns(side, sidelined, { share, ahead = () => false }) {
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
    const starters = mine.map((slot) => ({ slot, name: slot.name, score: share(slot.name) ?? 0 }));
    for (const x of out) {
      for (const y of [...starters].sort((a, b) => b.score - a.score)) {
        if (x.score <= y.score && ahead(x.name, y.name)) x.score = y.score + 1e-6;
      }
    }
    const pool = [...starters, ...out].sort((a, b) => b.score - a.score);
    for (const [i, p] of pool.entries()) {
      if (!p.slot || i < mine.length) continue;
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

export async function teamHeatmap(name, now = Date.now()) {
  const id = await espnTeamId(name);
  if (!id) return null;
  const cached = charts.get(id);
  if (cached && now - cached.at < CHART_TTL) return cached.sides;
  // The roster (for injuries, IR included) and snap counts only add the
  // "how they got the job" tags, so the heat map still works without them.
  const [chart, roster, snaps, lastSnaps] = await Promise.allSettled([fetchTeamDepthChart(id), fetchTeamRoster(id), seasonSnaps(new Date(now)), seasonSnaps(new Date(now), 1)]);
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
      markFillIns(side, sidelined, { share: (n) => usualShare(teams, last(n), code, n), ahead: (a, b) => outsnapped(teams, code, a, b, lastSeason(last(b), code, b)?.share) });
    }
  }
  if (teams) {
    addExtras(sides.offense, teams, teamCode(name), { injuries, roster: names });
    for (const slot of Object.values(sides.offense).flat()) tagPlayer(slot);
  }
  // Without snap counts the RB2/WR4/TE2 squares and tags are missing, so
  // don't keep that version: the next load tries again.
  // Same without the roster: no colleges, rookies or injuries.
  if (roster.status === 'rejected') console.error(`Roster failed: ${roster.reason?.message ?? roster.reason}`);
  if (snaps.status === 'fulfilled' && lastSnaps.status === 'fulfilled' && roster.status === 'fulfilled') charts.set(id, { at: now, sides });
  return sides;
}
