import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileNames, watchList, parseInactives, decide } from '../src/gameday.js';
import { messageFor } from '../src/push.js';
import { playerYards } from '../src/heatmap.js';

test('tileNames: starters and the hurt players skipped over', () => {
  const sides = {
    offense: { back: [{ name: 'James Cook', skipped: [] }], pass: [{ name: 'Khalil Shakir', skipped: [{ name: 'Keon Coleman', status: 'Doubtful' }] }] },
    defense: { line: [{ name: null, skipped: [] }] },
    form: { QB: {} },
  };
  assert.deepEqual([...tileNames(sides)], ['James Cook', 'Khalil Shakir', 'Keon Coleman']);
});

test('watchList: only Questionable/Doubtful players among the names', () => {
  const roster = { athletes: [{ items: [
    { id: '1', displayName: 'James Cook', injuries: [{ status: 'Questionable' }] },
    { id: '2', displayName: 'Keon Coleman', injuries: [{ status: 'Doubtful' }] },
    { id: '3', displayName: 'Khalil Shakir', injuries: [{ status: 'Out' }] },
    { id: '4', displayName: 'Someone Else', injuries: [{ status: 'Questionable' }] },
  ] }] };
  assert.deepEqual(watchList(roster, new Set(['James Cook', 'Keon Coleman', 'Khalil Shakir']), 'Buffalo Bills'), {
    1: { name: 'James Cook', team: 'Buffalo Bills', status: 'Questionable' },
    2: { name: 'Keon Coleman', team: 'Buffalo Bills', status: 'Doubtful' },
  });
});

test('parseInactives: null until ESPN lists anyone', () => {
  assert.equal(parseInactives({ entries: [{ playerId: 1, didNotPlay: false }] }), null);
  assert.deepEqual([...parseInactives({ entries: [{ playerId: 1, didNotPlay: true }, { playerId: 2, didNotPlay: false }] })], ['1']);
});

test('decide: active or inactive, once, only for teams whose list is out', () => {
  const watch = {
    1: { name: 'James Cook', team: 'Bills', status: 'Questionable' },
    2: { name: 'Keon Coleman', team: 'Bills', status: 'Doubtful' },
    3: { name: 'Old News', team: 'Bills', status: 'Questionable', done: true },
    4: { name: 'Justin Jefferson', team: 'Vikings', status: 'Questionable' },
  };
  assert.deepEqual(decide(watch, { Bills: new Set(['2']) }), [
    { id: '1', name: 'James Cook', team: 'Bills', was: 'Questionable', now: 'Active' },
    { id: '2', name: 'Keon Coleman', team: 'Bills', was: 'Doubtful', now: 'Inactive' },
  ]);
});

test('status message: who is out, who is in', () => {
  const msg = messageFor({ type: 'status', league: 'nfl', game: 'Bills @ Vikings', players: [
    { name: 'James Cook', was: 'Questionable', now: 'Active' },
    { name: 'Keon Coleman', was: 'Doubtful', now: 'Inactive' },
  ] });
  assert.deepEqual(msg, { title: 'Bills @ Vikings: 1 out', body: 'Inactive: Keon Coleman (D). Active: James Cook (Q).' });
  assert.equal(messageFor({ type: 'status', game: 'Bills @ Vikings', players: [{ name: 'A B', was: 'Questionable', now: 'Active' }] }).title, 'Bills @ Vikings: all active');
});

test('playerYards: his yards in the team\'s last games, null where he had no line', () => {
  const weekly = [
    { week: 1, team: 'BUF', name: 'Josh Allen', passYds: 300 },
    { week: 2, team: 'BUF', name: 'James Cook', rushYds: 80 },
    { week: 3, team: 'BUF', name: 'Josh Allen', passYds: 250 },
    { week: 1, team: 'MIN', name: 'Josh Allen', passYds: 999 },
  ];
  assert.deepEqual(playerYards(weekly, 'BUF', 'Josh Allen', 'QB'), { label: 'Passing', games: [{ week: 1, yds: 300 }, { week: 2, yds: null }, { week: 3, yds: 250 }] });
  assert.deepEqual(playerYards(weekly, 'BUF', 'Josh Allen', 'QB', 2).games.map((g) => g.week), [2, 3]);
  assert.equal(playerYards(weekly, 'BUF', 'Josh Allen', 'OL'), null);
});
