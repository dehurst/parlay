// Research tab: every team's season so far from ESPN's scoreboard (free):
// record, home/away, points, against the spread, over/under, strength of
// schedule, and a game log. Lines come from ESPN's scoreboard odds; games
// without them fall back to the FanDuel lines this app saved. Yards, sacks,
// turnovers, down conversions, red zone, time of possession, and penalties
// come from each finished game's box score (also free), offense from the
// team's own line and defense from what their opponent did that game.

import { sport, inSlate, espnSite, espnCore } from './sport.js';

// Regular-season weeks: 18 in the NFL, 15 in college (ESPN's numbering).
export const regularSeasonWeeks = () => sport().seasonWeeks;

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
// "7-13" -> [7, 13]; null if missing.
const pair = (s) => {
  const m = String(s ?? '').match(/^(\d+)-(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
};
// "32:10" -> 1930 seconds.
const clock = (s) => {
  const m = String(s ?? '').match(/^(\d+):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// The season a date belongs to (Jan/Feb games are the previous season's).
export function seasonYear(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() < 2 ? y - 1 : y;
}

export async function fetchSeasonWeek(season, week) {
  const res = await fetch(`${espnSite('scoreboard')}?seasontype=2&week=${week}&dates=${season}${sport().espnQuery}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

// The home team's spread from ESPN's odds ("KC -3.5" -> -3.5 if KC is home,
// +3.5 if away; "EVEN" -> 0). Null when there's no line.
export function homeLine(odds, homeAbbr, awayAbbr) {
  if (!odds) return null;
  const details = String(odds.details ?? '').trim();
  if (/^(even|pk|pick)/i.test(details)) return 0;
  const m = details.match(/^([A-Z]{2,4})\s+([+-]?\d+(?:\.\d+)?)$/);
  if (m) {
    const line = Number(m[2]);
    if (m[1] === homeAbbr) return line;
    if (m[1] === awayAbbr) return -line;
  }
  // No usable text: use the size of the spread and who's favored.
  const size = Math.abs(num(odds.spread) ?? NaN);
  if (!Number.isFinite(size)) return null;
  if (odds.homeTeamOdds?.favorite) return -size;
  if (odds.awayTeamOdds?.favorite) return size;
  return null;
}

// One week of ESPN's scoreboard as compact games.
export function parseSeasonWeek(board, week) {
  return (board.events ?? []).map((ev) => {
    const comp = ev.competitions?.[0];
    const side = (s) => comp?.competitors?.find((c) => c.homeAway === s);
    const h = side('home');
    const a = side('away');
    if (!h?.team || !a?.team) return null;
    // College: only games with a Power 5 team.
    if (!inSlate(h.team.conferenceId) && !inSlate(a.team.conferenceId)) return null;
    const status = comp.status?.type ?? ev.status?.type ?? {};
    const odds = comp.odds?.[0];
    const team = (c) => ({
      name: c.team.displayName, abbr: c.team.abbreviation, short: c.team.shortDisplayName ?? c.team.name, score: num(c.score), id: c.team.id ?? null,
      conf: c.team.conferenceId ?? null, logo: c.team.logo ?? null,
    });
    return {
      week,
      date: ev.date,
      final: !!status.completed,
      espnId: ev.id ?? null, // ESPN's game ID, to look up box scores and the closing line
      home: team(h),
      away: team(a),
      homeLine: homeLine(odds, h.team.abbreviation, a.team.abbreviation),
      total: num(odds?.overUnder),
    };
  }).filter(Boolean);
}

// One finished game's team-level box score: offense numbers for each side.
// Null if ESPN hasn't filled the box score in yet.
export function parseGameTeamStats(summary) {
  const teams = summary?.boxscore?.teams;
  const home = teams?.find((t) => t.homeAway === 'home');
  const away = teams?.find((t) => t.homeAway === 'away');
  if (!home?.statistics?.length || !away?.statistics?.length) return null;
  const build = (t) => {
    const stat = (name) => t.statistics.find((s) => s.name === name)?.displayValue ?? null;
    const [thirdConv, thirdAtt] = pair(stat('thirdDownEff'));
    const [fourthConv, fourthAtt] = pair(stat('fourthDownEff'));
    const [rzConv, rzAtt] = pair(stat('redZoneAttempts')); // "made-att"
    const [sacks, sackYds] = pair(stat('sacksYardsLost')); // sacks taken by this team's offense
    const [penalties, penaltyYds] = pair(stat('totalPenaltiesYards'));
    return {
      totalYds: num(stat('totalYards')),
      passYds: num(stat('netPassingYards')),
      rushYds: num(stat('rushingYards')),
      thirdConv, thirdAtt, fourthConv, fourthAtt, rzConv, rzAtt,
      sacks, sackYds, penalties, penaltyYds,
      turnovers: num(stat('turnovers')),
      possessionSecs: clock(stat('possessionTime')),
    };
  };
  return { home: build(home), away: build(away) };
}

export async function fetchGameTeamStats(espnId) {
  const res = await fetch(`${espnSite('summary')}?event=${encodeURIComponent(espnId)}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ESPN box score returned ${res.status}`);
  return parseGameTeamStats(await res.json());
}

// The scoreboard drops a game's line once it's over, so keep the last one we
// saw (or one looked up from the game page) when a week is re-fetched.
export function mergeWeek(oldGames = [], newGames) {
  const key = (g) => g.espnId ?? `${g.away.name}@${g.home.name}`;
  const before = new Map(oldGames.map((g) => [key(g), g]));
  return newGames.map((g) => {
    const old = before.get(key(g));
    if (!old) return g;
    return {
      ...g,
      homeLine: g.homeLine ?? old.homeLine ?? null,
      total: g.total ?? old.total ?? null,
      ...(old.lineChecked ? { lineChecked: old.lineChecked } : {}),
    };
  });
}

// The closing spread and total for a finished game, from ESPN's game page
// ("pickcenter"), or its odds feed if that's empty. Null if neither has one.
export async function fetchGameLine(game) {
  const pick = (list) => {
    for (const o of list ?? []) {
      const line = homeLine(o, game.home.abbr, game.away.abbr);
      const total = num(o?.overUnder);
      if (line != null || total != null) return { homeLine: line, total };
    }
    return null;
  };
  const get = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
    return res.json();
  };
  const summary = await get(`${espnSite('summary')}?event=${encodeURIComponent(game.espnId)}`);
  const found = pick(summary.pickcenter) ?? pick(summary.odds);
  if (found) return found;
  const odds = await get(`${espnCore()}/events/${encodeURIComponent(game.espnId)}/competitions/${encodeURIComponent(game.espnId)}/odds`);
  return pick(odds.items);
}

const rec = () => ({ w: 0, l: 0, t: 0 });
const add = (r, diff) => { if (diff > 0) r.w++; else if (diff < 0) r.l++; else r.t++; };
const pct = (r) => (r.w + r.l + r.t ? (r.w + r.t / 2) / (r.w + r.l + r.t) : null);

// Every team's numbers from the season's games. `fallbackLine(game)` can
// supply { homeLine, total } for games ESPN has no odds for. `boxscores` is
// `{ [espnId]: { home, away } }` from parseGameTeamStats, for whichever
// finished games have one fetched; games without an entry are skipped for
// the yards/sacks/turnovers/downs/red zone/penalties numbers (everything
// else still counts them).
export function buildTeams(games, fallbackLine = () => null, boxscores = {}) {
  const teams = new Map();
  const advZero = () => ({
    games: 0,
    offYds: 0, offPassYds: 0, offRushYds: 0, offSacks: 0, offSackYds: 0, offTO: 0,
    off3C: 0, off3A: 0, off4C: 0, off4A: 0, offRZC: 0, offRZA: 0, offPen: 0, offPenYds: 0, offPoss: 0,
    defYds: 0, defPassYds: 0, defRushYds: 0, defSacks: 0, defTO: 0,
    def3C: 0, def3A: 0, def4C: 0, def4A: 0, defRZC: 0, defRZA: 0,
  });
  const team = (t) => {
    if (!teams.has(t.name)) {
      teams.set(t.name, {
        name: t.name, abbr: t.abbr, short: t.short, conf: t.conf ?? null, logo: t.logo ?? null,
        record: rec(), home: rec(), away: rec(), pf: 0, pa: 0,
        ats: rec(), atsFav: rec(), atsDog: rec(), atsHome: rec(), atsAway: rec(), coverSum: 0,
        ou: rec(), totalSum: 0, lineTotalSum: 0, ouGames: 0,
        log: [], opponents: [], adv: advZero(),
      });
    }
    return teams.get(t.name);
  };
  const sorted = [...games].sort((a, b) => a.date.localeCompare(b.date));
  for (const g of sorted) {
    const fb = g.homeLine == null || g.total == null ? fallbackLine(g) : null;
    const line = g.homeLine ?? fb?.homeLine ?? null;
    const total = g.total ?? fb?.total ?? null;
    for (const [me, opp, isHome] of [[g.home, g.away, true], [g.away, g.home, false]]) {
      const t = team(me);
      team(opp);
      t.opponents.push({ name: opp.name, final: g.final });
      // The spread from this team's side: home line as is, flipped for away.
      const myLine = line == null ? null : isHome ? line : -line;
      const entry = { week: g.week, date: g.date, opp: opp.short, oppAbbr: opp.abbr, oppName: opp.name, home: isHome, final: g.final, line: myLine, total };
      if (g.final && me.score != null && opp.score != null) {
        const diff = me.score - opp.score;
        add(t.record, diff);
        add(isHome ? t.home : t.away, diff);
        t.pf += me.score;
        t.pa += opp.score;
        entry.score = `${me.score}-${opp.score}`;
        entry.result = diff > 0 ? 'W' : diff < 0 ? 'L' : 'T';
        if (myLine != null) {
          const cover = diff + myLine;
          add(t.ats, cover);
          add(myLine < 0 ? t.atsFav : t.atsDog, cover); // pick'em counts as underdog
          add(isHome ? t.atsHome : t.atsAway, cover);
          t.coverSum += cover;
          entry.cover = cover > 0 ? 'W' : cover < 0 ? 'L' : 'P';
        }
        if (total != null) {
          const pts = me.score + opp.score;
          add(t.ou, pts - total); // w = over, l = under, t = push
          t.totalSum += pts;
          t.lineTotalSum += total;
          t.ouGames++;
          entry.ou = pts > total ? 'O' : pts < total ? 'U' : 'P';
        }
        const box = g.espnId != null ? boxscores[g.espnId] : null;
        if (box) {
          const mine = box[isHome ? 'home' : 'away'];
          const theirs = box[isHome ? 'away' : 'home'];
          if (mine && theirs) {
            const a = t.adv;
            a.games++;
            a.offYds += mine.totalYds ?? 0; a.offPassYds += mine.passYds ?? 0; a.offRushYds += mine.rushYds ?? 0;
            a.offSacks += mine.sacks ?? 0; a.offSackYds += mine.sackYds ?? 0; a.offTO += mine.turnovers ?? 0;
            a.off3C += mine.thirdConv ?? 0; a.off3A += mine.thirdAtt ?? 0;
            a.off4C += mine.fourthConv ?? 0; a.off4A += mine.fourthAtt ?? 0;
            a.offRZC += mine.rzConv ?? 0; a.offRZA += mine.rzAtt ?? 0;
            a.offPen += mine.penalties ?? 0; a.offPenYds += mine.penaltyYds ?? 0; a.offPoss += mine.possessionSecs ?? 0;
            a.defYds += theirs.totalYds ?? 0; a.defPassYds += theirs.passYds ?? 0; a.defRushYds += theirs.rushYds ?? 0;
            a.defSacks += theirs.sacks ?? 0; a.defTO += theirs.turnovers ?? 0;
            a.def3C += theirs.thirdConv ?? 0; a.def3A += theirs.thirdAtt ?? 0;
            a.def4C += theirs.fourthConv ?? 0; a.def4A += theirs.fourthAtt ?? 0;
            a.defRZC += theirs.rzConv ?? 0; a.defRZA += theirs.rzAtt ?? 0;
          }
        }
      }
      t.log.push(entry);
    }
  }

  // Strength of schedule: opponents' win % so far, for games played and games
  // left. Ranked 1 = hardest.
  const winPct = new Map([...teams.values()].map((t) => [t.name, pct(t.record)]));
  const avg = (list) => {
    const vals = list.map((o) => winPct.get(o.name)).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  // College lists (and ranks) only Power 5 teams; their other opponents
  // still count toward strength of schedule above.
  const out = [...teams.values()].filter((t) => inSlate(t.conf)).map((t) => {
    const played = t.log.filter((e) => e.result);
    const results = played.map((e) => e.result);
    let streak = '';
    if (results.length) {
      const last = results[results.length - 1];
      let n = 0;
      for (let i = results.length - 1; i >= 0 && results[i] === last; i--) n++;
      streak = `${last}${n}`;
    }
    const n = played.length;
    return {
      name: t.name, abbr: t.abbr, short: t.short, logo: t.logo,
      record: t.record, home: t.home, away: t.away,
      ppg: n ? t.pf / n : null, papg: n ? t.pa / n : null, margin: n ? (t.pf - t.pa) / n : null,
      last5: results.slice(-5), streak,
      ats: t.ats, atsFav: t.atsFav, atsDog: t.atsDog, atsHome: t.atsHome, atsAway: t.atsAway,
      atsGames: t.ats.w + t.ats.l + t.ats.t,
      coverAvg: t.ats.w + t.ats.l + t.ats.t ? t.coverSum / (t.ats.w + t.ats.l + t.ats.t) : null,
      ou: t.ou, avgTotal: t.ouGames ? t.totalSum / t.ouGames : null, avgLineTotal: t.ouGames ? t.lineTotalSum / t.ouGames : null,
      sosPlayed: avg(t.opponents.filter((o) => o.final)),
      sosLeft: avg(t.opponents.filter((o) => !o.final)),
      log: t.log,
      ...advStats(t.adv),
    };
  });
  const rank = (key, asc = false) => {
    const ranked = out.filter((t) => t[key] != null).sort((a, b) => (asc ? a[key] - b[key] : b[key] - a[key]));
    ranked.forEach((t, i) => (t[`${key}Rank`] = i + 1));
  };
  rank('sosPlayed');
  rank('sosLeft');
  rank('ppg'); // 1st = most points scored per game
  rank('papg', true); // 1st = fewest points allowed per game
  rank('ydsPerGame'); rank('passYdsPerGame'); rank('rushYdsPerGame');
  rank('ydsAllowedPerGame', true); rank('passYdsAllowedPerGame', true); rank('rushYdsAllowedPerGame', true);
  rank('sacksAllowedPerGame', true); rank('sacksMadePerGame');
  rank('giveawaysPerGame', true); rank('takeawaysPerGame');
  rank('turnoverMargin');
  rank('thirdDownPct'); rank('thirdDownPctAllowed', true);
  rank('fourthDownPct'); rank('fourthDownPctAllowed', true);
  rank('redZonePct'); rank('redZonePctAllowed', true);
  rank('penaltyYdsPerGame', true);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Per-game rates and percentages from the raw totals `adv` collected above.
// Offense = this team's own output; defense = what they allowed/forced.
function advStats(a) {
  const n = a.games;
  const ratio = (c, att) => (att ? (c / att) * 100 : null);
  return {
    advGames: n,
    ydsPerGame: n ? a.offYds / n : null, passYdsPerGame: n ? a.offPassYds / n : null, rushYdsPerGame: n ? a.offRushYds / n : null,
    ydsAllowedPerGame: n ? a.defYds / n : null, passYdsAllowedPerGame: n ? a.defPassYds / n : null, rushYdsAllowedPerGame: n ? a.defRushYds / n : null,
    sacksAllowedPerGame: n ? a.offSacks / n : null, sacksMadePerGame: n ? a.defSacks / n : null,
    giveawaysPerGame: n ? a.offTO / n : null, takeawaysPerGame: n ? a.defTO / n : null,
    turnoverMargin: n ? (a.defTO - a.offTO) / n : null,
    thirdDownPct: ratio(a.off3C, a.off3A), thirdDownPctAllowed: ratio(a.def3C, a.def3A),
    fourthDownPct: ratio(a.off4C, a.off4A), fourthDownPctAllowed: ratio(a.def4C, a.def4A),
    redZonePct: ratio(a.offRZC, a.offRZA), redZonePctAllowed: ratio(a.defRZC, a.defRZA),
    penaltiesPerGame: n ? a.offPen / n : null, penaltyYdsPerGame: n ? a.offPenYds / n : null,
    possessionPerGame: n ? a.offPoss / n : null,
  };
}
