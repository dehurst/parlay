import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSport } from '../src/sport.js';
import { matchKey, makeGame, parseScoreboard } from '../src/schedule.js';
import { weekLabel } from '../src/week.js';

const board = {
  events: [
    { date: '2026-10-31T16:00Z', competitions: [{ competitors: [
      { homeAway: 'home', team: { displayName: 'Georgia Bulldogs', shortDisplayName: 'Georgia', conferenceId: '8' } },
      { homeAway: 'away', team: { displayName: 'Florida Gators', shortDisplayName: 'Florida', conferenceId: '8' } },
    ] }] },
    { date: '2026-10-31T16:00Z', competitions: [{ competitors: [
      { homeAway: 'home', team: { displayName: 'Notre Dame Fighting Irish', shortDisplayName: 'Notre Dame', conferenceId: '18' } },
      { homeAway: 'away', team: { displayName: 'Navy Midshipmen', shortDisplayName: 'Navy', conferenceId: '151' } },
    ] }] },
  ],
};

test('college keeps only Power 5 games and uses school names', () => {
  const games = runInSport('cfb', () => parseScoreboard(board, '2026-10-27'));
  assert.deepEqual(games.map((g) => `${g.awayShort}@${g.homeShort}`), ['Florida@Georgia']);
  // The NFL has no conference filter.
  assert.equal(parseScoreboard(board, '2026-10-27').length, 2);
});

test('college tells apart teams with the same nickname', () => {
  const [a, b] = runInSport('cfb', () => [matchKey('LSU Tigers', 'Clemson Tigers'), matchKey('Auburn Tigers', 'Clemson Tigers')]);
  assert.notEqual(a, b);
  assert.equal(matchKey('LSU Tigers', 'Clemson Tigers'), 'tigers@tigers'); // NFL keys by nickname
  const id = runInSport('cfb', () => makeGame({ weekKey: 'w', home: 'San José State Spartans', away: 'X', commence: 0 }).id);
  assert.match(id, /sanjosestatespartans$/);
});

test('college weeks run one ahead of the NFL', () => {
  const win = { key: '2026-10-27' };
  assert.equal(weekLabel(win, '2026-09-08'), 'Week 8');
  assert.equal(runInSport('cfb', () => weekLabel(win, '2026-09-08')), 'Week 9');
});
