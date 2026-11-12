// Pull every NFL player's public injury record from ESPN's league-wide
// injury feed (free, no key) and save it as JSON and CSV.
//
//   node scripts/fetch-injuries.js            -> exports/nfl-injuries-<date>.{json,csv}
//   node scripts/fetch-injuries.js --all      -> also keep "Active" players
//                                                (news notes, no injury)
import { mkdir, writeFile } from 'node:fs/promises';

const URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
const includeActive = process.argv.includes('--all');

const res = await fetch(URL, { signal: AbortSignal.timeout(20000) });
if (!res.ok) throw new Error(`ESPN injuries returned ${res.status}`);
const feed = await res.json();

const rows = feed.injuries.flatMap((team) => team.injuries.map((i) => {
  const a = i.athlete ?? {};
  const d = i.details ?? {};
  return {
    team: a.team?.abbreviation ?? team.displayName,
    player: a.displayName,
    position: a.position?.abbreviation ?? null,
    status: i.status,
    fantasyStatus: d.fantasyStatus?.abbreviation ?? null,
    injury: d.type ?? null,
    bodyArea: d.location ?? null,
    detail: d.detail ?? null,
    side: d.side ?? null,
    expectedReturn: d.returnDate ?? null,
    updated: i.date ?? null,
    summary: i.shortComment ?? null,
    notes: i.longComment ?? null,
    espnPlayerUrl: a.links?.find((l) => l.rel?.includes('playercard'))?.href ?? null,
  };
})).filter((r) => includeActive || r.status !== 'Active')
  .sort((x, y) => x.team.localeCompare(y.team) || x.player.localeCompare(y.player));

const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const cols = Object.keys(rows[0] ?? {});
const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');

const stamp = new Date().toISOString().slice(0, 10);
await mkdir('exports', { recursive: true });
await writeFile(`exports/nfl-injuries-${stamp}.json`, JSON.stringify({ fetchedAt: new Date().toISOString(), source: URL, players: rows }, null, 2));
await writeFile(`exports/nfl-injuries-${stamp}.csv`, '﻿' + csv); // BOM so Excel reads UTF-8 names

const byStatus = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
console.log(`${rows.length} players across ${new Set(rows.map((r) => r.team)).size} teams`, byStatus);
console.log(`Saved exports/nfl-injuries-${stamp}.json and .csv`);
