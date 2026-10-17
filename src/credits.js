// A daily budget for paid Odds API calls. The free plan has 500 credits a
// month; 16 a day keeps a 31-day month under that (31 x 16 = 496). Lines cost
// 3 credits per refresh (spreads + totals + moneylines), so that's 5 a day.
// The day resets at midnight Eastern.

export const LINES_COST = 3;
export const SCORES_COST = 2;

export const easternDate = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

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
