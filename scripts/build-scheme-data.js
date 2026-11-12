// Builds src/scheme-data.js: how every NFL team plays (blitz rate, man vs
// zone, coverage shells, box counts, play action, motion, personnel, ...)
// and who calls its plays. The source files are far too big to download on
// every visit, so run this once a week during the season, after Monday night
// (FTN's charting lands a few days after each game):
//
//   npm run build-scheme-data
//
// Sources (all free):
//   nflverse play-by-play     - this season and last
//   nflverse FTN charting     - this season (blitzers, rushers, box, play action, motion...)
//   nflverse participation    - last season (man/zone, coverage shell, pressure, personnel);
//                               Next Gen Stats only releases it after the season
//   Wikipedia season pages    - head coach and coordinators (picks up midseason firings)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { splitCsvLine } from '../src/nflstats.js';
import { newTally, addPlay, summarize, parseCoach } from '../src/schemes.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const NFLVERSE = 'https://github.com/nflverse/nflverse-data/releases/download';
const now = new Date();
const SEASON = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
const LAST = SEASON - 1;

// A CSV (optionally gzipped) one row at a time, as objects of just `keep` columns.
async function* rows(url, keep, gz = false) {
  const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  let input = Readable.fromWeb(res.body);
  if (gz) input = input.pipe(createGunzip());
  let col = null;
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const r = splitCsvLine(line);
    if (!col) { col = keep.map((k) => [k, r.indexOf(k)]); continue; }
    yield Object.fromEntries(col.map(([k, i]) => [k, r[i]]));
  }
}
const yes = (v) => v === 'TRUE' || v === '1';
const num = (v) => (v === '' || v == null || v === 'NA' ? NaN : Number(v));

// FTN charting by "game_id play_id".
async function charting(season) {
  const out = new Map();
  const keep = ['nflverse_game_id', 'nflverse_play_id', 'week', 'qb_location', 'n_defense_box', 'is_no_huddle', 'is_motion', 'is_play_action',
    'is_screen_pass', 'is_rpo', 'is_qb_out_of_pocket', 'n_blitzers', 'n_pass_rushers'];
  let through = 0;
  for await (const r of rows(`${NFLVERSE}/ftn_charting/ftn_charting_${season}.csv`, keep)) {
    through = Math.max(through, Number(r.week) || 0);
    out.set(`${r.nflverse_game_id} ${r.nflverse_play_id}`, {
      blitzers: Math.min(num(r.n_blitzers) || 0, 11), rushers: Math.min(num(r.n_pass_rushers) || 0, 11), box: Math.min(num(r.n_defense_box) || 0, 11),
      pa: yes(r.is_play_action), motion: yes(r.is_motion), screen: yes(r.is_screen_pass), rpo: yes(r.is_rpo), noHuddle: yes(r.is_no_huddle),
      qbLoc: ['U', 'S', 'P'].includes(r.qb_location) ? r.qb_location : null, outOfPocket: yes(r.is_qb_out_of_pocket),
    });
  }
  console.log(`FTN charting ${season}: ${out.size} plays through Week ${through}`);
  return { plays: out, through };
}

// Next Gen Stats participation by "game_id play_id".
async function participation(season) {
  const out = new Map();
  const keep = ['nflverse_game_id', 'play_id', 'offense_personnel', 'defense_personnel', 'time_to_throw', 'was_pressure', 'defense_man_zone_type', 'defense_coverage_type'];
  for await (const r of rows(`${NFLVERSE}/pbp_participation/pbp_participation_${season}.csv`, keep)) {
    out.set(`${r.nflverse_game_id} ${r.play_id}`, {
      manZone: r.defense_man_zone_type || null, shell: r.defense_coverage_type || null,
      pressure: r.was_pressure === '' ? null : yes(r.was_pressure),
      offPersonnel: r.offense_personnel, defPersonnel: r.defense_personnel, timeToThrow: num(r.time_to_throw),
    });
  }
  console.log(`Participation ${season}: ${out.size} plays`);
  return out;
}

// Every regular-season pass and designed run, joined to whatever charting there is.
async function season(year, ftn, cov) {
  const tally = newTally();
  let through = 0;
  const keep = ['game_id', 'play_id', 'season_type', 'week', 'posteam', 'defteam', 'play_type', 'qb_dropback', 'qb_scramble', 'two_point_attempt',
    'epa', 'success', 'yards_gained', 'pass_oe', 'sack', 'qb_hit'];
  for await (const r of rows(`${NFLVERSE}/pbp/play_by_play_${year}.csv.gz`, keep, true)) {
    if (r.season_type !== 'REG' || r.two_point_attempt === '1') continue;
    // Scrambles count as dropbacks (the call was a pass), not runs.
    const scramble = r.qb_scramble === '1';
    const run = r.play_type === 'run' && !scramble;
    if (!(r.play_type === 'pass' || scramble || run)) continue;
    through = Math.max(through, Number(r.week) || 0);
    const key = `${r.game_id} ${r.play_id}`;
    addPlay(tally, {
      off: r.posteam, def: r.defteam, dropback: !run, run, epa: num(r.epa), success: r.success === '1', yards: num(r.yards_gained) || 0,
      passOe: num(r.pass_oe), sack: r.sack === '1', hit: r.qb_hit === '1',
      ftn: ftn?.get(key), cov: cov?.get(key),
    });
  }
  console.log(`Play-by-play ${year}: through Week ${through}`);
  return { teams: summarize(tally), through };
}

// Coaches, from each team's Wikipedia season page (it's kept current through
// firings and interim promotions). A blank field there falls back to these.
const TEAMS = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills', CAR: 'Carolina Panthers', CHI: 'Chicago Bears',
  CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns', DAL: 'Dallas Cowboys', DEN: 'Denver Broncos', DET: 'Detroit Lions', GB: 'Green Bay Packers',
  HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars', KC: 'Kansas City Chiefs', LV: 'Las Vegas Raiders',
  LAC: 'Los Angeles Chargers', LA: 'Los Angeles Rams', MIA: 'Miami Dolphins', MIN: 'Minnesota Vikings', NE: 'New England Patriots',
  NO: 'New Orleans Saints', NYG: 'New York Giants', NYJ: 'New York Jets', PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers',
  SF: 'San Francisco 49ers', SEA: 'Seattle Seahawks', TB: 'Tampa Bay Buccaneers', TEN: 'Tennessee Titans', WAS: 'Washington Commanders',
};
const FALLBACK = {
  2026: { GB: { oc: 'Adam Stenavich', dc: 'Jonathan Gannon' } },
  // Last season's coordinators, to flag a defense whose coverage numbers came from someone else.
  2025: {
    ARI: { oc: 'Drew Petzing', dc: 'Nick Rallis' }, ATL: { oc: 'Zac Robinson', dc: 'Jeff Ulbrich' }, CHI: { oc: 'Declan Doyle', dc: 'Dennis Allen' },
    CIN: { oc: 'Dan Pitcher', dc: 'Al Golden' }, CLE: { oc: 'Tommy Rees', dc: 'Jim Schwartz' }, DAL: { oc: 'Klayton Adams', dc: 'Matt Eberflus' },
    DET: { oc: 'John Morton', dc: 'Kelvin Sheppard' }, GB: { oc: 'Adam Stenavich', dc: 'Jeff Hafley' }, IND: { oc: 'Jim Bob Cooter', dc: 'Lou Anarumo' },
    KC: { oc: 'Matt Nagy', dc: 'Steve Spagnuolo' }, LV: { oc: 'Chip Kelly', dc: 'Patrick Graham' }, LAC: { oc: 'Greg Roman', dc: 'Jesse Minter' },
    MIA: { oc: 'Frank Smith', dc: 'Anthony Weaver' }, MIN: { oc: 'Wes Phillips', dc: 'Brian Flores' }, NYG: { oc: 'Mike Kafka', dc: 'Shane Bowen' },
    NYJ: { oc: 'Tanner Engstrand', dc: 'Steve Wilks' }, TB: { oc: 'Josh Grizzard', dc: 'Todd Bowles' }, TEN: { oc: 'Nick Holz', dc: 'Dennard Wilson' },
  },
};
const cleanWiki = (v) => v?.replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, '').replace(/\{\{[^}]*\}\}/g, '')
  .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/<br\s*\/?>/g, ' / ').replace(/<[^>]+>/g, '').trim() || null;
async function coaches(year) {
  const out = {};
  for (const [code, name] of Object.entries(TEAMS)) {
    const res = await fetch(`https://en.wikipedia.org/w/index.php?title=${year}_${name.replace(/ /g, '_')}_season&action=raw`,
      { headers: { 'user-agent': 'parlay-scheme-builder/1.0' }, signal: AbortSignal.timeout(30000) }).catch(() => null);
    const text = res?.ok ? await res.text() : '';
    const field = (k) => cleanWiki(text.match(new RegExp(String.raw`^\|\s*${k}\s*=([^\r\n]*)`, 'm'))?.[1]);
    const fb = FALLBACK[year]?.[code] ?? {};
    out[code] = {
      hc: parseCoach(field('coach') ?? fb.hc), oc: parseCoach(field('off_coach') ?? fb.oc), dc: parseCoach(field('def_coach') ?? fb.dc),
    };
    const missing = ['hc', 'oc', 'dc'].filter((k) => !out[code][k]);
    if (missing.length) console.warn(`${year} ${code}: no ${missing.join('/')} on Wikipedia or in FALLBACK`);
  }
  return out;
}

const ftn = await charting(SEASON);
const cov = await participation(LAST);
const now_ = await season(SEASON, ftn.plays, null);
const last = await season(LAST, null, cov);
const staff = await coaches(SEASON);
const staffLast = await coaches(LAST);

const teams = Object.fromEntries(Object.keys(TEAMS).map((code) => {
  const dcLast = staffLast[code]?.dc?.name ?? null;
  const dcNow = staff[code]?.dc;
  // Last season's coverage is a guide to this year's only if the same coach calls it.
  const sameDc = dcLast && dcNow ? dcNow.name === dcLast : null;
  return [code, {
    coaches: { ...staff[code], dcLast, ocLast: staffLast[code]?.oc?.name ?? null, sameDc },
    now: now_.teams[code] ?? null,
    last: last.teams[code] ?? null,
  }];
}));

const out = `// Made by scripts/build-scheme-data.js on ${now.toISOString().slice(0, 10)}: don't edit by hand.
// How each NFL team plays and who calls it, by nflverse team code. \`now\` is
// this season (play-by-play through Week ${now_.through}, FTN charting through
// Week ${ftn.through}); \`last\` is last season, the only one with Next Gen Stats'
// coverage data (man/zone, shells, pressure, personnel).
export const schemeSeasons = ${JSON.stringify({ now: SEASON, last: LAST, pbpThrough: now_.through, ftnThrough: ftn.through, built: now.toISOString().slice(0, 10) })};
export const schemes = ${JSON.stringify(teams)};
`;
writeFileSync(join(root, 'src', 'scheme-data.js'), out);
console.log(`Wrote src/scheme-data.js (${(out.length / 1024).toFixed(0)} KB)`);
