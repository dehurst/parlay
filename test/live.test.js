import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEspnBoard } from '../src/results.js';
import { legStatus } from '../public/margin.js';

test('reads live games from ESPN, with the clock', () => {
  const board = { events: [
    { id: '1', date: '2026-10-18T20:25Z', competitions: [{ status: { type: { state: 'in', completed: false, shortDetail: '4:12 - 3rd' } }, competitors: [
      { homeAway: 'home', score: '14', team: { displayName: 'San Francisco 49ers' } },
      { homeAway: 'away', score: '17', team: { displayName: 'Los Angeles Rams' } },
    ] }] },
    { id: '2', date: '2026-10-18T23:20Z', competitions: [{ status: { type: { state: 'pre', completed: false, shortDetail: '7:20 PM' } }, competitors: [
      { homeAway: 'home', team: { displayName: 'Kansas City Chiefs' } },
      { homeAway: 'away', team: { displayName: 'Denver Broncos' } },
    ] }] },
  ] };
  const live = parseEspnBoard(board, '2026-10-13');
  assert.deepEqual(live['2026-10-13-rams-at-49ers'], { state: 'in', completed: false, homeScore: 14, awayScore: 17, detail: '4:12 - 3rd', espnId: '1' });
  assert.equal(live['2026-10-13-broncos-at-chiefs'].state, 'pre');
  assert.equal(live['2026-10-13-broncos-at-chiefs'].homeScore, 0);
});

test('how each bet is doing at a live score', () => {
  const s = { state: 'in', homeScore: 14, awayScore: 17, detail: '4:12 - 3rd' }; // away up 3, 31 points
  const st = (key, point) => legStatus({ key, point }, s);
  assert.deepEqual(st('g|spread|home', 3.5), { cls: 'ahead', text: 'Covering · down 3' });
  assert.deepEqual(st('g|spread|home', 2.5), { cls: 'behind', text: 'Not covering · down 3' });
  assert.deepEqual(st('g|spread|away', -3), { cls: 'even', text: 'Push right now · up 3' });
  assert.deepEqual(st('g|ml|away'), { cls: 'ahead', text: 'Winning · up 3' });
  assert.deepEqual(st('g|ml|home'), { cls: 'behind', text: 'Losing · down 3' });
  assert.deepEqual(st('g|total|over', 44.5), { cls: 'behind', text: '31 pts · needs 14 more' });
  assert.deepEqual(st('g|total|over', 30.5), { cls: 'win', text: 'Hit · 31 pts' });
  assert.deepEqual(st('g|total|under', 44.5), { cls: 'ahead', text: '31 pts · 13 to spare' });
  assert.deepEqual(st('g|total|under', 44), { cls: 'ahead', text: '31 pts · 12 to spare' });
  assert.deepEqual(st('g|total|under', 30.5), { cls: 'loss', text: 'Busted · 31 pts' });
  // Final, before kickoff, and props.
  assert.deepEqual(legStatus({ key: 'g|spread|home', point: 3.5 }, { ...s, state: 'post' }), { cls: 'win', text: 'Won' });
  assert.equal(legStatus({ key: 'g|spread|home', point: 3.5 }, { ...s, state: 'pre' }), null);
  assert.equal(legStatus({ key: 'g|spread|home', point: 3.5 }, undefined), null);
  assert.equal(legStatus({ key: 'g|td:Josh Allen|yes', point: null }, s), null);
});
