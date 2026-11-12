import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lbRole } from '../src/lbroles.js';

const season = (snaps, adv) => ({
  teams: { NYG: { weeks: [1], players: Object.entries(snaps).map(([pfrId, defSnaps]) => ({ pfrId, defSnaps, names: new Set(), pct: {} })) } },
  adv: new Map(Object.entries(adv)),
});
const vet = (stops, more = {}) => ({ pff: 'LB', ngs: 'MLB', combine: 'LB', exp: 6, stops, ...more });

test('off-ball linebackers: run stoppers, blitzers and coverage backers', () => {
  const s = season({ bolton: 1000, warner: 1000, franklin: 1000, okereke: 1000, mid: 1000 }, {
    bolton: { tgt: 73, bltz: 81, prss: 8 },
    warner: { tgt: 71, bltz: 42, prss: 5 },
    franklin: { tgt: 54, bltz: 73, prss: 12 },
    okereke: { tgt: 58, bltz: 32, prss: 2 },
    mid: { tgt: 60, bltz: 45, prss: 5 },
  });
  assert.equal(lbRole('bolton', 'mlb', [s], vet(64)).kind, 'thumper');
  assert.equal(lbRole('warner', 'mlb', [s], vet(55)).kind, 'allround');
  // Blitzing a lot isn't stopping the run.
  assert.equal(lbRole('franklin', 'ilb', [s], vet(37)).kind, 'blitzer');
  assert.equal(lbRole('okereke', 'mlb', [s], vet(40)).kind, 'coverage');
  assert.equal(lbRole('mid', 'wlb', [s], vet(40)).kind, 'offball');
  assert.equal(lbRole('bolton', 'mlb', [s], vet(64)).rates.stops, 6.4);
});

test('an edge rusher by background stays one, even lined up inside as a rookie', () => {
  // Reese: the Giants play him at inside LB, but he came in an EDGE.
  const s = season({ reese: 508, barnes: 1000, ed: 800 }, {
    reese: { tgt: 33, bltz: 48, prss: 8 },
    barnes: { tgt: 40, bltz: 58, prss: 9 },
    ed: { tgt: 34, bltz: 10, prss: 30 },
  });
  const reese = lbRole('reese', 'ilb', [s], { pff: 'LB', ngs: 'MLB', combine: 'EDGE', exp: 0, stops: 16 });
  assert.equal(reese.kind, 'rush');
  assert.match(reese.why, /combine: EDGE.*off the ball/);
  // A college DE who's played inside for years goes by how he's played.
  assert.equal(lbRole('barnes', 'ilb', [s], { pff: 'LB', ngs: 'MLB', combine: 'DE', exp: 6, stops: 31 }).kind, 'blitzer');
  // PFF calling him an edge rusher settles it; Next Gen Stats alone doesn't
  // when PFF says LB (it lists some off-ball backers as EDGE).
  assert.equal(lbRole('ed', 'wlb', [s], { pff: 'ED', ngs: 'EDGE', combine: 'OLB', exp: 8, stops: 20 }).kind, 'rush');
  assert.notEqual(lbRole('barnes', 'ilb', [s], { pff: 'LB', ngs: 'EDGE', combine: 'LB', exp: 7, stops: 31 }).kind, 'rush');
});

test('usage still finds rushers with no background; too few snaps falls back or says nothing', () => {
  const now = season({ a: 100, b: 700 }, { a: { tgt: 0, bltz: 0, prss: 5 }, b: { tgt: 3, bltz: 3, prss: 48 } });
  const last = season({ a: 100 }, { a: { tgt: 1, bltz: 1, prss: 4 } });
  assert.equal(lbRole('b', 'ilb', [now]).kind, 'rush');
  assert.equal(lbRole('a', 'ilb', [now, last]).rates.snaps, 200);
  assert.equal(lbRole('a', 'ilb', [now]), null);
  assert.equal(lbRole('a', 'edge', [now]).kind, 'rush');
  assert.equal(lbRole(null, 'ilb', [now]), null);
});
