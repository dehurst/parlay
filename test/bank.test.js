import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBank, bankAlerts } from '../src/bank.js';

const START = 1000;
const bank = (entries = []) => ({ startAt: START, entries });
const dep = (who, amount, at = 1100) => ({ id: `${who}${at}`, who, kind: 'deposit', amount, at });
const bet = (o) => ({ name: 'Bet', url: '/', placed: { at: 2000 }, status: 'pending', current: true, ...o });

test('balances: deposits, placed bets, wins, pushes, holds', () => {
  const bets = [
    // Won: $10 + $10 in, $50.97 back from FanDuel.
    bet({ id: 'a', name: 'Best bet', stakes: { Matt: 10, Daniel: 10 }, total: 20, status: 'won', returned: 50.97, decidedAt: 3000 }),
    // Lost.
    bet({ id: 'b', name: 'Dud', stakes: { Matt: 5, Asher: 5 }, total: 10, status: 'lost', returned: 0 }),
    // Push: stake back.
    bet({ id: 'c', name: 'Even', stakes: { Asher: 10 }, total: 10, status: 'push', returned: 10 }),
    // In play: off the balance already.
    bet({ id: 'd', name: 'Sunday', stakes: { Asher: 15 }, total: 15 }),
    // Not placed yet: on hold.
    bet({ id: 'e', name: 'Maybe', stakes: { Matt: 20 }, total: 20, placed: null }),
    // Placed before balances started: the old Venmo way, not counted.
    bet({ id: 'f', name: 'Old', stakes: { Matt: 50 }, total: 50, placed: { at: 500 }, status: 'won', returned: 200 }),
    // Not placed, last week: dead, not held.
    bet({ id: 'g', name: 'Stale', stakes: { Matt: 30 }, total: 30, placed: null, current: false }),
  ];
  const b = computeBank(bank([dep('Matt', 100), dep('Asher', 100), { id: 'x', who: 'Matt', kind: 'cashout', amount: 25, at: 4000 }]), bets, ['Asher', 'Matt'], 'Daniel');
  const m = Object.fromEntries(b.members.map((r) => [r.name, r]));
  // Matt: 100 - 25 - 10 - 5 + 25.485 (half of 50.97)
  assert.equal(m.Matt.balance, 85.49);
  assert.equal(m.Matt.hold, 20);
  assert.equal(m.Matt.available, 65.49);
  // Asher: 100 - 5 - 10 + 10 - 15
  assert.equal(m.Asher.balance, 80);
  assert.equal(m.Asher.inPlay, 15);
  assert.equal(m.Asher.status, 'ok');
  assert.equal(b.holding, 165.49);
  assert.equal(b.inPlay, 15);
  // History, newest first, with what each line did.
  assert.deepEqual(m.Matt.history.map((h) => [h.text, h.amount]).sort(), [
    ['Daniel paid you back', -25],
    ['Won: Best bet', 25.49],
    ['Bet placed: Best bet', -10],
    ['Bet placed: Dud', -5],
    ['Lost: Dud', 0],
    ['Venmo to Daniel', 100],
  ].sort());
  assert.equal(m.Matt.history[0].text, 'Daniel paid you back'); // newest first
});

test('balances: low and high lines, alerts once per crossing', () => {
  const low = computeBank(bank([dep('Matt', 30)]), [bet({ id: 'a', stakes: { Matt: 15 }, total: 15, placed: null })], ['Matt'], 'Daniel').members[0];
  assert.equal(low.status, 'low'); // $30, $15 on hold: $15 available
  assert.equal(low.topUp, 85);
  const high = computeBank(bank([dep('Asher', 100)]), [bet({ id: 'a', stakes: { Asher: 20 }, total: 20, status: 'won', returned: 140 })], ['Asher'], 'Daniel').members[0];
  assert.equal(high.balance, 220);
  assert.equal(high.status, 'high');
  assert.equal(high.cashOut, 120);
  let r = bankAlerts([low, high], {});
  assert.equal(r.alerts.length, 2);
  r = bankAlerts([low, high], r.sent);
  assert.equal(r.alerts.length, 0); // already told
  r = bankAlerts([{ ...low, status: 'ok' }], r.sent);
  assert.deepEqual(r.sent, {}); // back to normal: next dip alerts again
});
