// A daily cap on paid Odds API calls for lines (3 credits per refresh), as a
// backstop to the 11 AM / 6 PM schedule in app.js: 16 credits a day, 30 on
// Sundays. Props have their own monthly reserve instead. The free plan's 500
// a month is a hard stop on The Odds API's side, never a charge. The day
// resets at midnight Eastern.

export const LINES_COST = 3;
export const SCORES_COST = 2;

export const easternDate = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export const easternWeekday = (now = new Date()) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(now);

// Today's credit limit: the Sunday limit on Sundays (Eastern), else the daily one.
export function limitFor(now, { daily, sunday }) {
  return easternWeekday(now) === 'Sun' ? sunday : daily;
}

export function creditsUsedToday(data, now = new Date()) {
  return data.creditsUsed?.[easternDate(now)] ?? 0;
}

export function canSpend(data, cost, limit, now = new Date()) {
  return creditsUsedToday(data, now) + cost <= limit;
}

// Record credits spent today and forget days older than a week.
export function spend(data, cost, now = new Date()) {
  const today = easternDate(now);
  data.creditsUsed ??= {};
  data.creditsUsed[today] = (data.creditsUsed[today] ?? 0) + cost;
  for (const day of Object.keys(data.creditsUsed)) {
    if (day < easternDate(new Date(now.getTime() - 7 * 24 * 3600e3))) delete data.creditsUsed[day];
  }
}

export function refreshesLeftToday(data, limit, now = new Date()) {
  return Math.max(0, Math.floor((limit - creditsUsedToday(data, now)) / LINES_COST));
}
