import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekWindow, weekLabel } from '../src/week.js';
import { weekOf, depthLabel, parseDepthChart, teamInjuries, dropStaleHistory } from '../src/injuries.js';

const weekNum = (iso) => Number(weekLabel(weekWindow(new Date(iso))).match(/Week (\d+)/)[1]);

const roster = (entries) => ({
  athletes: [{ items: entries.map(({ id, name, pos, injuries = [] }) => ({
    id, displayName: name, position: { abbreviation: pos }, injuries,
  })) }],
});

const depthChart = (slots) => ({
  depthchart: [{
    name: 'Offense',
    positions: Object.fromEntries(Object.entries(slots).map(([slot, { pos, ids }]) => [
      slot, { position: { abbreviation: pos }, athletes: ids.map((id) => ({ id })) },
    ])),
  }],
});

test('weekOf matches the app-wide week numbering', () => {
  assert.equal(weekOf(new Date('2026-10-20T10:00:00Z')), 7);
  assert.equal(weekOf(new Date('2026-09-27T18:00:00Z')), 3);
});

test('depthLabel turns a depth-chart rank into plain English', () => {
  assert.equal(depthLabel(1), '1st string');
  assert.equal(depthLabel(2), '2nd string');
  assert.equal(depthLabel(3), 'Rotational');
  assert.equal(depthLabel(5), 'Rotational');
  assert.equal(depthLabel(null), null);
});

test('parseDepthChart keeps the best (lowest) rank seen for each player', () => {
  const dc = depthChart({
    wr1: { pos: 'WR', ids: ['1', '4'] },
    wr2: { pos: 'WR', ids: ['4', '5'] }, // player 4 is a backup at wr1 but starts at wr2
    rb: { pos: 'RB', ids: ['3'] },
  });
  const best = parseDepthChart(dc);
  assert.deepEqual(best.get('1'), { rank: 1, posAbbr: 'WR' });
  assert.deepEqual(best.get('4'), { rank: 1, posAbbr: 'WR' }); // wr2's rank 1 beats wr1's rank 2
  assert.deepEqual(best.get('5'), { rank: 2, posAbbr: 'WR' });
  assert.deepEqual(best.get('3'), { rank: 1, posAbbr: 'RB' });
});

test('teamInjuries lists only injured players, with position/depth/tag', () => {
  const r = roster([
    { id: '1', name: 'Player A', pos: 'WR', injuries: [{ status: 'Questionable', date: '2026-10-20T00:00Z' }] },
    { id: '2', name: 'Player B', pos: 'OT', injuries: [{ status: 'Injured Reserve', date: '2026-10-06T00:00Z' }] },
    { id: '3', name: 'Player C', pos: 'RB', injuries: [] },
  ]);
  const dc = depthChart({ wr1: { pos: 'WR', ids: ['1', '9'] } }); // no entry for Player B: falls back to roster position
  const history = {};
  const list = teamInjuries(r, dc, history, 7);
  assert.equal(list.length, 2); // Player C has no injury and is excluded
  const a = list.find((p) => p.id === '1');
  assert.deepEqual(a, { id: '1', name: 'Player A', position: 'WR', depthRank: 1, depthLabel: '1st string', status: 'Questionable', sinceWeek: 7 });
  const b = list.find((p) => p.id === '2');
  assert.equal(b.position, 'OT'); // not on the depth chart: falls back to roster position
  assert.equal(b.depthLabel, null);
  assert.equal(b.status, 'Injured Reserve');
  assert.equal(b.sinceWeek, weekNum('2026-10-06T00:00Z')); // IR uses ESPN's own (real) transaction date
});

test('a weekly tag (Questionable/Doubtful/Out) keeps its original start week while it continues', () => {
  const r = roster([{ id: '1', name: 'Player A', pos: 'WR', injuries: [{ status: 'Questionable', date: '2026-10-20T00:00Z' }] }]);
  const history = {};
  assert.equal(teamInjuries(r, {}, history, 7)[0].sinceWeek, 7);
  // Next week, ESPN republishes a newer date for the same ongoing tag; our tracked start week doesn't move.
  const r2 = roster([{ id: '1', name: 'Player A', pos: 'WR', injuries: [{ status: 'Questionable', date: '2026-10-27T00:00Z' }] }]);
  assert.equal(teamInjuries(r2, {}, history, 8)[0].sinceWeek, 7);
});

test('dropStaleHistory starts a fresh clock for a player who drops off the report and returns', () => {
  const history = { '1': { startWeek: 7 } };
  dropStaleHistory(history, new Set()); // not seen this poll: recovered
  assert.deepEqual(history, {});
  const r = roster([{ id: '1', name: 'Player A', pos: 'WR', injuries: [{ status: 'Out', date: '2026-11-10T00:00Z' }] }]);
  assert.equal(teamInjuries(r, {}, history, 9)[0].sinceWeek, 9); // new episode, not 7
});

test('dropStaleHistory only removes ids missing from the seen set', () => {
  const history = { a: { startWeek: 1 }, b: { startWeek: 2 } };
  dropStaleHistory(history, new Set(['a']));
  assert.deepEqual(Object.keys(history), ['a']);
});
