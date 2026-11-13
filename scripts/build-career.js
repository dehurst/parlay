// Builds src/career-data.js: each active player's regular-season career
// totals before this season, for the Players view's Career toggle (this
// season's numbers are added live). Past seasons don't change, so the site
// reads them from a file instead of downloading 27 seasons of stats. Run it
// once a year, after the season ends:
//
//   node scripts/build-career.js        (through last season)
//   node scripts/build-career.js 2026   (through 2026)
//
// Source: nflverse's season stat files (free), every season since 1999.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCsv } from '../src/nflstats.js';
import { statsOf, CAREER_KEYS, STAT_DEFS, SHOWN } from '../src/playerstats.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const now = new Date();
const LAST = Number(process.argv[2]) || (now.getMonth() >= 8 ? now.getFullYear() - 1 : now.getFullYear() - 2);
const FIRST = 1999;
// Only players who've played lately: anyone who played in one of the last
// 3 seasons could still be on a roster.
const ACTIVE_FROM = LAST - 2;
const url = (s) => `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_${s}.csv`;

const players = new Map();
for (let season = FIRST; season <= LAST; season++) {
  const res = await fetch(url(season));
  if (!res.ok) throw new Error(`nflverse ${season}: ${res.status}`);
  const rows = parseCsv(await res.text()).filter((r) => r.player_id && SHOWN[r.position_group]);
  for (const r of rows) {
    const s = statsOf(r);
    let p = players.get(r.player_id);
    if (!p) players.set(r.player_id, (p = { first: season, last: season, n: 0, games: 0, stats: Object.fromEntries(CAREER_KEYS.map((k) => [k, 0])) }));
    p.last = season;
    p.n++;
    p.games += Number(r.games) || 0;
    for (const k of CAREER_KEYS) p.stats[k] = STAT_DEFS[k].max ? Math.max(p.stats[k], s[k]) : p.stats[k] + s[k];
  }
  console.log(`${season}: ${rows.length} players`);
}

const round = (v) => Math.round(v * 10) / 10;
const out = {};
for (const [id, p] of players) {
  if (p.last < ACTIVE_FROM) continue;
  out[id] = [p.first, p.last, p.n, p.games, ...CAREER_KEYS.map((k) => round(p.stats[k]))];
}
const file = `// Made by scripts/build-career.js from nflverse's season stat files: each
// active player's regular-season career before this season, by nflverse
// player id: [first season, last season, seasons played, games, ...stats in
// the order of KEYS]. Don't edit by hand; run the script once a year.
export const THROUGH = ${LAST};
export const KEYS = ${JSON.stringify(CAREER_KEYS)};
export const CAREER = {
${Object.entries(out).map(([id, v]) => `${JSON.stringify(id)}:${JSON.stringify(v)}`).join(',\n')}
};
`;
writeFileSync(join(root, 'src', 'career-data.js'), file);
console.log(`Wrote ${Object.keys(out).length} players (${FIRST}-${LAST}), ${Math.round(file.length / 1024)} KB`);
