// Research tab: every team's season so far from ESPN's scoreboard (free):
// record, home/away, points, against the spread, over/under, strength of
// schedule, and a game log. Lines come from ESPN's scoreboard odds; games
// without them fall back to the FanDuel lines this app saved.

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
export const REGULAR_SEASON_WEEKS = 18;

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// The season a date belongs to (Jan/Feb games are the previous season's).
export function seasonYear(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() < 2 ? y - 1 : y;
}

export async function fetchSeasonWeek(season, week) {
  const res = await fetch(`${ESPN}?seasontype=2&week=${week}&dates=${season}`, { signal: AbortSignal.timeout(8000) });
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
    const status = comp.status?.type ?? ev.status?.type ?? {};
    const odds = comp.odds?.[0];
    const team = (c) => ({ name: c.team.displayName, abbr: c.team.abbreviation, short: c.team.shortDisplayName ?? c.team.name, score: num(c.score) });
    return {
      week,
      date: ev.date,
      final: !!status.completed,
      home: team(h),
      away: team(a),
      homeLine: homeLine(odds, h.team.abbreviation, a.team.abbreviation),
      total: num(odds?.overUnder),
    };
  }).filter(Boolean);
}

const rec = () => ({ w: 0, l: 0, t: 0 });
const add = (r, diff) => { if (diff > 0) r.w++; else if (diff < 0) r.l++; else r.t++; };
const pct = (r) => (r.w + r.l + r.t ? (r.w + r.t / 2) / (r.w + r.l + r.t) : null);

// Every team's numbers from the season's games. `fallbackLine(game)` can
// supply { homeLine, total } for games ESPN has no odds for.
export function buildTeams(games, fallbackLine = () => null) {
  const teams = new Map();
  const team = (t) => {
    if (!teams.has(t.name)) {
      teams.set(t.name, {
        name: t.name, abbr: t.abbr, short: t.short,
        record: rec(), home: rec(), away: rec(), pf: 0, pa: 0,
        ats: rec(), atsFav: rec(), atsDog: rec(), atsHome: rec(), atsAway: rec(), coverSum: 0,
        ou: rec(), totalSum: 0, lineTotalSum: 0, ouGames: 0,
        log: [], opponents: [],
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
  const out = [...teams.values()].map((t) => {
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
      name: t.name, abbr: t.abbr, short: t.short,
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
    };
  });
  const rank = (key) => {
    const ranked = out.filter((t) => t[key] != null).sort((a, b) => b[key] - a[key]);
    ranked.forEach((t, i) => (t[`${key}Rank`] = i + 1));
  };
  rank('sosPlayed');
  rank('sosLeft');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
