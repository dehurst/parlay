import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnaps, findPlayer, starterHistory, teamCode } from '../src/starters.js';

const HEAD = 'game_id,pfr_game_id,season,game_type,week,player,pfr_player_id,position,team,opponent,offense_snaps,offense_pct,defense_snaps,defense_pct,st_snaps,st_pct';
// [week, name, id, pos, team, off%, def%]
const csv = (rows) => [HEAD, ...rows.map(([w, n, id, pos, team, o, d]) => `g,g,2026,REG,${w},${n},${id},${pos},${team},X,0,${o},0,${d},0,0`)].join('\n');

const teams = parseSnaps(csv([
  // QB: the Week 1 starter got hurt, the backup took over.
  [1, 'Vet Passer', 'vp', 'QB', 'BUF', 1, 0], [2, 'Vet Passer', 'vp', 'QB', 'BUF', 1, 0],
  [1, 'Back Up', 'bu', 'QB', 'BUF', 0, 0], [3, 'Back Up', 'bu', 'QB', 'BUF', 1, 0], [4, 'Back Up', 'bu', 'QB', 'BUF', 1, 0],
  // CB: a rookie passed a healthy veteran, who still plays a little.
  [1, 'Old Corner', 'oc', 'CB', 'BUF', 0, 0.9], [2, 'Old Corner', 'oc', 'CB', 'BUF', 0, 0.9], [4, 'Old Corner', 'oc', 'CB', 'BUF', 0, 0.2],
  [1, 'Rookie Corner', 'rc', 'CB', 'BUF', 0, 0.1], [3, 'Rookie Corner', 'rc', 'CB', 'BUF', 0, 0.9], [4, 'Rookie Corner', 'rc', 'CB', 'BUF', 0, 0.95],
  // LT: started every game, listed under a new first name later.
  [1, 'DeAundre Tackle', 'dt', 'T', 'BUF', 1, 0], [2, 'DeAundre Tackle', 'dt', 'T', 'BUF', 1, 0],
  [3, 'Dee Tackle', 'dt', 'T', 'BUF', 1, 0], [4, 'Dee Tackle', 'dt', 'T', 'BUF', 1, 0],
  // TE: started Week 1, hurt Weeks 2-3, back for Week 4.
  [1, 'Tight End', 'te', 'TE', 'BUF', 0.8, 0], [4, 'Tight End', 'te', 'TE', 'BUF', 0.85, 0],
  // RB: listed first but splits carries.
  [1, 'Split Back', 'sb', 'RB', 'BUF', 0.3, 0], [2, 'Split Back', 'sb', 'RB', 'BUF', 0.3, 0],
  [3, 'Split Back', 'sb', 'RB', 'BUF', 0.35, 0], [4, 'Split Back', 'sb', 'RB', 'BUF', 0.3, 0],
  // Traded: played for Miami earlier.
  [1, 'Moved Guard', 'mg', 'G', 'MIA', 1, 0],
]));
const hist = (name, opts) => starterHistory(teams, 'BUF', { name, skipped: [] }, opts);

test('snap counts group by player id, so a renamed player stays one player', () => {
  assert.equal(teams.BUF.players.filter((p) => p.names.has('Dee Tackle')).length, 1);
  assert.equal(findPlayer(teams.BUF, 'Dee Tackle').pct[1], 1);
  assert.deepEqual(teams.BUF.weeks, [1, 2, 3, 4]);
});

test('a starter in every game since Week 1, with each week’s snaps', () => {
  const h = hist('Dee Tackle');
  assert.equal(h.tag, 'week1');
  assert.equal(h.since, 1);
  assert.deepEqual(h.timeline, [{ week: 1, pct: 100 }, { week: 2, pct: 100 }, { week: 3, pct: 100 }, { week: 4, pct: 100 }]);
});

test('a starter who missed games and came back', () => {
  const h = hist('Tight End');
  assert.equal(h.tag, 'back');
  assert.equal(h.since, 4);
  assert.deepEqual(h.missed, [2, 3]);
  assert.equal(h.timeline[1].pct, null);
});

test('a listed starter playing well under half the snaps is part-time', () => {
  assert.equal(hist('Split Back').tag, 'part');
});

test('a backup filling in for an injured starter', () => {
  const h = hist('Back Up', { injuries: new Map([['Vet Passer', 'Injured Reserve']]), roster: ['Vet Passer', 'Back Up'] });
  assert.equal(h.tag, 'fillin');
  assert.equal(h.since, 3);
  assert.equal(h.replaced, 'Vet Passer');
  assert.equal(h.replacedStatus, 'Injured Reserve');
});

test('a player who passed a healthy veteran earned the job', () => {
  const h = hist('Rookie Corner', { roster: ['Old Corner', 'Rookie Corner'] });
  assert.equal(h.tag, 'earned');
  assert.equal(h.since, 3);
  assert.equal(h.replaced, 'Old Corner');
});

test('someone still starting elsewhere on the side is not the one replaced', () => {
  assert.equal(hist('Rookie Corner', { roster: ['Old Corner'], starters: ['Old Corner', 'Rookie Corner'] }).tag, 'new');
});

test('listed behind a sidelined player counts as a fill-in', () => {
  const h = starterHistory(teams, 'BUF', { name: 'Back Up', skipped: [{ name: 'Vet Passer', status: 'Out' }] });
  assert.equal(h.tag, 'fillin');
  assert.equal(h.replacedStatus, 'Out');
});

test('a player who was on another team this season is new', () => {
  assert.deepEqual(hist('Moved Guard'), { tag: 'new', from: 'MIA' });
});

test('unknown players and teams give no tag', () => {
  assert.equal(hist('Nobody Here'), null);
  assert.equal(starterHistory(teams, 'KC', { name: 'Dee Tackle', skipped: [] }), null);
});

test('team codes come from nicknames', () => {
  assert.equal(teamCode('Los Angeles Rams'), 'LA');
  assert.equal(teamCode('San Francisco 49ers'), 'SF');
});

test('a starter just back from missing games is back, even on light snaps', () => {
  const t = parseSnaps(csv([
    [1, 'Star Back', 'sb', 'RB', 'PHI', 0.71, 0], [2, 'Star Back', 'sb', 'RB', 'PHI', 0.72, 0],
    [3, 'Star Back', 'sb', 'RB', 'PHI', 0.07, 0], [6, 'Star Back', 'sb', 'RB', 'PHI', 0.15, 0],
    [4, 'Other', 'o', 'QB', 'PHI', 1, 0], [5, 'Other', 'o', 'QB', 'PHI', 1, 0],
  ]));
  const h = starterHistory(t, 'PHI', { name: 'Star Back', skipped: [] });
  assert.equal(h.tag, 'back');
  assert.deepEqual(h.missed, [3, 4, 5, 6]);
});

test('each lost job goes to only one replacement', () => {
  const taken = new Set();
  const first = starterHistory(teams, 'BUF', { name: 'Rookie Corner', skipped: [] }, { roster: ['Old Corner'], taken });
  assert.equal(first.replaced, 'Old Corner');
  assert.ok(taken.has('Old Corner'));
  const again = starterHistory(teams, 'BUF', { name: 'Rookie Corner', skipped: [] }, { roster: ['Old Corner'], taken });
  assert.equal(again.tag, 'new');
});
