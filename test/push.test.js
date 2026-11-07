import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageFor, recipientsFor, sendEvent, defaultPrefs, addToInbox, INBOX_SIZE, remindersDue } from '../src/push.js';

const players = ['Daniel', 'Asher', 'Matt'];

test('who hears about what', () => {
  // A new post goes to everyone else; the rest only to the others in the bet.
  assert.deepEqual(recipientsFor({ type: 'posted', actor: 'Matt', stakes: { Matt: 10 } }, players), ['Daniel', 'Asher']);
  assert.deepEqual(recipientsFor({ type: 'joined', actor: 'Asher', stakes: { Matt: 10, Asher: 5 } }, players), ['Matt']);
  assert.deepEqual(recipientsFor({ type: 'placed', actor: 'Daniel', stakes: { Matt: 10, Asher: 5, Daniel: 10 } }, players), ['Matt', 'Asher']);
  // Viewers (not players) never get pushes.
  assert.deepEqual(recipientsFor({ type: 'posted', actor: 'Matt', stakes: {} }, ['Matt']), []);
});

test('what the notifications say', () => {
  const posted = messageFor({ type: 'posted', actor: 'Matt', name: "Matt's Parlay 2", summary: '3-leg parlay at +450', amount: 10, league: 'nfl' });
  assert.equal(posted.title, "Matt posted Matt's Parlay 2");
  assert.match(posted.body, /3-leg parlay at \+450\. \$10\.00 in so far/);
  assert.equal(messageFor({ type: 'joined', actor: 'Asher', name: 'X', amount: 5, total: 15, league: 'cfb' }).title, 'CFB · Asher is in on X');
  assert.match(messageFor({ type: 'placed', actor: 'Daniel', name: 'X', payout: 126.56 }).body, /pays \$126\.56/);
  assert.match(messageFor({ type: 'paid', actor: 'Daniel', name: 'X', shares: { Matt: 42.19 } }, 'Matt').body, /Your share: \$42\.19/);
});

test('sends per person and setting, and reports dead devices', async () => {
  const sent = [];
  const send = async (sub, payload) => {
    if (sub.endpoint === 'gone') throw Object.assign(new Error('gone'), { statusCode: 410 });
    sent.push([sub.endpoint, JSON.parse(payload)]);
  };
  const subs = { Daniel: [{ endpoint: 'd1' }, { endpoint: 'gone' }], Asher: [{ endpoint: 'a1' }], Matt: [{ endpoint: 'm1' }] };
  const prefs = { Asher: { ...defaultPrefs(), posted: false } };
  const gone = await sendEvent({ type: 'posted', actor: 'Matt', name: 'P', id: 'custom:Matt:1', url: '/?parlay=x', summary: 's', amount: 10 }, { players, subs, prefs, send });
  assert.deepEqual(sent.map(([e]) => e), ['d1']); // Asher turned new posts off; Matt posted it
  assert.equal(sent[0][1].url, '/?parlay=x');
  assert.deepEqual(gone, ['gone']);
});

test('in-app list: everyone it is for, newest first, capped', () => {
  const players = ['Daniel', 'Asher', 'Matt'];
  const inbox = {};
  addToInbox(inbox, { type: 'posted', actor: 'Asher', name: 'Sunday 3-leg', summary: '3 legs', amount: 10, url: '/?parlay=a' }, players, 1);
  addToInbox(inbox, { type: 'joined', actor: 'Matt', name: 'Sunday 3-leg', amount: 5, total: 15, stakes: { Asher: 10, Matt: 5 }, url: '/?parlay=a' }, players, 2);
  assert.deepEqual(Object.keys(inbox).sort(), ['Asher', 'Daniel', 'Matt']);
  assert.equal(inbox.Daniel.length, 1); // not in the bet, so no "joined"
  assert.equal(inbox.Asher[0].type, 'joined');
  assert.equal(inbox.Asher[0].at, 2);
  assert.equal(inbox.Asher[0].url, '/?parlay=a');
  for (let i = 0; i < INBOX_SIZE + 5; i++) addToInbox(inbox, { type: 'posted', actor: 'Asher', name: `p${i}`, summary: 'x', amount: 1 }, players, 10 + i);
  assert.equal(inbox.Daniel.length, INBOX_SIZE);
  assert.equal(inbox.Daniel[0].title, `Asher posted p${INBOX_SIZE + 4}`);
});

test('game reminders: due 30-35 min out, live bets with money only, once', () => {
  const now = Date.parse('2026-11-08T17:30:00Z');
  const at = (min) => new Date(now + min * 60e3).toISOString();
  const games = [
    { id: 'g1', commence: at(33), away: 'Jaguars', home: 'Ravens' },
    { id: 'g2', commence: at(33), away: 'Bills', home: 'Jets' },
    { id: 'g3', commence: at(50), away: 'Rams', home: 'Seahawks' }, // too early to remind
    { id: 'g4', commence: at(31), away: 'Bears', home: 'Lions' }, // only in a lost bet
    { id: 'g5', commence: at(-5), away: 'Colts', home: 'Texans' }, // already started
  ];
  const bets = [
    { id: 'b1', name: 'Sunday Ladder', placed: { by: 'Daniel' }, status: 'pending', legs: [{ gameId: 'g1' }, { gameId: 'g3' }] },
    { id: 'b2', name: 'Bills ML', placed: null, status: 'pending', legs: [{ gameId: 'g2' }, { gameId: 'g5' }] },
    { id: 'b3', name: 'Dead one', placed: { by: 'Daniel' }, status: 'lost', legs: [{ gameId: 'g4' }] },
  ];
  const due = remindersDue(games, bets, {}, now);
  assert.deepEqual(due.gameIds, ['g1', 'g2']);
  assert.equal(due.minutes, 33);
  assert.deepEqual(due.bets.map((b) => b.name), ['Bills ML', 'Sunday Ladder']); // not placed first
  const msg = messageFor({ type: 'reminder', ...due }, 'Daniel');
  assert.equal(msg.title, '2 of your games start in 33 min');
  assert.equal(msg.body, 'Jaguars @ Ravens, Bills @ Jets. Not placed yet: Bills ML. Placed: Sunday Ladder.');
  // Already sent: nothing more until the next game.
  assert.equal(remindersDue(games, bets, { g1: true, g2: true }, now), null);
  // One game, all placed.
  const one = remindersDue(games, bets, { g2: true }, now);
  assert.deepEqual(messageFor({ type: 'reminder', league: 'cfb', ...one }, 'Daniel'),
    { title: 'CFB · Jaguars @ Ravens starts in 33 min', body: 'Placed: Sunday Ladder.' });
  // Only the people it's addressed to.
  assert.deepEqual(recipientsFor({ type: 'reminder', to: ['Daniel'] }, ['Daniel', 'Asher', 'Matt']), ['Daniel']);
});
