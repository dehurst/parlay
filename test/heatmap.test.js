import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillSlot, teamSides, markFillIns } from '../src/heatmap.js';

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
