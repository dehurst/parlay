// Heat map (beta), NFL only: each team's offense and defense from ESPN's
// depth chart (free), with who would actually line up at each spot once
// injured players are skipped. The colors on the page come from how far down
// the depth chart that player is: starter, backup, or third string.

import { espnSite } from './sport.js';
import { teamKey } from './schedule.js';
import { fetchTeamDepthChart, fetchTeamRoster } from './injuries.js';
import { seasonSnaps, teamCode, starterHistory } from './starters.js';

// Tags that keep a player off the field; Questionable players still count.
const SIDELINED = ['Out', 'Doubtful', 'Injured Reserve', 'Suspension'];

// Units that face each other, with each side's slots in the order they line
// up, so receivers sit across from corners and tackles from edge rushers.
// ESPN's slot ids vary with the formation (4-3 vs 3-4), so unknown ones go last.
export const UNITS = [
  { id: 'line', offense: 'Offensive line', defense: 'Defensive line', o: ['lt', 'lg', 'c', 'rg', 'rt'], d: ['rde', 'rdt', 'nt', 'ldt', 'lde', 'de', 'dt'] },
  { id: 'pass', offense: 'Receivers', defense: 'Secondary', o: ['wr1', 'wr2', 'wr3', 'te', 'te2'], d: ['lcb', 'rcb', 'nb', 'ss', 'fs', 'cb', 's'] },
  { id: 'back', offense: 'Backfield', defense: 'Linebackers', o: ['qb', 'rb', 'fb'], d: ['wlb', 'lilb', 'mlb', 'rilb', 'slb', 'olb', 'ilb', 'lb'] },
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
    const slots = Object.entries(group?.positions ?? {});
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
// Slots not in the lists above (other formations), by their name.
function unitFor(id) {
  if (/(de|dt|nt)$|^(lt|lg|c|rg|rt)$/.test(id)) return 'line';
  if (/lb$|^(qb|rb|fb|hb)\d*$/.test(id)) return 'back';
  if (/(cb|nb|ss|fs|^s)$|^(wr|te)\d*$/.test(id)) return 'pass';
  return null;
}

// ESPN team ids by our team key, and each team's depth chart, kept in memory
// for a few hours (depth charts change a few times a week at most).
let teamIds = null;
const charts = new Map();
const CHART_TTL = 3 * 3600e3;

async function espnTeamId(name) {
  if (!teamIds) {
    const res = await fetch(espnSite('teams'), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`ESPN teams returned ${res.status}`);
    const data = await res.json();
    teamIds = new Map((data.sports?.[0]?.leagues?.[0]?.teams ?? []).map(({ team }) => [teamKey(team.displayName), team.id]));
  }
  return teamIds.get(teamKey(name)) ?? null;
}

export async function teamHeatmap(name, now = Date.now()) {
  const id = await espnTeamId(name);
  if (!id) return null;
  const cached = charts.get(id);
  if (cached && now - cached.at < CHART_TTL) return cached.sides;
  // The roster (for injuries, IR included) and snap counts only add the
  // "how they got the job" tags, so the heat map still works without them.
  const [chart, roster, snaps] = await Promise.allSettled([fetchTeamDepthChart(id), fetchTeamRoster(id), seasonSnaps(new Date(now))]);
  if (chart.status === 'rejected') throw chart.reason;
  const sides = teamSides(chart.value);
  const teams = snaps.status === 'fulfilled' ? snaps.value : null;
  if (snaps.status === 'rejected') console.error(`Snap counts failed: ${snaps.reason?.message ?? snaps.reason}`);
  const athletes = roster.status === 'fulfilled' ? (roster.value.athletes ?? []).flatMap((g) => g.items ?? [g]) : null;
  const injuries = new Map((athletes ?? []).filter((a) => a.injuries?.length).map((a) => [a.displayName, a.injuries[0].status]));
  const names = athletes?.map((a) => a.displayName) ?? null;
  // Rookies: ESPN lists them with 0 years in the league.
  const rookies = new Set((athletes ?? []).filter((a) => a.experience?.years === 0).map((a) => a.displayName));
  for (const side of Object.values(sides)) {
    const slots = Object.values(side).flat();
    for (const slot of slots) slot.rookie = rookies.has(slot.name);
    const starters = slots.map((s) => s.name).filter(Boolean);
    const opts = { injuries, roster: names, starters };
    // Each job lost goes to one replacement: whoever took over first.
    const first = new Map(slots.map((s) => [s, starterHistory(teams, teamCode(name), s, opts)?.since ?? Infinity]));
    const taken = new Set();
    for (const slot of [...slots].sort((a, b) => first.get(a) - first.get(b))) {
      slot.history = starterHistory(teams, teamCode(name), slot, { ...opts, taken });
    }
  }
  charts.set(id, { at: now, sides });
  return sides;
}
