import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCsvLine, parseStats } from '../src/nflstats.js';
import { injuryHistory, statRanks, honorsFor } from '../src/honors.js';

test('CSV fields in quotes keep their commas', () => {
  assert.deepEqual(splitCsvLine('a,"x,y,z",3,"say ""hi"""'), ['a', 'x,y,z', '3', 'say "hi"']);
});

test('season stats read past a quoted headshot link', () => {
  const head = 'player_display_name,position_group,headshot_url,recent_team,def_sacks,def_tackles_solo,def_tackle_assists,def_interceptions';
  const [row] = parseStats(`${head}\nT.J. Watt,LB,"https://x/f_auto,q_auto/a",PIT,22.5,50,14,0`);
  assert.equal(row.stats.def_sacks, 22.5);
  assert.equal(row.stats.tackles, 64);
  assert.equal(row.stats.def_interceptions, 0);
});

const tl = (pcts) => pcts.map((pct, i) => ({ week: i + 1, pct }));

test('injuries: each stretch of missed games, named by the report, same kind together', () => {
  const reports = [
    { week: 2, injury: 'Hamstring', status: 'Doubtful' },
    { week: 4, injury: 'Hamstring', status: 'Questionable' },
    { week: 6, injury: 'hamstring', status: 'Out' },
    { week: 9, injury: 'Ankle', status: 'Out' },
  ];
  const out = injuryHistory(tl([80, null, 70, 75, 60, null, null, 80, null]), reports);
  assert.deepEqual(out, [{ type: 'Hamstring', weeks: [1, 2] }, { type: 'Ankle', weeks: [1], out: true }]);
});

test('injuries: a stretch with no report of its own takes the one just before it, or one during it', () => {
  // Out from the opener (on a list that keeps him off the report), first listed Week 5.
  assert.deepEqual(injuryHistory(tl([null, null, null, null, null, 67]), [{ week: 5, injury: 'Achilles', status: 'Out' }]), [{ type: 'Achilles', weeks: [5] }]);
  // Went on IR after Week 3's report and drops off it.
  assert.deepEqual(injuryHistory(tl([90, 90, 40, null, null, 85]), [{ week: 3, injury: 'Knee', status: 'Questionable' }]), [{ type: 'Knee', weeks: [2] }]);
});

test('injuries: missed games with no injury reported (resting, not signed yet) aren’t injuries', () => {
  assert.deepEqual(injuryHistory(tl([null, null, 80, null, 90]), [{ week: 4, injury: 'Not injury related - resting player', status: 'Out' }]), []);
});

test('stat ranks: his side’s stats where he’s top 10, ties shared', () => {
  const row = (name, group, stats) => ({ name, group, stats: { rushing_yards: 0, rushing_tds: 0, receptions: 0, ...stats } });
  const rows = [
    row('Big Back', 'RB', { rushing_yards: 900, rushing_tds: 9 }),
    row('Jahmyr Gibbs', 'RB', { rushing_yards: 847, rushing_tds: 9, receptions: 3 }),
    ...Array.from({ length: 12 }, (_, i) => row(`Pass Catcher ${i}`, 'WR', { receptions: 40 + i })),
  ];
  assert.deepEqual(statRanks(rows, 'Jahmyr Gibbs', 'O'), [
    { stat: 'Rush yds', rank: 2, tied: false, value: 847 },
    { stat: 'Rush TD', rank: 1, tied: true, value: 9 },
  ].sort((a, b) => a.rank - b.rank));
  // A namesake on the other side of the ball isn't him.
  assert.deepEqual(statRanks(rows, 'Jahmyr Gibbs', 'D'), []);
});

test('honors are looked up by name and side of the ball', () => {
  const garrett = honorsFor('Myles Garrett', 'D');
  assert.ok(garrett.ap.includes(2023));
  assert.ok(garrett.top100.length > 0);
  assert.deepEqual(honorsFor('Myles Garrett', 'O').ap, []);
});
