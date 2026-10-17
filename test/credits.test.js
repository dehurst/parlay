import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditPause, easternTime } from '../src/credits.js';

const win = { key: '2026-10-13', start: new Date('2026-10-13T12:00:00Z') };
const games = [
  { commence: '2026-10-16T00:15:00Z' }, // Thursday night
  { commence: '2026-10-18T17:00:00Z' }, // Sunday
  { commence: '2026-10-20T00:15:00Z' }, // Monday night (8:15 PM ET)
];
const at = (iso) => creditPause(win, games, new Date(iso));

test('Eastern wall-clock times handle daylight saving', () => {
  assert.equal(easternTime(2026, 9, 14, 19).toISOString(), '2026-10-14T23:00:00.000Z'); // EDT
  assert.equal(easternTime(2026, 10, 11, 19).toISOString(), '2026-11-12T00:00:00.000Z'); // EST
});

test('paid calls pause from Tuesday morning until Wednesday 7 PM Eastern', () => {
  assert.deepEqual(at('2026-10-13T15:00:00Z'), { paused: true, until: new Date('2026-10-14T23:00:00Z') });
  assert.equal(at('2026-10-14T22:59:00Z').paused, true);
  assert.equal(at('2026-10-14T23:00:00Z').paused, false);
  assert.equal(at('2026-10-18T16:00:00Z').paused, false); // Sunday morning
});

test('paid calls pause again once the last game of the week kicks off', () => {
  assert.equal(at('2026-10-20T00:14:00Z').paused, false);
  assert.deepEqual(at('2026-10-20T00:15:00Z'), { paused: true, until: new Date('2026-10-21T23:00:00Z') });
});

test('the Wednesday resume time follows standard time in November', () => {
  const nov = { key: '2026-11-10', start: new Date('2026-11-10T12:00:00Z') };
  assert.deepEqual(creditPause(nov, [], new Date('2026-11-11T23:30:00Z')), { paused: true, until: new Date('2026-11-12T00:00:00Z') });
  assert.equal(creditPause(nov, [], new Date('2026-11-12T00:00:00Z')).paused, false);
});
