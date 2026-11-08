// The back of each heat map card: age, injuries that cost games this season,
// honors (AP and NFLPA All-Pro, MVP and other awards, the NFL Top 100) and
// stat leaders, both this season's top 10 and league titles from the last 5.
// History comes from src/honors-data.js (made by scripts/build-honors.js);
// this season's injuries and stats come from nflverse's free weekly data.
import { byName, awards } from './honors-data.js';
import { fullKey } from './starters.js';
import { STATS, parseCsv, parseStats, sideOf } from './nflstats.js';


// Where a player ranks in the league in each stat that matters for his side,
// keeping the top 10 (ties share a rank: "T-3").
export function statRanks(rows, name, side) {
  const key = fullKey(name);
  const me = rows.find((r) => fullKey(r.name) === key && sideOf(r.group) === side);
  if (!me) return [];
  const out = [];
  for (const [k, label, s] of STATS) {
    const mine = me.stats[k];
    if (s !== side || !(mine > 0)) continue;
    const ahead = rows.filter((r) => r.stats[k] > mine).length;
    if (ahead >= 10) continue;
    const tied = rows.filter((r) => r.stats[k] === mine).length > 1;
    out.push({ stat: label, rank: ahead + 1, tied, value: Math.round(mine * 10) / 10 });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// Injury types as the reports write them, tidied: "hamstring" -> "Hamstring".
const tidy = (s) => s.trim().replace(/^./, (c) => c.toUpperCase());
const notInjury = (s) => !s || /not injury related|resting|personal/i.test(s);

// Injuries that cost him games this season: each stretch of missed games
// (from the snap timeline: a game the team played that he didn't), named by
// the injury report during it, or the last one just before it. Stretches of
// the same injury go together. [{ type, weeks: [games missed, per stretch], out: still out }]
// `reports` are his weekly injury report rows: { week, injury, status }.
export function injuryHistory(timeline, reports) {
  if (!timeline?.length) return [];
  const byWeek = new Map(reports.filter((r) => !notInjury(r.injury)).map((r) => [r.week, r]));
  const stretches = [];
  let run = null;
  for (const t of timeline) {
    if (t.pct == null) (run ??= []).push(t.week);
    else if (run) stretches.push(run), (run = null);
  }
  const ongoing = run;
  if (run) stretches.push(run);
  const out = [];
  for (const weeks of stretches) {
    // Before his first game this season with nothing on the report: likely
    // not on the team yet (signed later), so nothing to say.
    const during = weeks.map((w) => byWeek.get(w)).filter(Boolean);
    const before = [...byWeek.values()].filter((r) => r.week < weeks[0] && r.week >= weeks[0] - 2).sort((a, b) => b.week - a.week)[0];
    const named = during.find((r) => r.status === 'Out' || r.status === 'Doubtful') ?? during[0] ?? before;
    if (!named) continue;
    const type = tidy(named.injury);
    let item = out.find((x) => x.type === type);
    if (!item) out.push((item = { type, weeks: [] }));
    item.weeks.push(weeks.length);
    if (weeks === ongoing) item.out = true;
  }
  return out;
}

// Every player's weekly injury report rows this season, by cleaned-up name.
export function parseInjuries(text) {
  const out = new Map();
  for (const r of parseCsv(text)) {
    if (r.season_type !== 'REG') continue;
    const key = fullKey(r.full_name);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({ team: r.team, week: Number(r.week), injury: r.report_primary_injury || r.practice_primary_injury, status: r.report_status });
  }
  return out;
}

// His honors: AP and NFLPA first-team All-Pro seasons, awards, Top 100
// ranks (the last 4 lists) and stat titles (the last 5 seasons).
export function honorsFor(name, side, espnId) {
  const mine = (byName[fullKey(name)] ?? []).find((p) => p.side === side) ?? {};
  return {
    ap: mine.ap ?? [], nflpa: mine.nflpa ?? [], top100: mine.top100 ?? [], titles: mine.titles ?? [],
    awards: (espnId && awards[espnId]) || [],
  };
}

// This season's files, kept for a few hours like the snap counts, with one
// download shared by everyone asking at once.
const NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download';
const FILES = {
  stats: (season) => `${NFLVERSE}/stats_player/stats_player_reg_${season}.csv`,
  injuries: (season) => `${NFLVERSE}/injuries/injuries_${season}.csv`,
};
const PARSE = { stats: parseStats, injuries: parseInjuries };
const cache = new Map();
const loading = new Map();
const TTL = 6 * 3600e3;
export async function seasonFile(kind, now = new Date()) {
  const season = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  const key = `${kind}-${season}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL) return hit.data;
  if (!loading.has(key)) {
    loading.set(key, (async () => {
      const res = await fetch(FILES[kind](season), { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`nflverse ${kind} returned ${res.status}`);
      const data = PARSE[kind](await res.text());
      cache.set(key, { at: now.getTime(), data });
      return data;
    })().finally(() => loading.delete(key)));
  }
  return loading.get(key);
}
