import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTally, addPlay, summarize, personnelGroup, defBacks, parseCoach } from '../src/schemes.js';

const ftn = (o = {}) => ({ blitzers: 0, rushers: 4, box: 7, pa: false, motion: false, screen: false, rpo: false, noHuddle: false, qbLoc: 'S', outOfPocket: false, ...o });

test('blitz rate, rushers and box counts come from FTN charting, for both sides', () => {
  const t = newTally();
  for (let i = 0; i < 120; i++) addPlay(t, { off: 'KC', def: 'MIN', dropback: true, epa: i < 30 ? -1 : 0.5, ftn: ftn({ blitzers: i < 30 ? 2 : 0, rushers: i < 30 ? 6 : 4, pa: i % 4 === 0 }) });
  for (let i = 0; i < 40; i++) addPlay(t, { off: 'KC', def: 'MIN', run: true, epa: 0, yards: i < 4 ? 12 : 3, ftn: ftn({ box: i < 20 ? 8 : 6, qbLoc: 'U' }) });
  const s = summarize(t);
  assert.equal(s.MIN.def.blitz, 25);
  assert.equal(s.MIN.def.rushers, 4.5);
  assert.equal(s.MIN.def.heavyRush, 25);
  assert.equal(s.MIN.def.stacked, 50);
  assert.equal(s.MIN.def.light, 50);
  assert.equal(s.MIN.def.epaBlitz, -1);
  assert.equal(s.KC.off.blitzed, 25);
  assert.equal(s.KC.off.epaVsNoBlitz, 0.5);
  assert.equal(s.KC.off.playAction, 25);
  assert.equal(s.KC.off.passRate, 75);
  assert.equal(s.KC.off.shotgun, 75);
  assert.equal(s.KC.off.explosive, 2.5); // 4 runs of 10+ out of 160 plays
});

test('man/zone, shells, pressure and personnel come from participation', () => {
  const t = newTally();
  for (let i = 0; i < 40; i++) {
    addPlay(t, { off: 'BUF', def: 'PHI', dropback: true, epa: 0, cov: {
      manZone: i < 10 ? 'MAN_COVERAGE' : 'ZONE_COVERAGE', shell: i < 10 ? 'COVER_1' : i < 30 ? 'COVER_4' : 'COVER_3',
      pressure: i < 8, offPersonnel: i < 30 ? '1 RB, 1 TE, 3 WR' : '1 RB, 2 TE, 2 WR', defPersonnel: i < 20 ? '3 CB, 1 FS, 1 SS, 2 DE, 2 DT, 2 LB' : '2 CB, 1 FS, 1 SS, 2 DE, 2 DT, 3 LB', timeToThrow: 2.5,
    } });
  }
  const s = summarize(t);
  assert.equal(s.PHI.def.man, 25);
  assert.equal(s.PHI.def.zone, 75);
  assert.equal(s.PHI.def.shells.c4, 50);
  assert.equal(s.PHI.def.twoHigh, 50);
  assert.equal(s.PHI.def.oneHigh, 50);
  assert.equal(s.PHI.def.pressure, 20);
  assert.equal(s.PHI.def.nickel, 50);
  assert.equal(s.PHI.def.base, 50);
  assert.deepEqual(s.BUF.off.personnel, [{ group: '11', pct: 75 }, { group: '12', pct: 25 }]);
  assert.equal(s.BUF.off.timeToThrow, 2.5);
});

test('small samples show nothing rather than noise', () => {
  const t = newTally();
  for (let i = 0; i < 5; i++) addPlay(t, { off: 'A', def: 'B', dropback: true, epa: 1, ftn: ftn({ blitzers: 1 }) });
  assert.equal(summarize(t).B.def.blitz, null);
});

test('personnel groups and defensive backs', () => {
  assert.equal(personnelGroup('1 C, 2 G, 1 QB, 1 RB, 2 T, 2 TE, 2 WR'), '12');
  assert.equal(personnelGroup('1 FB, 1 RB, 1 TE, 2 WR'), '21');
  assert.equal(defBacks('3 CB, 2 DE, 2 DT, 1 FS, 1 MLB, 1 OLB, 1 SS'), 5);
  assert.equal(defBacks('2 CB, 2 DE, 2 DT, 1 FS, 1 MLB, 1 OLB, 2 SS'), 5);
});

test('coaches from Wikipedia infobox text, with midseason changes', () => {
  assert.deepEqual(parseCoach('Ejiro Evero (fired October 30, 3–4 record) / Todd Wash (interim)'),
    { name: 'Todd Wash', interim: true, before: 'Ejiro Evero', change: 'Ejiro Evero fired October 30' });
  assert.deepEqual(parseCoach('Todd Bowles (de facto)'), { name: 'Todd Bowles', note: 'head coach calls it' });
  assert.deepEqual(parseCoach('Vic Fangio'), { name: 'Vic Fangio' });
  assert.equal(parseCoach(null), null);
});
