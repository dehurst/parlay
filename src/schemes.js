// How each team plays, from free nflverse files, play by play:
//   play-by-play  - who had the ball, pass or run, EPA, success, pass rate over expected
//   FTN charting  - blitzers, pass rushers, men in the box, play action, motion,
//                   shotgun, no-huddle, screens, RPOs, QB out of the pocket
//                   (this season, a few days behind)
//   participation - man or zone, the coverage shell, pressure, personnel groups,
//                   time to throw (NFL Next Gen Stats: last season only; it isn't
//                   published during the season)
// scripts/build-scheme-data.js feeds every play through addPlay(), then
// summarize() turns the counts into rates. Everything is per team, both as the
// offense and as the defense.

const SHELLS = { COVER_0: 'c0', COVER_1: 'c1', COVER_2: 'c2', COVER_3: 'c3', COVER_4: 'c4', COVER_6: 'c6', '2_MAN': 'man2' };
// Two deep safeties before the snap vs one (or none).
const TWO_HIGH = ['c2', 'c4', 'c6', 'man2'];
const ONE_HIGH = ['c0', 'c1', 'c3'];

const bump = (o, k, by = 1) => { o[k] = (o[k] ?? 0) + by; };
const side = () => ({});

// "1 RB, 1 TE, 3 WR, ..." -> "11" (backs then tight ends), or null.
export function personnelGroup(text) {
  const n = (pos) => Number(String(text).match(new RegExp(`(\\d+) ${pos}\\b`))?.[1] ?? 0);
  if (!text || !/WR|TE|RB/.test(text)) return null;
  return `${n('RB') + n('FB')}${n('TE')}`;
}
// Defensive backs on the field: 4 or fewer = base, 5 = nickel, 6+ = dime.
export function defBacks(text) {
  if (!text) return null;
  let dbs = 0;
  for (const [, count, pos] of String(text).matchAll(/(\d+) (CB|FS|SS|S|DB)\b/g)) dbs += Number(count);
  return dbs || null;
}

export const newTally = () => ({});
const team = (tally, code) => (tally[code] ??= { off: side(), def: side() });

// One play. `p`: { off, def, dropback, run, epa, success, yards, passOe, sack, hit,
//   ftn?: { blitzers, rushers, box, pa, motion, screen, rpo, noHuddle, qbLoc, outOfPocket },
//   cov?: { manZone, shell, pressure, defPersonnel, offPersonnel, timeToThrow } }
export function addPlay(tally, p) {
  if (!p.off || !p.def || !(p.dropback || p.run)) return;
  const o = team(tally, p.off).off, d = team(tally, p.def).def;
  const epa = Number.isFinite(p.epa) ? p.epa : null;
  const explosive = p.dropback ? p.yards >= 20 : p.yards >= 10;
  for (const s of [o, d]) {
    bump(s, 'plays');
    bump(s, p.dropback ? 'dropbacks' : 'runs');
    if (epa != null) { bump(s, 'epaN'); bump(s, 'epa', epa); bump(s, p.dropback ? 'epaPassN' : 'epaRunN'); bump(s, p.dropback ? 'epaPass' : 'epaRun', epa); }
    if (p.success) bump(s, 'success');
    if (explosive) bump(s, 'explosive');
    if (p.dropback && p.sack) bump(s, 'sacks');
    if (p.dropback && (p.hit || p.sack)) bump(s, 'hits');
  }
  if (Number.isFinite(p.passOe)) { bump(o, 'proeN'); bump(o, 'proe', p.passOe); }

  const f = p.ftn;
  if (f) {
    for (const s of [o, d]) {
      bump(s, 'ftnPlays');
      if (f.motion) bump(s, 'motion');
      if (f.noHuddle) bump(s, 'noHuddle');
      if (f.qbLoc) { bump(s, 'qbLocN'); if (f.qbLoc !== 'U') bump(s, 'shotgun'); }
      if (f.rpo) bump(s, 'rpo');
    }
    if (p.dropback && f.rushers > 0) {
      const blitz = f.blitzers > 0;
      for (const s of [o, d]) {
        bump(s, 'ftnDropbacks');
        if (blitz) bump(s, 'blitz');
        bump(s, 'rushers', f.rushers);
        if (f.rushers >= 5) bump(s, 'heavyRush');
        if (f.pa) bump(s, 'pa');
        if (f.screen) bump(s, 'screen');
        if (f.outOfPocket) bump(s, 'outOfPocket');
        if (epa != null) { bump(s, blitz ? 'epaBlitzN' : 'epaNoBlitzN'); bump(s, blitz ? 'epaBlitz' : 'epaNoBlitz', epa); }
      }
    }
    if (p.run && f.box > 0) {
      for (const s of [o, d]) {
        bump(s, 'boxRuns');
        if (f.box >= 8) bump(s, 'stacked');
        if (f.box <= 6) bump(s, 'light');
      }
    }
  }

  const c = p.cov;
  if (c) {
    if (p.dropback && c.manZone) {
      const man = c.manZone === 'MAN_COVERAGE';
      for (const s of [o, d]) {
        bump(s, 'covN');
        if (man) bump(s, 'man');
        const shell = SHELLS[c.shell] ?? 'other';
        bump(s, `shell_${shell}`);
        if (epa != null) { bump(s, man ? 'epaManN' : 'epaZoneN'); bump(s, man ? 'epaMan' : 'epaZone', epa); }
      }
    }
    if (p.dropback && c.pressure != null) {
      for (const s of [o, d]) { bump(s, 'pressureN'); if (c.pressure) bump(s, 'pressure'); }
    }
    if (p.dropback && c.timeToThrow > 0) { bump(o, 'tttN'); bump(o, 'ttt', c.timeToThrow); }
    const pers = personnelGroup(c.offPersonnel);
    if (pers) { bump(o, 'persN'); bump(o, `pers_${pers}`); }
    const dbs = defBacks(c.defPersonnel);
    if (dbs) { bump(d, 'dbN'); bump(d, dbs <= 4 ? 'base' : dbs === 5 ? 'nickel' : 'dime'); }
  }
}

// Rates need a fair sample; below it, show nothing rather than noise.
const MIN = 30;
const pct = (n, d) => (d >= MIN ? Math.round((1000 * (n ?? 0)) / d) / 10 : null);
const avg = (sum, n, places = 3) => (n >= MIN ? Number(((sum ?? 0) / n).toFixed(places)) : null);

function offense(s) {
  const plays = (s.dropbacks ?? 0) + (s.runs ?? 0);
  const pers = Object.entries(s).filter(([k]) => k.startsWith('pers_')).map(([k, n]) => [k.slice(5), n]).sort((a, b) => b[1] - a[1]);
  return {
    plays,
    passRate: pct(s.dropbacks, plays),
    proe: avg(s.proe, s.proeN, 1),
    epa: avg(s.epa, s.epaN), epaPass: avg(s.epaPass, s.epaPassN), epaRun: avg(s.epaRun, s.epaRunN),
    success: pct(s.success, plays), explosive: pct(s.explosive, plays),
    sacked: pct(s.sacks, s.dropbacks),
    playAction: pct(s.pa, s.ftnDropbacks), motion: pct(s.motion, s.ftnPlays), shotgun: pct(s.shotgun, s.qbLocN),
    noHuddle: pct(s.noHuddle, s.ftnPlays), screen: pct(s.screen, s.ftnDropbacks), rpo: pct(s.rpo, s.ftnPlays),
    outOfPocket: pct(s.outOfPocket, s.ftnDropbacks),
    blitzed: pct(s.blitz, s.ftnDropbacks),
    epaVsBlitz: avg(s.epaBlitz, s.epaBlitzN), epaVsNoBlitz: avg(s.epaNoBlitz, s.epaNoBlitzN),
    stackedFaced: pct(s.stacked, s.boxRuns),
    // Last season's coverage data, when this is that season's summary.
    vsMan: avg(s.epaMan, s.epaManN), vsZone: avg(s.epaZone, s.epaZoneN), manFaced: pct(s.man, s.covN),
    pressured: pct(s.pressure, s.pressureN), timeToThrow: avg(s.ttt, s.tttN, 2),
    personnel: s.persN >= MIN ? pers.slice(0, 4).map(([g, n]) => ({ group: g, pct: pct(n, s.persN) })) : null,
  };
}

function defense(s) {
  const plays = (s.dropbacks ?? 0) + (s.runs ?? 0);
  const shells = s.covN >= MIN ? Object.fromEntries(['c0', 'c1', 'c2', 'c3', 'c4', 'c6', 'man2', 'other'].map((k) => [k, pct(s[`shell_${k}`], s.covN)])) : null;
  const sum = (keys) => (shells ? Math.round(10 * keys.reduce((t, k) => t + (shells[k] ?? 0), 0)) / 10 : null);
  return {
    plays,
    blitz: pct(s.blitz, s.ftnDropbacks), rushers: avg(s.rushers, s.ftnDropbacks, 2), heavyRush: pct(s.heavyRush, s.ftnDropbacks),
    sack: pct(s.sacks, s.dropbacks), hit: pct(s.hits, s.dropbacks),
    stacked: pct(s.stacked, s.boxRuns), light: pct(s.light, s.boxRuns),
    epa: avg(s.epa, s.epaN), epaPass: avg(s.epaPass, s.epaPassN), epaRun: avg(s.epaRun, s.epaRunN),
    success: pct(s.success, plays), explosive: pct(s.explosive, plays),
    epaBlitz: avg(s.epaBlitz, s.epaBlitzN), epaNoBlitz: avg(s.epaNoBlitz, s.epaNoBlitzN),
    passFaced: pct(s.dropbacks, plays), playActionFaced: pct(s.pa, s.ftnDropbacks),
    // Last season's coverage data.
    man: pct(s.man, s.covN), zone: s.covN >= MIN ? Math.round(1000 - (1000 * (s.man ?? 0)) / s.covN) / 10 : null,
    shells, twoHigh: sum(TWO_HIGH), oneHigh: sum(ONE_HIGH),
    epaMan: avg(s.epaMan, s.epaManN), epaZone: avg(s.epaZone, s.epaZoneN),
    pressure: pct(s.pressure, s.pressureN),
    base: pct(s.base, s.dbN), nickel: pct(s.nickel, s.dbN), dime: pct(s.dime, s.dbN),
  };
}

export function summarize(tally) {
  return Object.fromEntries(Object.entries(tally).map(([code, t]) => [code, { off: offense(t.off), def: defense(t.def) }]));
}

// "Ejiro Evero (fired October 30, 3–4 record) / Todd Wash (interim)" ->
// { name: 'Todd Wash', interim: true, before: 'Ejiro Evero', note: 'Ejiro Evero fired October 30' }
export function parseCoach(text) {
  if (!text) return null;
  const parts = String(text).split(' / ').map((s) => s.trim()).filter(Boolean);
  const strip = (s) => s.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const last = parts.at(-1);
  const out = { name: strip(last) };
  if (/interim/i.test(last)) out.interim = true;
  if (/de facto/i.test(last)) out.note = 'head coach calls it';
  if (parts.length > 1) {
    out.before = strip(parts[0]);
    const why = parts[0].match(/\((fired|resigned|demoted|reassigned)[^,)]*/i)?.[0]?.slice(1);
    if (why) out.change = `${out.before} ${why}`;
  }
  return out;
}
