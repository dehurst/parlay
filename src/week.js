// An NFL "week" here runs Tuesday 12:00 UTC -> next Tuesday 12:00 UTC,
// so Thursday, Sunday, and Monday games all land in the same week.
const DAY = 24 * 60 * 60 * 1000;

export function weekWindow(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  // Walk back to the most recent Tuesday noon UTC.
  while (d.getUTCDay() !== 2 || d > now) d.setTime(d.getTime() - DAY);
  const start = d;
  const end = new Date(start.getTime() + 7 * DAY);
  return { key: start.toISOString().slice(0, 10), start, end };
}

// Week 1 of the regular season starts the Tuesday before the opening Thursday.
// SEASON_START can override it (YYYY-MM-DD, a Tuesday).
export function weekLabel(window, seasonStart = process.env.SEASON_START) {
  const start = seasonStart ? new Date(`${seasonStart}T12:00:00Z`) : defaultSeasonStart(window.start);
  const n = Math.floor((window.start - start) / (7 * DAY)) + 1;
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
