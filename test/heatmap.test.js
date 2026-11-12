import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillSlot, teamSides, markFillIns, collegeOf, slotRole, chartRoles, positionRole, applyOfficialReport } from '../src/heatmap.js';

const athlete = (name, status) => ({ displayName: name, injuries: status ? [{ status }] : [] });
const slot = (abbr, ...athletes) => ({ position: { abbreviation: abbr }, athletes });

test('the starter plays when healthy, even if questionable', () => {
  const s = fillSlot(slot('WR', athlete('DJ Moore', 'Questionable'), athlete('Joshua Palmer')));
  assert.equal(s.name, 'DJ Moore');
  assert.equal(s.rank, 1);
  assert.equal(s.status, 'Questionable');
});

test('sidelined players are skipped down the depth chart', () => {
  const s = fillSlot(slot('FS', athlete('C.J. Gardner-Johnson', 'Suspension'), athlete('Damar Hamlin', 'Out'), athlete('Sam Franklin Jr.')));
  assert.equal(s.name, 'Sam Franklin Jr.');
  assert.equal(s.rank, 3);
  assert.deepEqual(s.skipped.map((p) => p.status), ['Suspension', 'Out']);
});

test('nobody healthy leaves the slot empty', () => {
  assert.equal(fillSlot(slot('K', athlete('A', 'Injured Reserve'))).name, null);
});

test('slots group into units that face each other, in lineup order', () => {
  const chart = { depthchart: [
    { name: 'Base 3-4 D', positions: { lde: slot('LDE', athlete('a')), nt: slot('NT', athlete('b')), rde: slot('RDE', athlete('c')), wlb: slot('WLB', athlete('d')), lcb: slot('LCB', athlete('e')), fs: slot('FS', athlete('f')) } },
    { name: 'Special Teams', positions: { pk: slot('PK', athlete('k')) } },
    { name: '3WR 1TE', positions: { wr1: slot('WR', athlete('w')), lt: slot('LT', athlete('t')), c: slot('C', athlete('x')), qb: slot('QB', athlete('q')), te: slot('TE', athlete('y')), fb: slot('FB', athlete('z')) } },
  ] };
  const { offense, defense } = teamSides(chart);
  assert.deepEqual(offense.line.map((s) => s.slot), ['lt', 'c']);
  assert.deepEqual(offense.pass.map((s) => s.slot), ['wr1', 'te']);
  assert.deepEqual(offense.back.map((s) => s.slot), ['qb']);
  assert.deepEqual(defense.line.map((s) => s.slot), ['rde', 'nt', 'lde']);
  assert.deepEqual(defense.pass.map((s) => s.slot), ['lcb', 'fs']);
  assert.deepEqual(defense.back.map((s) => s.slot), ['wlb']);
});

test('a starter who would sit at full strength is a fill-in, wherever ESPN lists the hurt starters', () => {
  const sq = (slotId, name) => ({ slot: slotId, name, rank: 1, skipped: [], history: { tag: 'week1' } });
  const side = { line: [sq('rde', 'True Starter'), sq('nt', 'Part Timer'), sq('lde', 'Rotation End')] };
  const share = { 'True Starter': 0.62, 'Part Timer': 0.18, 'Rotation End': 0.54, 'Star End': 0.82, 'Hurt End': 0.61, 'Hurt Nose': 0.39, 'Deep Reserve': 0.1 };
  const sidelined = [['Star End', 'DL'], ['Hurt End', 'DL'], ['Hurt Nose', 'DL'], ['Deep Reserve', 'DL'], ['Hurt Corner', 'DB']]
    .map(([name, group]) => ({ name, status: 'Injured Reserve', group }));
  markFillIns(side, sidelined, { share: (n) => share[n] ?? null });
  const [donald, hamilton, fiske] = side.line;
  assert.equal(donald.history.tag, 'week1');
  assert.equal(fiske.history.tag, 'fillin');
  assert.equal(fiske.history.replaced, 'Hurt End');
  assert.equal(fiske.history.deep, 1);
  // Three hurt players would play ahead of the part-timer: a deep fill-in.
  assert.equal(hamilton.history.tag, 'fillin');
  assert.equal(hamilton.history.deep, 3);
  assert.deepEqual(hamilton.history.ahead.map((p) => p.name), ['Star End', 'Hurt End', 'Hurt Nose']);
});

test('a hurt player who out-snapped a starter ranks ahead of him, whatever their usual shares', () => {
  const sq = (slotId, name) => ({ slot: slotId, name, rank: 1, skipped: [], history: { tag: 'earned' } });
  const side = { pass: [sq('wr1', 'Evans'), sq('wr2', 'Samuel'), sq('wr3', 'Watkins')] };
  const share = { Evans: 0.54, Samuel: 0.58, Watkins: 0.51, Pearsall: 0.78, Robinson: 0.47, Stribling: 0.32 };
  const sidelined = ['Pearsall', 'Robinson', 'Stribling'].map((name) => ({ name, status: 'Injured Reserve', group: 'WR' }));
  // Robinson and Stribling started Week 1 while Watkins sat.
  markFillIns(side, sidelined, { share: (n) => share[n] ?? null, ahead: (a, b) => b === 'Watkins' && a !== 'Pearsall' });
  const [evans, samuel, watkins] = side.pass;
  assert.equal(evans.history.tag, 'earned');
  assert.equal(samuel.history.tag, 'earned');
  assert.equal(watkins.history.tag, 'fillin');
  assert.equal(watkins.history.deep, 3);
});

test('a player\'s college: abbreviation and a small logo, or nothing', () => {
  const miami = {
    name: 'Miami', abbrev: 'MIA',
    logos: [
      { href: 'https://a.espncdn.com/i/teamlogos/ncaa/500/2390.png', rel: ['full', 'default'] },
      { href: 'https://a.espncdn.com/i/teamlogos/ncaa/500-dark/2390.png', rel: ['full', 'dark'] },
    ],
  };
  assert.deepEqual(collegeOf(miami), {
    abbrev: 'MIA', name: 'Miami', logo: 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/ncaa/500/2390.png&w=40&h=40',
  });
  assert.equal(collegeOf(undefined), null);
  assert.equal(collegeOf({ name: 'Miami', abbrev: 'MIA', logos: [] }), null);
  assert.equal(collegeOf({ name: 'Miami', logos: miami.logos }), null);
});

test('a starter who would start at full strength isn\'t a fill-in, whatever his snaps alone said', () => {
  // Snaps alone said each took over for someone now hurt; at full strength
  // the first still starts, the second doesn't, and the third is listed
  // behind a sidelined player on the depth chart.
  const fill = { tag: 'fillin', since: 4, replaced: 'Slot Guy', replacedStatus: 'Injured Reserve', timeline: [] };
  const side = { pass: [
    { slot: 'wr1', name: 'Star Wideout', rank: 1, skipped: [], history: { ...fill } },
    { slot: 'wr2', name: 'Fill Wideout', rank: 1, skipped: [], history: { ...fill, replaced: 'Big Wideout' } },
    { slot: 'wr3', name: 'Listed Behind', rank: 1, skipped: [{ name: 'Slot Guy', status: 'Injured Reserve' }], history: { ...fill } },
  ] };
  const share = { 'Star Wideout': 0.67, 'Fill Wideout': 0.3, 'Listed Behind': 0.55, 'Slot Guy': 0.38, 'Big Wideout': 0.8 };
  const sidelined = ['Slot Guy', 'Big Wideout'].map((name) => ({ name, status: 'Injured Reserve', group: 'WR' }));
  markFillIns(side, sidelined, { share: (n) => share[n] ?? null });
  const [star, fillIn, listed] = side.pass;
  assert.deepEqual(star.history, { tag: 'week1', since: 4, timeline: [] });
  assert.equal(fillIn.history.tag, 'fillin');
  assert.equal(listed.history.tag, 'fillin');
});

test('a clear starter last season is scored on that, not a few limited games this season', () => {
  const sq = (slotId, name) => ({ slot: slotId, name, rank: 1, skipped: [], history: { tag: 'week1', since: 1 } });
  const side = { pass: [sq('wr1', 'Proven Wideout'), sq('wr2', 'Other Wideout')] };
  const share = { 'Proven Wideout': 0.53, 'Other Wideout': 0.7, 'Hurt Backup': 0.55 };
  const sidelined = [{ name: 'Hurt Backup', status: 'Out', group: 'WR' }];
  markFillIns(side, sidelined, { share: (n) => share[n] ?? null, starterShare: (n) => (n === 'Proven Wideout' ? 0.78 : share[n]) });
  assert.equal(side.pass[0].history.tag, 'week1');
  assert.equal(side.pass[1].history.tag, 'week1');
});

test('jobs: edges, inside LBs, corners and safeties are different spots', () => {
  // ESPN's 3-4 lists edge rushers at WLB/SLB and 5-techs at LDE/RDE.
  assert.equal(slotRole('wlb', true), 'edge');
  assert.equal(slotRole('slb', true), 'edge');
  assert.equal(slotRole('rilb', true), 'ilb');
  assert.equal(slotRole('lde', true), 'de34');
  // In a 4-3 the ends rush and the three linebackers each have their own job.
  assert.equal(slotRole('lde', false), 'edge');
  assert.equal(slotRole('wlb', false), 'wlb');
  assert.equal(slotRole('mlb', false), 'mlb');
  assert.equal(slotRole('lcb', false), slotRole('rcb', false));
  assert.notEqual(slotRole('nb', false), slotRole('lcb', false));
  assert.notEqual(slotRole('ss', false), slotRole('fs', false));
  assert.notEqual(slotRole('wr1', false), slotRole('wr3', false));
});

test('a hurt edge rusher doesn\'t make an inside linebacker a fill-in', () => {
  const a = (id, displayName) => ({ id, displayName });
  const chart = { depthchart: [{ name: 'Base 3-4 D', positions: {
    wlb: slot('WLB', a('1', 'Edge Starter'), a('2', 'Star Edge')),
    lilb: slot('LILB', a('3', 'Top Inside')),
    rilb: slot('RILB', a('4', 'Young Inside'), a('5', 'Vet Inside')),
    slb: slot('SLB', a('6', 'Other Edge')),
  } }] };
  const roles = chartRoles(chart);
  assert.equal(roles.get('2'), 'edge');
  assert.equal(roles.get('5'), 'ilb');
  // Left off the chart: a linebacker could be either job, so he's not counted.
  assert.equal(positionRole('LB', chart), null);
  assert.equal(positionRole('CB', chart), 'cb');

  const sq = (slotId, name) => ({ slot: slotId, role: slotRole(slotId, true), name, rank: 1, skipped: [], history: { tag: 'week1' } });
  const side = { back: [sq('wlb', 'Edge Starter'), sq('lilb', 'Top Inside'), sq('rilb', 'Young Inside'), sq('slb', 'Other Edge')] };
  const share = { 'Edge Starter': 0.8, 'Top Inside': 0.95, 'Young Inside': 0.67, 'Other Edge': 0.75, 'Star Edge': 0.85, 'Vet Inside': 0.9 };
  const sidelined = [['Star Edge', '2'], ['Vet Inside', '5']].map(([name, id]) => ({ name, status: 'Injured Reserve', group: 'LB', role: roles.get(id) }));
  markFillIns(side, sidelined, { share: (n) => share[n] ?? null });
  const [edge, top, young, other] = side.back;
  // Only the inside backer is ahead of the young one: one spot, not "3rd string".
  assert.equal(young.history.tag, 'fillin');
  assert.equal(young.history.deep, 1);
  assert.deepEqual(young.history.ahead.map((p) => p.name), ['Vet Inside']);
  // The star edge bumps the weaker edge, not an inside linebacker.
  assert.equal(other.history.tag, 'fillin');
  assert.equal(other.history.replaced, 'Star Edge');
  assert.equal(edge.history.tag, 'week1');
  assert.equal(top.history.tag, 'week1');
});

test('this week\'s official injury report overrides ESPN\'s lagging game tags', () => {
  const burks = athlete('Treylon Burks', 'Out');
  const mclaurin = athlete('Terry McLaurin', 'Injured Reserve');
  const diggs = athlete('Stefon Diggs');
  const yankoff = athlete('Colson Yankoff', 'Out');
  const lane = athlete('Jaylin Lane', 'Questionable');
  const reports = new Map([
    ['treylonburks', [{ team: 'WAS', week: 9, status: 'Out' }, { team: 'WAS', week: 10, status: '' }]], // practice line only
    ['colsonyankoff', [{ team: 'WAS', week: 10, status: 'Out' }]],
    ['stefondiggs', [{ team: 'WAS', week: 10, status: 'Doubtful' }]],
  ]);
  const changed = applyOfficialReport([burks, mclaurin, diggs, yankoff, lane], reports, 'WAS', 10);
  assert.deepEqual(burks.injuries, []); // no designation: plays
  assert.equal(mclaurin.injuries[0].status, 'Injured Reserve'); // roster move: ESPN's
  assert.equal(diggs.injuries[0].status, 'Doubtful'); // on the report, ESPN missed it
  assert.equal(yankoff.injuries[0].status, 'Out');
  assert.deepEqual(lane.injuries, []); // off this week's report entirely
  assert.deepEqual(changed.sort(), ['Jaylin Lane', 'Stefon Diggs', 'Treylon Burks']);
  // Before the team's report for the week is out, ESPN's tags stand.
  const early = athlete('Treylon Burks', 'Out');
  assert.deepEqual(applyOfficialReport([early], reports, 'WAS', 11), []);
  assert.equal(early.injuries[0].status, 'Out');
  // A practice-only report (midweek, no game statuses yet) isn't final either.
  const practice = new Map([['jaylonjones', [{ team: 'TEN', week: 10, status: '' }]]]);
  const jones = athlete('Jaylon Jones', 'Out');
  assert.deepEqual(applyOfficialReport([jones], practice, 'TEN', 10), []);
  assert.equal(jones.injuries[0].status, 'Out');
});
