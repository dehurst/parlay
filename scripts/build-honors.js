// Builds src/honors-data.js: the history on the back of each heat map card,
// which doesn't change during a season, so the site reads it from a file
// instead of looking it up for every card. Run it once a year, after the
// All-Pro teams, awards and Top 100 are out (and add a new NFLPA team below):
//
//   node scripts/build-honors.js
//
// Sources: Wikipedia (AP All-Pro teams, NFL Top 100, NFLPA Players' All-Pro
// teams), ESPN (MVP, OPOY, DPOY, OROY, DROY, Super Bowl MVP) and nflverse
// (each season's stat leaders).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fullKey } from '../src/starters.js';
import { STATS, parseStats, sideOf } from '../src/nflstats.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const UA = { 'user-agent': 'parlay-heatmap/1.0 (personal project; honors list)' };
// The last finished season (or pass one: node scripts/build-honors.js 2026);
// the Top 100 shown the next summer is named for the year after it.
const LAST_SEASON = Number(process.argv[2]) || new Date().getFullYear() - 1;
const ALL_PRO_FROM = LAST_SEASON - 19; // 20 seasons covers every active player
const TOP100_YEARS = [3, 2, 1, 0].map((n) => LAST_SEASON + 1 - n); // the last 4 lists
const TITLE_SEASONS = [4, 3, 2, 1, 0].map((n) => LAST_SEASON - n); // the last 5 seasons

// Wikipedia limits how fast it's asked, so one page at a time, with a pause
// and a few retries when it says to slow down.
async function wiki(page, lang = 'en') {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json&formatversion=2&redirects=1&maxlag=5`;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(attempt ? 5000 * attempt : 800);
    const text = await (await fetch(url, { headers: UA })).text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      continue; // "You are making too many requests": wait and try again
    }
    if (data.error?.code === 'maxlag') continue;
    if (!data.parse) throw new Error(`Wikipedia: no page ${page}`);
    return data.parse.wikitext;
  }
  throw new Error(`Wikipedia kept refusing ${page}`);
}

// Offense, defense or special teams, from a position as written anywhere.
function side(pos) {
  const p = String(pos).toLowerCase();
  if (/kick|punt|snap|special|core|return|\bk\b|\bp\b|\bls\b/.test(p)) return 'S';
  if (/quarter|running|full|receiver|tight|tackle(?!.*def)|guard|center|\bqb\b|\brb\b|\bfb\b|\bwr\b|\bte\b|\bot\b|\bog\b|\bol\b|\bc\b|\bg\b|\bt\b/.test(p)
    && !/defensive|nose|edge|linebacker/.test(p)) return 'O';
  return 'D';
}
// "[[Chris Jones (American football, born 1994)|Chris Jones]]" -> "Chris Jones"
const linkName = (target, label) => (label ?? target).replace(/\s*\(.*\)\s*$/, '').trim();

// AP first-team All-Pro: each player's cell in the first-team column is
// tagged with who picked him, "(AP, PFWA, TSN)"; second team is "(AP-2)".
async function apAllPro(season) {
  const text = await wiki(`${season} All-Pro Team`);
  const out = new Map();
  let pos = '';
  for (const row of text.split(/\n\|-/)) {
    // The position cell: "|[[Quarterback]]", "|align=center|[[Tight end]]" or plain "|align=center|Fullback".
    const posCell = row.match(/^\s*\n?\|(?:[^|\n[]*\|)?\s*(?:\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|([A-Za-z][A-Za-z /-]+?))\s*$/m);
    if (posCell) pos = posCell[3] ?? linkName(posCell[1], posCell[2]);
    // "[[Player]], [[Team]] (AP, PFWA)" or "[[Player]], Team Name (AP)".
    for (const m of row.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\][^[(<\n]*(?:\[\[[^\]]*\]\])?[^[(<\n]*\(([^)]*)\)/g)) {
      const tags = m[3].split(',').map((t) => t.trim());
      const name = linkName(m[1], m[2]);
      if (tags.includes('AP') && !out.has(name)) out.set(name, { name, side: side(pos) });
    }
  }
  return [...out.values()];
}

// The NFL Top 100 (voted by players, shown each summer): rank and player.
async function top100(year) {
  const text = await wiki(`NFL Top 100 Players of ${year}`);
  const table = text.slice(text.indexOf('== Top 100') >= 0 ? text.indexOf('== Top 100') : text.indexOf('!Rank'));
  const out = [];
  for (const row of table.split(/\n\|-/)) {
    const cells = row.split('\n').filter((l) => l.startsWith('|')).map((l) => l.replace(/^\|\s*/, ''));
    const rank = Number(cells[0]?.replace(/.*\|/, ''));
    const link = cells[1]?.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    const posCell = cells[2]?.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (rank >= 1 && rank <= 100 && link) out.push({ rank, name: linkName(link[1], link[2]), side: side(posCell ? linkName(posCell[1], posCell[2]) : cells[2] ?? '') });
  }
  return out;
}

// NFLPA Players' All-Pro first teams (voted by players, since the 2022
// season), from the Italian Wikipedia's page, which lists them by season.
async function nflpa() {
  const text = await wiki("NFLPA The Players' All-Pro Team", 'it');
  const out = {};
  for (const part of text.split(/\n==\s*(\d{4})\s*==/).slice(1).reduce((acc, x, i, all) => (i % 2 ? acc : [...acc, [all[i], all[i + 1]]]), [])) {
    const [season, body] = part;
    out[season] = [...body.matchAll(/^\*\s*([^:\n]+):\s*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gm)].map((m) => ({ name: linkName(m[2], m[3]), side: side(m[1]) }));
  }
  return out;
}
// Teams the page doesn't have yet: add each season's first team here as
// { name, side: 'O' | 'D' | 'S' }, e.g. 2025: [{ name: 'Lamar Jackson', side: 'O' }, ...].
const NFLPA_EXTRA = {};

// ESPN's awards, by ESPN player id (the heat map's rosters use the same ids).
const AWARDS = { 477: 'MVP', 478: 'OPOY', 479: 'DPOY', 480: 'OROY', 481: 'DROY', 317: 'SB MVP' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ESPN turns away bursts, so a few at a time, retrying after a pause.
async function espnJson(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.status === 404) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      await sleep(1500 * (attempt + 1));
    }
  }
  throw new Error(`ESPN kept refusing ${url}`);
}
async function espnAwards() {
  const out = {};
  const jobs = [];
  for (let season = ALL_PRO_FROM; season <= LAST_SEASON; season++) {
    for (const [id, award] of Object.entries(AWARDS)) jobs.push({ season, id, award });
  }
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const data = await espnJson(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${job.season}/awards/${job.id}`);
      for (const w of data?.winners ?? []) {
        const athlete = w.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1];
        if (athlete) (out[athlete] ??= []).push({ award: job.award, season: job.season });
      }
      await sleep(150);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (const list of Object.values(out)) list.sort((a, b) => a.season - b.season);
  return out;
}

// Each season's league leaders (ties included) in the stats that matter.
const STATS_URL = (season) => `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_${season}.csv`;
async function statTitles(season) {
  const res = await fetch(STATS_URL(season));
  if (!res.ok) throw new Error(`nflverse stats ${season}: ${res.status}`);
  const rows = parseStats(await res.text());
  const out = [];
  for (const [key, label, s] of STATS) {
    const best = Math.max(...rows.map((r) => r.stats[key]));
    if (best > 0) for (const r of rows.filter((x) => x.stats[key] === best && sideOf(x.group) === s)) out.push({ name: r.name, side: s, stat: label, season, value: best });
  }
  return out;
}

// Everything by cleaned-up name: [{ side, ... }], so namesakes on the other
// side of the ball aren't mixed up.
const byName = {};
const add = (name, side, field, item) => {
  const key = fullKey(name);
  let p = (byName[key] ??= []).find((x) => x.side === side);
  if (!p) byName[key].push((p = { side }));
  (p[field] ??= []).push(item);
};

const report = [];
for (let season = ALL_PRO_FROM; season <= LAST_SEASON; season++) {
  try {
    const team = await apAllPro(season);
    for (const p of team) add(p.name, p.side, 'ap', season);
    report.push(`AP ${season}: ${team.length}`);
  } catch (err) {
    report.push(`AP ${season}: FAILED ${err.message}`);
  }
}
for (const year of TOP100_YEARS) {
  try {
    const list = await top100(year);
    for (const p of list) add(p.name, p.side, 'top100', { year, rank: p.rank });
    report.push(`Top 100 of ${year}: ${list.length}`);
  } catch (err) {
    report.push(`Top 100 of ${year}: FAILED ${err.message}`);
  }
}
const teams = { ...(await nflpa()), ...NFLPA_EXTRA };
for (const [season, team] of Object.entries(teams)) {
  for (const p of team) add(p.name, p.side, 'nflpa', Number(season));
  report.push(`NFLPA ${season}: ${team.length}`);
}
for (const season of TITLE_SEASONS) {
  try {
    const titles = await statTitles(season);
    for (const t of titles) add(t.name, t.side, 'titles', { stat: t.stat, season: t.season });
    report.push(`Stat titles ${season}: ${titles.length}`);
  } catch (err) {
    report.push(`Stat titles ${season}: FAILED ${err.message}`);
  }
}
const awards = await espnAwards();
report.push(`ESPN awards: ${Object.values(awards).flat().length} for ${Object.keys(awards).length} players`);

const file = join(root, 'src', 'honors-data.js');
writeFileSync(file, `// Made by scripts/build-honors.js on ${new Date().toISOString().slice(0, 10)}: don't edit by hand.
// byName: cleaned-up name -> [{ side: O|D|S, ap: [seasons], nflpa: [seasons],
//   top100: [{ year, rank }], titles: [{ stat, season }] }]
// awards: ESPN player id -> [{ award, season }]
export const builtFor = ${LAST_SEASON};
export const byName = ${JSON.stringify(byName)};
export const awards = ${JSON.stringify(awards)};
`);
console.log(report.join('\n'));
console.log(`Wrote ${file}`);
