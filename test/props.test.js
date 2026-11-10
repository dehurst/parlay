import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProps, propLabel, propLine, gradeProp, parseBoxScore, shortName, normName, validProp, isProp } from '../src/props.js';
import { gradeLeg } from '../src/grading.js';
import { lastSlot, nextSlot } from '../src/week.js';

const event = { bookmakers: [{ key: 'fanduel', markets: [
  { key: 'player_anytime_td', outcomes: [
    { name: 'Yes', description: 'Travis Kelce', price: 140 },
    { name: 'Yes', description: 'Isiah Pacheco', price: 105 },
    { name: 'No', description: 'Isiah Pacheco', price: -140 },
  ] },
  { key: 'player_pass_tds', outcomes: [
    { name: 'Over', description: 'Patrick Mahomes', point: 1.5, price: -150 },
    { name: 'Under', description: 'Patrick Mahomes', point: 1.5, price: 120 },
  ] },
] }] };

test('parses FanDuel props from The Odds API', () => {
  const p = parseProps(event, 'fanduel');
  assert.deepEqual(p.td, [{ player: 'Isiah Pacheco', price: 105 }, { player: 'Travis Kelce', price: 140 }]); // likeliest first, no "No"
  assert.deepEqual(p.ptd, [{ player: 'Patrick Mahomes', point: 1.5, over: -150, under: 120 }]);
  assert.deepEqual(parseProps({}, 'fanduel'), { td: [], ptd: [] });
  assert.deepEqual(propLine(p, 'td:Travis Kelce', 'yes'), { point: null, price: 140 });
  assert.deepEqual(propLine(p, 'ptd:Patrick Mahomes', 'under'), { point: 1.5, price: 120 });
  assert.equal(propLine(p, 'td:Nobody', 'yes'), null);
});

test('labels and names', () => {
  assert.equal(propLabel('td:Christian McCaffrey', 'yes', null), 'C. McCaffrey TD');
  assert.equal(propLabel('ptd:Patrick Mahomes', 'over', 1.5), 'P. Mahomes o1.5 pass TDs');
  assert.equal(shortName('Kenneth Walker III'), 'K. Walker');
  assert.equal(shortName('Amon-Ra St. Brown'), 'A. St. Brown');
  assert.equal(normName('Kenneth Walker III'), normName('Kenneth Walker'));
  assert.ok(isProp('td:Travis Kelce') && !isProp('spread'));
  assert.ok(validProp('ptd:Patrick Mahomes', 'over'));
  assert.ok(!validProp('td:Travis Kelce', 'over'));
});

test('counts touchdowns from an ESPN box score and grades props', () => {
  const summary = { boxscore: { players: [{ statistics: [
    { name: 'passing', keys: ['completions/passingAttempts', 'passingYards', 'passingTouchdowns', 'interceptions'],
      athletes: [{ athlete: { displayName: 'Patrick Mahomes' }, stats: ['25/36', '281', '2', '1'] }] },
    { name: 'rushing', keys: ['rushingAttempts', 'rushingYards', 'rushingTouchdowns'],
      athletes: [{ athlete: { displayName: 'Isiah Pacheco' }, stats: ['15', '70', '1'] }, { athlete: { displayName: 'Patrick Mahomes' }, stats: ['4', '20', '1'] }] },
    { name: 'receiving', keys: ['receptions', 'receivingYards', 'receivingTouchdowns'],
      athletes: [{ athlete: { displayName: 'Travis Kelce' }, stats: ['8', '90', '0'] }] },
    // No keys: falls back to the "TD" label.
    { name: 'kickReturns', labels: ['NO', 'YDS', 'TD'], athletes: [{ athlete: { displayName: 'Xavier Worthy Jr.' }, stats: ['2', '110', '1'] }] },
  ] }] } };
  const players = parseBoxScore(summary);
  assert.deepEqual(players[normName('Patrick Mahomes')], { td: 1, passTd: 2 }); // his rushing TD counts as anytime TD
  assert.deepEqual(players[normName('Travis Kelce')], { td: 0, passTd: 0 });
  assert.equal(players[normName('Xavier Worthy')].td, 1);

  assert.equal(gradeProp('td:Isiah Pacheco', 'yes', null, players), 'win');
  assert.equal(gradeProp('td:Travis Kelce', 'yes', null, players), 'loss');
  assert.equal(gradeProp('td:Somebody Inactive', 'yes', null, players), 'push'); // didn't play: void
  assert.equal(gradeProp('ptd:Patrick Mahomes', 'over', 1.5, players), 'win');
  assert.equal(gradeProp('ptd:Patrick Mahomes', 'under', 1.5, players), 'loss');
  assert.equal(gradeProp('td:Isiah Pacheco', 'yes', null, undefined), 'pending'); // stats not in yet
  // Through the normal grader, with stats riding on the result.
  const result = { homeScore: 27, awayScore: 17, players };
  assert.equal(gradeLeg({ key: 'g|td:Isiah Pacheco|yes', point: null }, result), 'win');
  assert.equal(gradeLeg({ key: 'g|td:Isiah Pacheco|yes', point: null }, { homeScore: 27, awayScore: 17 }), 'pending');
});

test('update times: lines 11 AM and 6 PM, props Thursday and Sunday 11 AM (Eastern)', () => {
  const at = (iso) => new Date(iso).toISOString();
  // Thursday Oct 22, 10:59 AM EDT: last line update was Wednesday 6 PM.
  assert.equal(at(lastSlot(new Date('2026-10-22T14:59:00Z'), [11, 18])), '2026-10-21T22:00:00.000Z');
  assert.equal(at(lastSlot(new Date('2026-10-22T15:00:00Z'), [11, 18])), '2026-10-22T15:00:00.000Z');
  // Saturday: last props update was Thursday 11 AM, next is Sunday 11 AM.
  assert.equal(at(lastSlot(new Date('2026-10-24T16:00:00Z'), [11], [4, 0])), '2026-10-22T15:00:00.000Z');
  assert.equal(at(nextSlot(new Date('2026-10-24T16:00:00Z'), [11], [4, 0])), '2026-10-25T15:00:00.000Z');
  // After clocks fall back (EST), 11 AM is 16:00 UTC.
  assert.equal(at(nextSlot(new Date('2026-11-01T12:00:00Z'), [11, 18])), '2026-11-01T16:00:00.000Z');
});

test('lines refresh twice on game days, once on other days', () => {
  // An NFL week (Eastern dates): Thursday, Sunday and Monday games.
  const gameDays = new Set(['2026-11-12', '2026-11-15', '2026-11-16']);
  const hours = (day) => (gameDays.has(day) ? [11, 18] : [11]);
  // Someone opens the app every hour, Tuesday through Monday night.
  let fetchedAt = Date.parse('2026-11-10T05:00:00Z'); // lines from Monday night
  let refreshes = 0;
  for (let t = Date.parse('2026-11-10T05:00:00Z'); t < Date.parse('2026-11-17T05:00:00Z'); t += 3600e3) {
    if (fetchedAt < lastSlot(new Date(t), hours).getTime()) {
      fetchedAt = t;
      refreshes++;
    }
  }
  assert.equal(refreshes, 3 * 2 + 4 * 1); // was 14 a week with two every day
  // Wednesday 2 PM: the next refresh is Thursday 11 AM, not Wednesday 6 PM.
  assert.equal(nextSlot(new Date('2026-11-11T19:00:00Z'), hours).toISOString(), '2026-11-12T16:00:00.000Z');
  // Thursday 2 PM (game day): 6 PM tonight.
  assert.equal(nextSlot(new Date('2026-11-12T19:00:00Z'), hours).toISOString(), '2026-11-12T23:00:00.000Z');
});
