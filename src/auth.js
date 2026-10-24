import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

// Simple logins for the group. Usernames and passwords come from the LOGINS
// setting ("matt:pass1,daniel:pass2,..."), never the code, since the repo is
// public. A successful login sets a signed cookie naming the player.

export const COOKIE = 'parlay_session';
export const SESSION_DAYS = 60;

// "matt:matt2026,daniel:daniel2026" -> Map { 'matt' => { password, player: 'Matt' } }.
// Each username must match a player name (any capitalization).
export function parseLogins(text, players) {
  const out = new Map();
  for (const entry of String(text ?? '').split(',')) {
    const i = entry.indexOf(':');
    if (i < 1) continue;
    const user = entry.slice(0, i).trim().toLowerCase();
    const password = entry.slice(i + 1).trim();
    const player = players.find((p) => p.toLowerCase() === user);
    if (!player || !password) {
      if (user) console.error(`LOGINS: "${user}" doesn't match a player in PLAYERS, so it's skipped.`);
      continue;
    }
    out.set(user, { password, player });
  }
  return out;
}

// Compares without leaking how much matched (timing).
export function safeEqual(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

// The player for a username and password, or null.
export function checkLogin(logins, username, password) {
  const entry = logins.get(String(username ?? '').trim().toLowerCase());
  // Compare even when the user is unknown, so both cases take the same time.
  const ok = safeEqual(entry?.password ?? '\0no-user', String(password ?? ''));
  return entry && ok ? entry.player : null;
}

const sign = (data, secret) => createHmac('sha256', secret).update(data).digest('base64url');

// "<player>.<expires ms>.<signature>"
export function makeToken(player, secret, now = Date.now()) {
  const data = `${Buffer.from(player).toString('base64url')}.${now + SESSION_DAYS * 24 * 3600e3}`;
  return `${data}.${sign(data, secret)}`;
}

// The player a token names, if it's signed by us and not expired.
export function readToken(token, secret, now = Date.now()) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [who, expires, sig] = parts;
  if (!safeEqual(sig, sign(`${who}.${expires}`, secret))) return null;
  if (!(Number(expires) > now)) return null;
  return Buffer.from(who, 'base64url').toString();
}

export function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// The cookie header for a session (or an expired one to log out).
export function sessionCookie(token, { secure = true } = {}) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : ''].filter(Boolean);
  return token
    ? `${COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_DAYS * 24 * 3600}; ${attrs.join('; ')}`
    : `${COOKIE}=; Max-Age=0; ${attrs.join('; ')}`;
}
