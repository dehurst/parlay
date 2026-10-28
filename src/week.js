// An NFL "week" here runs Tuesday 6:00 AM Eastern -> the next Tuesday 6:00 AM
// Eastern, so Thursday, Sunday, and Monday games all land in the same week.
// The week's key is the Tuesday's date (YYYY-MM-DD).
import { sport } from './sport.js';

const DAY = 24 * 60 * 60 * 1000;
const FLIP_HOUR = 6; // 6 AM Eastern

const easternParts = (d) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month - 1, d: +parts.day, hour: +parts.hour, weekday: parts.weekday };
};

// The UTC instant for a wall-clock hour in Eastern time (handles EDT and EST).
function easternHourOn(y, m, d, hour) {
  for (const offset of [4, 5]) {
    const t = new Date(Date.UTC(y, m, d, hour + offset));
    const e = easternParts(t);
    if (e.hour === hour && e.d === new Date(Date.UTC(y, m, d)).getUTCDate()) return t;
  }
  return new Date(Date.UTC(y, m, d, hour + 5));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function weekWindow(now = new Date()) {
  // Most recent Tuesday (Eastern calendar) at 6 AM Eastern that's not in the future.
  const e = easternParts(now);
  const back = (WEEKDAYS.indexOf(e.weekday) - 2 + 7) % 7;
  let tue = new Date(Date.UTC(e.y, e.m, e.d - back));
  let start = easternHourOn(tue.getUTCFullYear(), tue.getUTCMonth(), tue.getUTCDate(), FLIP_HOUR);
  if (start > now) {
    tue = new Date(tue.getTime() - 7 * DAY);
    start = easternHourOn(tue.getUTCFullYear(), tue.getUTCMonth(), tue.getUTCDate(), FLIP_HOUR);
  }
  const next = new Date(tue.getTime() + 7 * DAY);
  const end = easternHourOn(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), FLIP_HOUR);
  return { key: tue.toISOString().slice(0, 10), start, end };
}

// Week 1 of the regular season starts the Tuesday before the opening Thursday.
// SEASON_START can override it (YYYY-MM-DD, a Tuesday). Weeks are counted by
// their Tuesday dates, so the exact flip hour doesn't matter here. College
// starts a week earlier, so its numbers run one ahead of the NFL's.
export function weekLabel(window, seasonStart = process.env.SEASON_START) {
  const tuesday = new Date(`${window.key}T12:00:00Z`);
  const start = seasonStart ? new Date(`${seasonStart}T12:00:00Z`) : defaultSeasonStart(tuesday);
  const n = Math.round((tuesday - start) / (7 * DAY)) + 1 + sport().weekOffset;
  return n >= 1 && n <= 22 ? `Week ${n}` : `Week of ${window.key}`;
}

// Opening night is the Thursday after Labor Day (first Monday of September).
function defaultSeasonStart(ref) {
  let year = ref.getUTCFullYear();
  if (ref.getUTCMonth() < 2) year -= 1; // Jan/Feb belong to the previous season
  const laborDay = new Date(Date.UTC(year, 8, 1, 12));
  while (laborDay.getUTCDay() !== 1) laborDay.setTime(laborDay.getTime() + DAY);
  return new Date(laborDay.getTime() + DAY); // Tuesday after Labor Day
}

// The most recent scheduled time at or before `now`: one of `hours` (Eastern,
// 24-hour) on one of `weekdays` (0 = Sunday). Used for "lines update at 11 AM
// and 6 PM" and "props update Thursday and Sunday at 11 AM".
export function lastSlot(now, hours, weekdays = [0, 1, 2, 3, 4, 5, 6]) {
  const e = easternParts(now);
  for (let back = 0; back <= 8; back++) {
    const day = new Date(Date.UTC(e.y, e.m, e.d - back));
    if (!weekdays.includes(day.getUTCDay())) continue;
    for (const hour of [...hours].sort((a, b) => b - a)) {
      const t = easternHourOn(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour);
      if (t <= now) return t;
    }
  }
  return null;
}

// The next scheduled time after `now` (same rules as lastSlot).
export function nextSlot(now, hours, weekdays = [0, 1, 2, 3, 4, 5, 6]) {
  const e = easternParts(now);
  for (let ahead = 0; ahead <= 8; ahead++) {
    const day = new Date(Date.UTC(e.y, e.m, e.d + ahead));
    if (!weekdays.includes(day.getUTCDay())) continue;
    for (const hour of [...hours].sort((a, b) => a - b)) {
      const t = easternHourOn(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour);
      if (t > now) return t;
    }
  }
  return null;
}
