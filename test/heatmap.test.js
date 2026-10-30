import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillSlot, teamSides } from '../src/heatmap.js';

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
    { name: '3WR 1TE', positions: { wr1: slot('WR', athlete('w')), lt: slot('LT', athlete('t')), c: slot('C', athlete('x')), qb: slot('QB', athlete('q')), te: slot('TE', athlete('y')) } },
  ] };
  const { offense, defense } = teamSides(chart);
  assert.deepEqual(offense.line.map((s) => s.slot), ['lt', 'c']);
  assert.deepEqual(offense.pass.map((s) => s.slot), ['wr1', 'te']);
  assert.deepEqual(offense.back.map((s) => s.slot), ['qb']);
  assert.deepEqual(defense.line.map((s) => s.slot), ['rde', 'nt', 'lde']);
  assert.deepEqual(defense.pass.map((s) => s.slot), ['lcb', 'fs']);
  assert.deepEqual(defense.back.map((s) => s.slot), ['wlb']);
});
