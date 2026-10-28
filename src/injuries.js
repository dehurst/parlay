// Research tab: every team's current injury report (ESPN, free) — each
// player's roster position, their standing on the depth chart (1st string,
// 2nd string, or a rotational/backup player), and ESPN's tag (Questionable,
// Doubtful, Out, Injured Reserve, Suspension).
//
// ESPN's roster feed republishes the same "date" on every weekly Questionable
// /Doubtful/Out entry whether or not the status actually changed, so it can't
// be used to tell how long someone's been on the report. Instead this tracks
// it here: a player keeps their original start week as long as they stay on
// the report continuously, and starts over if they ever drop off. Injured
// Reserve/Suspension dates are real transaction dates, so those are read
// straight from ESPN.

import { weekWindow, weekLabel } from './week.js';
import { espnSite } from './sport.js';

// ESPN's weekly injury-report tags, as opposed to roster-status ones (Injured
// Reserve, Suspension) whose own date is meaningful.
const WEEKLY_TAGS = ['Questionable', 'Doubtful', 'Out'];

export async function fetchTeamRoster(teamId) {
  const res = await fetch(`${espnSite('teams')}/${teamId}/roster`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ESPN roster returned ${res.status}`);
  return res.json();
}

export async function fetchTeamDepthChart(teamId) {
  const res = await fetch(`${espnSite('teams')}/${teamId}/depthcharts`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ESPN depth chart returned ${res.status}`);
  return res.json();
}

// The season week (1-18, same numbering as the rest of the app) a date falls in.
export function weekOf(date) {
  const m = weekLabel(weekWindow(date)).match(/Week (\d+)/);
  return m ? Number(m[1]) : null;
}

// Depth-chart rank -> plain-English standing.
export function depthLabel(rank) {
  if (rank === 1) return '1st string';
  if (rank === 2) return '2nd string';
  if (rank != null) return 'Rotational';
  return null;
}

// playerId -> { rank, posAbbr }, the best (lowest/most senior) rank seen for
// that player across every formation and slot that lists them. ESPN's depth
// chart lists each slot's athletes starter-first, so array position is rank.
export function parseDepthChart(depthChart) {
  const best = new Map();
  for (const group of depthChart?.depthchart ?? []) {
    for (const slot of Object.values(group.positions ?? {})) {
      const posAbbr = slot.position?.abbreviation ?? null;
      (slot.athletes ?? []).forEach((a, i) => {
        const rank = i + 1;
        const cur = best.get(a.id);
        if (!cur || rank < cur.rank) best.set(a.id, { rank, posAbbr });
      });
    }
  }
  return best;
}

// Everyone on this team's injury report right now. `history` (keyed by
// player id, `{ startWeek }`) is read and mutated in place to track how long
// each weekly-tag player has been on the report; call dropStaleHistory once
// after processing every team so recovered players don't linger in it.
export function teamInjuries(roster, depthChart, history, currentWeek) {
  const depth = parseDepthChart(depthChart);
  const athletes = (roster?.athletes ?? []).flatMap((g) => g.items ?? [g]);
  return athletes
    .filter((a) => a.injuries?.length)
    .map((a) => {
      const inj = a.injuries[0];
      const d = depth.get(a.id);
      let sinceWeek;
      if (WEEKLY_TAGS.includes(inj.status)) {
        history[a.id] ??= { startWeek: currentWeek };
        sinceWeek = history[a.id].startWeek;
      } else {
        delete history[a.id];
        sinceWeek = inj.date ? weekOf(new Date(inj.date)) : null;
      }
      return {
        id: a.id,
        name: a.displayName,
        position: d?.posAbbr ?? a.position?.abbreviation ?? null,
        depthRank: d?.rank ?? null,
        depthLabel: depthLabel(d?.rank),
        status: inj.status,
        sinceWeek,
      };
    });
}

// Drop any tracked player not in `seenIds` (this poll's full injury list
// across every team refreshed): they're no longer on any report.
export function dropStaleHistory(history, seenIds) {
  for (const id of Object.keys(history)) {
    if (!seenIds.has(id)) delete history[id];
  }
}
