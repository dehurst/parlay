// When the app may spend Odds API credits. Lines are pointless once the
// week's last game kicks off, and next week's lines aren't worth paying for
// until Wednesday evening, so paid calls pause from the last kickoff
// (normally Monday night) until Wednesday 7:00 PM Eastern.

const DAY = 24 * 60 * 60 * 1000;
const RESUME_HOUR = 19; // 7 PM Eastern

const easternHour = (d) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(d));

// The UTC instant for a wall-clock time in Eastern (handles EDT and EST).
export function easternTime(year, month, day, hour, minute = 0) {
  for (const offset of [4, 5]) {
    const t = new Date(Date.UTC(year, month, day, hour + offset, minute));
    if (easternHour(t) === hour) return t;
  }
  return new Date(Date.UTC(year, month, day, hour + 5, minute));
}

// Wednesday 7 PM Eastern of the week starting at `start` (a Tuesday).
function wednesdayEvening(start) {
  const wed = new Date(start.getTime() + DAY);
  return easternTime(wed.getUTCFullYear(), wed.getUTCMonth(), wed.getUTCDate(), RESUME_HOUR);
}

// { paused, until } for this week's window and games.
export function creditPause(win, games, now = new Date()) {
  const resume = wednesdayEvening(win.start);
  if (now < resume) return { paused: true, until: resume };
  const lastKickoff = Math.max(0, ...games.map((g) => new Date(g.commence).getTime()));
  if (lastKickoff && now.getTime() >= lastKickoff) {
    return { paused: true, until: wednesdayEvening(new Date(win.start.getTime() + 7 * DAY)) };
  }
  return { paused: false, until: null };
}
