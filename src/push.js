import { setVapidDetails, sendNotification } from 'web-push';

// Push notifications to phones (iPhone: the Home Screen app, iOS 16.4+) and
// browsers. Turned on by the VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY settings.
// Who gets what comes from what people do in the app:
//   posted  - someone posts a parlay or straight bet (everyone else)
//   joined  - someone puts money on a bet you're in (the others in it)
//   placed  - a bet you're in is marked placed (the others in it)
//   paid    - you've been paid out on a bet (the others in it)

export const EVENTS = {
  posted: 'New parlays and bets',
  joined: 'Someone joins a bet you’re in',
  placed: 'A bet you’re in gets placed',
  paid: 'You’ve been paid out',
};

export const defaultPrefs = () => Object.fromEntries(Object.keys(EVENTS).map((k) => [k, true]));

export function setupPush({ VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT }) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  setVapidDetails(VAPID_SUBJECT || 'https://parlay-one.vercel.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return true;
}

const money = (n) => `$${Number(n).toFixed(2)}`;

// The notification for an event: { title, body }. `who` is the person it's
// for (paid shows their share). `league` is 'nfl' or 'cfb'.
export function messageFor(event, who) {
  const tag = event.league === 'cfb' ? 'CFB · ' : '';
  const { actor, name } = event;
  switch (event.type) {
    case 'posted':
      return { title: `${tag}${actor} posted ${name}`, body: `${event.summary}. ${money(event.amount)} in so far. Tap to see it or join.` };
    case 'joined':
      return { title: `${tag}${actor} is in on ${name}`, body: `${money(event.amount)} from ${actor} · ${money(event.total)} total now.` };
    case 'placed':
      return { title: `${tag}${name} is placed`, body: event.payout ? `${actor} placed it: pays ${money(event.payout)} if it hits.` : `${actor} placed it.` };
    case 'paid':
      return { title: `${tag}Paid out: ${name}`, body: `${actor} marked it paid.${event.shares?.[who] ? ` Your share: ${money(event.shares[who])}.` : ''}` };
    default:
      return null;
  }
}

// Who an event is for: everyone but the person who did it, limited to the
// people in the bet for anything but a new post.
export function recipientsFor(event, players) {
  const pool = event.type === 'posted' ? players : Object.keys(event.stakes ?? {});
  return pool.filter((p) => p !== event.actor && players.includes(p));
}

// The in-app list: one entry per person the event is for (whatever their
// push settings), newest first, keeping the last INBOX_SIZE each.
export const INBOX_SIZE = 50;
export function addToInbox(inbox, event, players, at = Date.now()) {
  for (const who of recipientsFor(event, players)) {
    const msg = messageFor(event, who);
    if (!msg) continue;
    const list = (inbox[who] ??= []);
    list.unshift({ ...msg, type: event.type, url: event.url, at });
    list.length = Math.min(list.length, INBOX_SIZE);
  }
  return inbox;
}

// Send an event to everyone it's for, per their settings. `subs` is
// { player: [subscription] }, `prefs` is { player: { posted: true, ... } }.
// Returns the endpoints that are gone (uninstalled or turned off), to forget.
export async function sendEvent(event, { players, subs, prefs, send = (s, payload) => sendNotification(s, payload, { TTL: 6 * 3600 }) }) {
  const gone = [];
  const jobs = [];
  for (const who of recipientsFor(event, players)) {
    if (!(prefs[who] ?? defaultPrefs())[event.type]) continue;
    const msg = messageFor(event, who);
    if (!msg) continue;
    const payload = JSON.stringify({ ...msg, url: event.url, tag: `${event.type}:${event.id}` });
    for (const sub of subs[who] ?? []) {
      jobs.push(send(sub, payload).catch((err) => {
        if (err?.statusCode === 404 || err?.statusCode === 410) gone.push(sub.endpoint);
        else console.error(`Push to ${who} failed: ${err?.statusCode ?? ''} ${err?.message ?? err}`);
      }));
    }
  }
  // Don't hold the request up for long on a slow push service.
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, 4000))]);
  return gone;
}
