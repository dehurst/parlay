import { setVapidDetails, sendNotification } from 'web-push';

// Push notifications to phones (iPhone: the Home Screen app, iOS 16.4+) and
// browsers. Turned on by the VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY settings.
// Who gets what comes from what people do in the app:
//   posted  - someone posts a parlay or straight bet (everyone else)
//   joined  - someone puts money on a bet you're in (the others in it)
//   placed  - a bet you're in is marked placed (the others in it)
//   paid    - you've been paid out on a bet (the others in it)
//   status  - a Q/D player in a game we bet on is ruled active or inactive
//              (everyone)
//   reminder - a game in a bet with money on it starts in ~30 min (only the
//              people in REMINDER_PLAYERS; sent by the /api/reminders check)

export const EVENTS = {
  posted: 'New parlays and bets',
  joined: 'Someone joins a bet you’re in',
  placed: 'A bet you’re in gets placed',
  paid: 'You’ve been paid out',
  status: 'Questionable/Doubtful players ruled active or inactive (games we bet on)',
};

// Only shown to the people who get game reminders.
export const REMINDER_EVENT = { reminder: 'Game starting in 30 min (bets with money on them)' };

export const defaultPrefs = () => Object.fromEntries(Object.keys({ ...EVENTS, ...REMINDER_EVENT }).map((k) => [k, true]));

export function setupPush({ VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT }) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  setVapidDetails(VAPID_SUBJECT || 'https://parlay-one.vercel.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return true;
}

const money = (n) => `$${Number(n).toFixed(2)}`;

// What one person's stake pays if a bet hits: their part of the sportsbook's
// payout, or of the estimate (stake × odds) when no payout was entered.
function yourShare(event, who) {
  const mine = event.stakes?.[who];
  const total = Object.values(event.stakes ?? {}).reduce((a, b) => a + b, 0);
  if (!mine || !total) return '';
  const pays = event.payout ? (event.payout * mine) / total : event.decimal ? mine * event.decimal : null;
  if (!pays) return '';
  return ` Your ${money(mine)} pays ${event.payout ? '' : 'about '}${money(pays)} if it hits (${money(pays - mine)} profit).`;
}

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
      return { title: `${tag}${name} is placed`, body: `${actor} placed it.${yourShare(event, who)}` };
    case 'reminder': {
      const unplaced = event.bets.filter((b) => !b.placed).map((b) => b.name);
      const placed = event.bets.filter((b) => b.placed).map((b) => b.name);
      const when = `start${event.games.length === 1 ? 's' : ''} in ${event.minutes} min`;
      const title = event.games.length === 1 ? `${tag}${event.games[0]} ${when}` : `${tag}${event.games.length} of your games ${when}`;
      const parts = [];
      if (event.games.length > 1) parts.push(`${event.games.join(', ')}.`);
      if (unplaced.length) parts.push(`Not placed yet: ${unplaced.join(', ')}.`);
      if (placed.length) parts.push(`Placed: ${placed.join(', ')}.`);
      return { title, body: parts.join(' ') };
    }
    case 'status': {
      // One per game: who's in, who's out.
      const line = (now) => event.players.filter((p) => p.now === now).map((p) => `${p.name} (${p.was[0]})`).join(', ');
      const out = line('Inactive');
      const active = line('Active');
      const title = `${tag}${event.game}: ${out ? `${event.players.filter((p) => p.now === 'Inactive').length} out` : 'all active'}`;
      return { title, body: [out && `Inactive: ${out}.`, active && `Active: ${active}.`].filter(Boolean).join(' ') };
    }
    case 'bank': // balance alerts: the text comes ready-made
      return { title: event.title, body: event.body };
    case 'paid':
      return { title: `${tag}Paid out: ${name}`, body: `${actor} marked it paid.${event.shares?.[who] ? ` Your share: ${money(event.shares[who])}.` : ''}` };
    default:
      return null;
  }
}

// Who an event is for: everyone but the person who did it, limited to the
// people in the bet for anything but a new post.
export function recipientsFor(event, players) {
  if (event.to) return event.to.filter((p) => players.includes(p));
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
    if ((prefs[who] ?? {})[event.type] === false) continue;
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

// Games about to start that are in a bet with money on it (still live), and
// haven't been reminded about yet. `games` are { id, commence, away, home },
// `bets` are { id, name, placed, status, legs: [{ gameId }] }, `sent` is
// { gameId: true }. Due once kickoff is within `windowMs` (35 min, so a check
// every 5 min lands 30-35 min before).
export const REMIND_WINDOW = 35 * 60e3;
export function remindersDue(games, bets, sent, now = Date.now(), windowMs = REMIND_WINDOW) {
  const live = bets.filter((b) => b.status === 'pending');
  const due = games.filter((g) => {
    const until = new Date(g.commence).getTime() - now;
    return until > 0 && until <= windowMs && !sent[g.id] && live.some((b) => b.legs.some((l) => l.gameId === g.id));
  }).sort((a, b) => a.commence.localeCompare(b.commence));
  if (!due.length) return null;
  const ids = new Set(due.map((g) => g.id));
  const inBets = live.filter((b) => b.legs.some((l) => ids.has(l.gameId)))
    // Not placed yet first: those are the ones to act on.
    .sort((a, b) => !!a.placed - !!b.placed);
  return {
    gameIds: due.map((g) => g.id),
    games: due.map((g) => `${g.away} @ ${g.home}`),
    minutes: Math.max(1, Math.round((new Date(due[0].commence).getTime() - now) / 60e3)),
    bets: inBets.map((b) => ({ id: b.id, name: b.name, placed: !!b.placed })),
  };
}
