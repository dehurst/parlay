import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSpend, spend, refreshesLeftToday, creditsUsedToday, easternDate, LINES_COST } from '../src/credits.js';

test('the credit day runs midnight to midnight Eastern', () => {
  assert.equal(easternDate(new Date('2026-10-18T03:59:00Z')), '2026-10-17'); // 11:59 PM EDT Saturday
  assert.equal(easternDate(new Date('2026-10-18T04:00:00Z')), '2026-10-18'); // midnight EDT Sunday
  assert.equal(easternDate(new Date('2026-11-15T04:30:00Z')), '2026-11-14'); // 11:30 PM EST
});

test('16 credits a day allows 5 line refreshes', () => {
  const data = {};
  const now = new Date('2026-10-18T15:00:00Z');
  let refreshes = 0;
  while (canSpend(data, LINES_COST, 16, now)) {
    spend(data, LINES_COST, now);
    refreshes++;
  }
  assert.equal(refreshes, 5);
  assert.equal(creditsUsedToday(data, now), 15);
  assert.equal(refreshesLeftToday(data, 16, now), 0);
  assert.equal(canSpend(data, 2, 16, now), false); // the 2-credit scores backup doesn't fit either
  assert.equal(canSpend(data, 1, 16, now), true);
});

test('the budget resets the next Eastern day and old days are forgotten', () => {
  const data = {};
  spend(data, 15, new Date('2026-10-10T15:00:00Z'));
  spend(data, 15, new Date('2026-10-18T03:00:00Z')); // Saturday night Eastern
  const sunday = new Date('2026-10-18T13:00:00Z');
  assert.equal(refreshesLeftToday(data, 16, sunday), 5);
  spend(data, 3, sunday);
  assert.deepEqual(Object.keys(data.creditsUsed).sort(), ['2026-10-17', '2026-10-18']);
});
