// What kind of linebacker he is. Two questions, in order:
//
// 1. Is he an edge rusher listed at LB? His background decides first:
//    - PFF lists him as an edge rusher (ED; NFL Next Gen Stats' EDGE only
//      when PFF has no position for him), or
//    - he's a rookie or 2nd-year player who came in as an edge rusher
//      (combine EDGE/DE): too new for one team's usage to say otherwise.
//      Veterans go by how they've actually played (a college DE who's been
//      an inside backer for years is an inside backer).
//    Then usage: almost never thrown at in coverage (under 3 targets per 100
//    snaps; every off-ball LB in the league is over that).
//
// 2. Off the ball, what does he do? (per 100 snaps, this season + last)
//    - allround: stops the run (5+ run stops, about the top third) and
//                rarely blitzes (4.5 or fewer): the complete backer
//    - thumper:  stops the run (5+), and blitzes too
//    - blitzer:  sent after the QB a lot (5.5+ blitzes) without the run stops
//    - coverage: rarely blitzes (3.5 or fewer): drops into coverage
//    - offball:  in between
// A run stop is a tackle on a designed run the offense lost (nflverse's
// `success` = 0). Without enough snaps to go on, his background or a 3-4
// edge spot on the depth chart can still say rush; otherwise no tag.

export const LB_ROLES = {
  rush: 'Rush LB',
  allround: 'All-around LB',
  thumper: 'Thumper',
  blitzer: 'Blitzer',
  coverage: 'Coverage LB',
  offball: 'Off-ball LB',
};

const MIN_SNAPS = 150;
const RUSH_TARGETS = 3;
const RUN_STOPS = 5;
const ALLROUND_BLITZ = 4.5;
const BLITZER = 5.5;
const COVERAGE_BLITZ = 3.5;

// Why his background says edge rusher, or null.
function edgeBackground(profile) {
  if (!profile) return null;
  // PFF's label first: Next Gen Stats calls some off-ball backers EDGE
  // (Willie Gay, Eric Wilson), so it only counts when PFF has none.
  if (profile.pff === 'ED') return 'PFF lists him as an edge rusher';
  if (!profile.pff && profile.ngs === 'EDGE') return 'Next Gen Stats lists him as an edge rusher';
  if (profile.exp != null && profile.exp <= 1 && /^(EDGE|DE)$/.test(profile.combine ?? '')) {
    return `Came into the league an edge rusher (combine: ${profile.combine})`;
  }
  return null;
}

// `seasons` is [{ teams, adv }] for each season to pool: that season's snap
// counts (parseSnaps) and PFR charting (PFR id -> { tgt, bltz, prss }).
// `profile` is his entry in src/lb-data.js (positions, experience, run
// stops over the same seasons), or null. `chartRole` is his job on ESPN's
// chart (see slotRole).
export function lbRole(pfrId, chartRole, seasons, profile = null) {
  let snaps = 0, tgt = 0, bltz = 0, prss = 0;
  if (pfrId) {
    for (const { teams, adv } of seasons) {
      if (!teams || !adv) continue;
      const a = adv.get(pfrId);
      if (!a) continue;
      // A traded player has snaps on more than one team.
      for (const t of Object.values(teams)) for (const p of t.players) if (p.pfrId === pfrId) snaps += p.defSnaps;
      tgt += a.tgt; bltz += a.bltz; prss += a.prss;
    }
  }
  const background = edgeBackground(profile);
  const enough = snaps >= MIN_SNAPS;
  const per = (n) => Math.round((1000 * n) / snaps) / 10;
  const rates = enough ? { snaps, targets: per(tgt), blitzes: per(bltz), pressures: per(prss), stops: profile ? per(profile.stops) : null } : null;
  const numbers = rates && `Per 100 snaps: ${rates.stops != null ? `${rates.stops} run stops, ` : ''}${rates.blitzes} blitzes, ${rates.targets} coverage targets, ${rates.pressures} pressures (${snaps} snaps)`;
  const role = (kind, why) => ({ kind, label: LB_ROLES[kind], why, ...(rates && { rates }) });

  if (background) {
    // Note when his team is using him off the ball anyway.
    const off = rates && rates.targets >= RUSH_TARGETS ? `; lining up off the ball so far (${rates.targets} coverage targets per 100 snaps)` : '';
    return role('rush', `${background}${off}`);
  }
  if (!rates) return chartRole === 'edge' ? role('rush', 'Lines up at an edge spot on the depth chart') : null;
  if (rates.targets < RUSH_TARGETS) return role('rush', numbers);
  const stops = rates.stops ?? 0;
  const kind = stops >= RUN_STOPS && rates.blitzes <= ALLROUND_BLITZ ? 'allround'
    : stops >= RUN_STOPS ? 'thumper'
      : rates.blitzes >= BLITZER ? 'blitzer'
        : rates.blitzes <= COVERAGE_BLITZ ? 'coverage' : 'offball';
  return role(kind, numbers);
}
