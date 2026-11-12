// Career injury history for every NFL player since 2009, built from the
// official weekly NFL injury reports archived by nflverse (free, public).
//
//   node scripts/fetch-injuries.js          (current ESPN report, run first)
//   node scripts/fetch-injury-history.js
//
// Writes to exports/:
//   nfl-injury-reports-2009-<yr>.csv   every weekly report line (raw)
//   nfl-injury-episodes.csv            report weeks grouped into injuries
//   nfl-injury-careers.csv             one row per player: career totals by
//                                      body part + current status from ESPN
//
// Official reports name the body part ("Knee", "Foot"), not the diagnosis
// (MCL, Lisfranc). An "episode" is consecutive report weeks in one season
// for the same body part (gaps of up to 3 weeks allowed, e.g. a bye).
// Players on IR drop off the weekly report, so long injuries can look
// shorter than they were.
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';

const FIRST = 2009;
const LAST = new Date().getFullYear();
const url = (y) => `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${y}.csv`;

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (rows) => {
  const cols = Object.keys(rows[0] ?? {});
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
};

// --- download every season -------------------------------------------------
const reports = [];
for (let y = FIRST; y <= LAST; y++) {
  const res = await fetch(url(y), { signal: AbortSignal.timeout(60000) });
  if (res.status === 404) continue; // season not published yet
  if (!res.ok) throw new Error(`nflverse ${y} returned ${res.status}`);
  const rows = parseCsv(await res.text());
  reports.push(...rows);
  process.stdout.write(`${y}: ${rows.length} report lines\n`);
}

// --- group weekly lines into injury episodes -------------------------------
const NOT_INJURY = /not injury related|resting|personal|illness/i;
const SEVERITY = { Out: 4, Doubtful: 3, Questionable: 2, Probable: 1 };
const norm = (s) => (s ?? '').trim().replace(/\s+/g, ' ');
const bodyPart = (r) => norm(r.report_primary_injury) || norm(r.practice_primary_injury);

const lines = reports
  .map((r) => ({ ...r, week: Number(r.week), season: Number(r.season), part: bodyPart(r) }))
  .filter((r) => r.gsis_id && r.part && !NOT_INJURY.test(r.part) && !NOT_INJURY.test(r.practice_status))
  .sort((a, b) => a.gsis_id.localeCompare(b.gsis_id) || a.season - b.season || a.week - b.week);

const episodes = [];
const open = new Map(); // `${id}|${part}` -> episode
for (const r of lines) {
  const key = `${r.gsis_id}|${r.part.toLowerCase()}`;
  let ep = open.get(key);
  if (!ep || ep.season !== r.season || r.week - ep.lastWeek > 3) {
    ep = {
      gsisId: r.gsis_id, player: r.full_name, position: r.position, team: r.team,
      season: r.season, bodyPart: r.part, secondary: new Set(),
      firstWeek: r.week, lastWeek: r.week, weeksOnReport: 0, weeksOut: 0,
      weeksDnp: 0, worst: '',
    };
    episodes.push(ep);
    open.set(key, ep);
  }
  ep.lastWeek = r.week;
  ep.weeksOnReport++;
  if (r.report_status === 'Out') ep.weeksOut++;
  if (/did not participate/i.test(r.practice_status)) ep.weeksDnp++;
  if ((SEVERITY[r.report_status] ?? 0) > (SEVERITY[ep.worst] ?? 0)) ep.worst = r.report_status;
  for (const s of [r.report_secondary_injury, r.practice_secondary_injury].map(norm)) if (s && !NOT_INJURY.test(s)) ep.secondary.add(s);
  ep.team = r.team; // latest team during the injury
}

const episodeRows = episodes.map((e) => ({
  player: e.player, position: e.position, team: e.team, season: e.season,
  bodyPart: e.bodyPart, alsoListed: [...e.secondary].join('; '),
  firstWeek: e.firstWeek, lastWeek: e.lastWeek, weeksOnReport: e.weeksOnReport,
  weeksListedOut: e.weeksOut, weeksDidNotPractice: e.weeksDnp,
  worstGameStatus: e.worst || 'Practice report only', gsisId: e.gsisId,
})).sort((a, b) => a.player.localeCompare(b.player) || a.season - b.season || a.firstWeek - b.firstWeek);

// --- current ESPN report (from scripts/fetch-injuries.js), joined by name ---
let current = new Map();
try {
  const latest = (await readdir('exports')).filter((f) => /^nfl-injuries-\d{4}-\d\d-\d\d\.json$/.test(f)).sort().pop();
  if (latest) {
    const { players } = JSON.parse(await readFile(`exports/${latest}`, 'utf8'));
    current = new Map(players.map((p) => [p.player.toLowerCase(), p]));
  }
} catch { /* no current export; columns stay blank */ }

// --- one row per player ----------------------------------------------------
const byPlayer = new Map();
for (const e of episodeRows) {
  const p = byPlayer.get(e.gsisId) ?? { player: e.player, position: e.position, team: e.team, eps: [] };
  p.team = e.team; p.position = e.position; p.eps.push(e);
  byPlayer.set(e.gsisId, p);
}
const careerRows = [...byPlayer.values()].map((p) => {
  const parts = {};
  for (const e of p.eps) (parts[e.bodyPart] ??= []).push(e.season);
  const summary = Object.entries(parts).sort((a, b) => b[1].length - a[1].length)
    .map(([part, yrs]) => `${part} x${yrs.length} (${yrs.join(', ')})`).join('; ');
  const now = current.get(p.player.toLowerCase());
  return {
    player: p.player, position: p.position, lastTeam: p.team,
    injuries: p.eps.length,
    gamesListedOut: p.eps.reduce((s, e) => s + e.weeksListedOut, 0),
    weeksOnReport: p.eps.reduce((s, e) => s + e.weeksOnReport, 0),
    firstSeason: p.eps[0].season, lastSeason: p.eps.at(-1).season,
    byBodyPart: summary,
    currentStatus: now?.status ?? '', currentInjury: now ? [now.injury, now.detail !== 'Not Specified' ? now.detail : null, now.side !== 'Not Specified' ? now.side : null].filter(Boolean).join(' – ') : '',
    currentExpectedReturn: now?.expectedReturn ?? '', currentNote: now?.summary ?? '',
  };
}).sort((a, b) => b.injuries - a.injuries || a.player.localeCompare(b.player));

await mkdir('exports', { recursive: true });
const seasons = [...new Set(reports.map((r) => r.season))];
await writeFile(`exports/nfl-injury-reports-${FIRST}-${seasons.at(-1)}.csv`, toCsv(reports));
await writeFile('exports/nfl-injury-episodes.csv', toCsv(episodeRows));
await writeFile('exports/nfl-injury-careers.csv', toCsv(careerRows));
console.log(`${reports.length} report lines -> ${episodeRows.length} injuries across ${careerRows.length} players`);
console.log(`Current-report matches: ${careerRows.filter((r) => r.currentStatus).length} of ${current.size}`);
