// Builds src/lb-data.js: what the heat map needs to tell linebackers apart
// that's too big to download on every visit (play-by-play is ~10-20 MB a
// season). Run it once a week during the season (Tuesday, after Monday
// night) so run stops stay current:
//
//   node scripts/build-lb-data.js
//
// For every linebacker and edge rusher, keyed by PFR id:
//   pff, ngs   - PFF's and NFL Next Gen Stats' position (ED/EDGE = edge rusher)
//   combine    - his combine position (EDGE/DE = came into the league a rusher)
//   exp        - years in the NFL (0 = rookie)
//   stops      - run stops this season + last: tackles on designed runs the
//                offense lost (nflverse's `success` = 0)
//   runTackles - all his tackles on designed runs, same seasons
// Source: nflverse (free): players, combine and play-by-play files.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { parseCsv, splitCsvLine } from '../src/nflstats.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download';
const now = new Date();
const SEASON = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
const SEASONS = [SEASON - 1, SEASON];

async function text(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

// Players: positions, experience, and the id map from play-by-play (GSIS) to PFR.
const players = parseCsv(await text(`${NFLVERSE}/players/players.csv`));
const LB = /^(LB|OLB|ILB|MLB)$/;
const keep = players.filter((p) => p.pfr_id && (LB.test(p.position) || p.position_group === 'LB' || p.pff_position === 'ED' || p.ngs_position === 'EDGE')
  && Number(p.last_season) >= SEASON - 1);
const gsisToPfr = new Map(keep.filter((p) => p.gsis_id).map((p) => [p.gsis_id, p.pfr_id]));
const combine = new Map(parseCsv(await text(`${NFLVERSE}/combine/combine.csv`)).filter((r) => r.pfr_id).map((r) => [r.pfr_id, r.pos]));

// Run stops, streamed a line at a time (the files are big).
const TACKLERS = ['solo_tackle_1_player_id', 'solo_tackle_2_player_id', 'assist_tackle_1_player_id', 'assist_tackle_2_player_id',
  'assist_tackle_3_player_id', 'assist_tackle_4_player_id', 'tackle_with_assist_1_player_id', 'tackle_with_assist_2_player_id'];
const stops = new Map(), runTackles = new Map();
const through = {};
for (const season of SEASONS) {
  const res = await fetch(`${NFLVERSE}/pbp/play_by_play_${season}.csv.gz`, { signal: AbortSignal.timeout(300000) });
  if (res.status === 404) continue;
  if (!res.ok) throw new Error(`play-by-play ${season} returned ${res.status}`);
  const lines = createInterface({ input: Readable.fromWeb(res.body).pipe(createGunzip()), crlfDelay: Infinity });
  let col = null;
  for await (const line of lines) {
    const r = splitCsvLine(line);
    if (!col) { col = Object.fromEntries(r.map((h, i) => [h, i])); continue; }
    if (r[col.season_type] !== 'REG' || r[col.play_type] !== 'run' || r[col.qb_scramble] === '1') continue;
    through[season] = Math.max(through[season] ?? 0, Number(r[col.week]) || 0);
    for (const gsis of new Set(TACKLERS.map((k) => r[col[k]]).filter(Boolean))) {
      const pfr = gsisToPfr.get(gsis);
      if (!pfr) continue;
      runTackles.set(pfr, (runTackles.get(pfr) ?? 0) + 1);
      if (r[col.success] === '0') stops.set(pfr, (stops.get(pfr) ?? 0) + 1);
    }
  }
  console.log(`${season}: run plays through Week ${through[season]}`);
}

const byPfr = Object.fromEntries(keep.map((p) => [p.pfr_id, {
  name: p.display_name, pff: p.pff_position || null, ngs: p.ngs_position || null, combine: combine.get(p.pfr_id) ?? null,
  exp: p.years_of_experience === '' ? null : Number(p.years_of_experience),
  stops: stops.get(p.pfr_id) ?? 0, runTackles: runTackles.get(p.pfr_id) ?? 0,
}]));

const out = `// Made by scripts/build-lb-data.js on ${now.toISOString().slice(0, 10)}: don't edit by hand.
// Linebackers and edge rushers by PFR id: positions (PFF, Next Gen Stats,
// combine), years in the NFL, and run stops / run tackles over the seasons
// in \`through\` (season -> last week counted).
export const through = ${JSON.stringify(through)};
export const lbData = ${JSON.stringify(byPfr)};
`;
writeFileSync(join(root, 'src', 'lb-data.js'), out);
console.log(`Wrote src/lb-data.js: ${keep.length} players`);
