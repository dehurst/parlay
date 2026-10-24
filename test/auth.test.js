import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogins, checkLogin, makeToken, readToken, cookieValue, sessionCookie } from '../src/auth.js';

const players = ['Daniel', 'Asher', 'Matt'];

test('logins map usernames to players and check passwords', () => {
  const logins = parseLogins('matt:pw-m, daniel:pw-d,asher:pw:with:colons,bob:x', players);
  assert.equal(logins.size, 3); // bob isn't a player
  assert.equal(checkLogin(logins, 'MATT ', 'pw-m'), 'Matt');
  assert.equal(checkLogin(logins, 'asher', 'pw:with:colons'), 'Asher');
  assert.equal(checkLogin(logins, 'matt', 'pw-d'), null);
  assert.equal(checkLogin(logins, 'nobody', 'pw-m'), null);
  assert.equal(parseLogins('', players).size, 0);
});

test('sessions are signed and expire', () => {
  const now = Date.now();
  const token = makeToken('Matt', 'secret', now);
  assert.equal(readToken(token, 'secret', now), 'Matt');
  assert.equal(readToken(token, 'other-secret', now), null);
  const [, exp, sig] = token.split('.');
  assert.equal(readToken(`${Buffer.from('Daniel').toString('base64url')}.${exp}.${sig}`, 'secret', now), null); // can't swap the name
  assert.equal(readToken(token, 'secret', now + 61 * 24 * 3600e3), null); // 60 days
  assert.equal(cookieValue('a=1; parlay_session=abc%2Edef; b=2', 'parlay_session'), 'abc.def');
  assert.match(sessionCookie('t'), /HttpOnly; SameSite=Lax; Secure/);
  assert.match(sessionCookie(null), /Max-Age=0/);
});
