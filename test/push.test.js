import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageFor, recipientsFor, sendEvent, defaultPrefs } from '../src/push.js';

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
