import { tally, selectionLabel } from './parlay.js';
import { gradeLeg, gradeParlay, singleProfit } from './grading.js';
import { weekLabel } from './week.js';

const record = () => ({ win: 0, loss: 0, push: 0, pending: 0 });

// Season stats from everything saved: each person's picks and money, the
// group's consensus picks, and every parlay you put money on.
export function computeStats(data, players) {
  const weeks = [...new Set([...Object.keys(data.picks), ...Object.keys(data.stakes)])]
    .filter((w) => !w.startsWith('demo'))
    .sort();

  const people = Object.fromEntries(players.map((p) => [p, {
    name: p,
    picks: record(),
    byMarket: { spread: record(), total: record(), ml: record() },
    flatNet: 0, // profit if they'd bet $10 on every pick
    staked: 0, // settled parlay money only
    returned: 0,
    inPlay: 0, // money on parlays not decided yet
  }]));
  const consensus = record();
  const parlayRecord = { won: 0, lost: 0, push: 0, pending: 0, staked: 0, returned: 0, inPlay: 0 };
  const weekly = [];

  for (const key of weeks) {
    const games = new Map((data.schedule[key]?.games ?? []).map((g) => [g.id, g]));
    const results = data.results[key] ?? {};
    const grade = (leg) => gradeLeg(leg, results[leg.key.split('|')[0]]);
    const label = (key, point) => {
      const [gameId, market, side] = key.split('|');
      const game = games.get(gameId);
      return game ? selectionLabel(game, market, side, point) : key;
    };

    // Each person's picks, graded as single bets.
    const weekPicks = Object.fromEntries(players.filter((p) => data.picks[key]?.[p]?.length).map((p) => [p, data.picks[key][p]]));
    const pickRows = {};
    for (const [who, picks] of Object.entries(weekPicks)) {
      pickRows[who] = picks.map((p) => {
        const g = grade(p);
        const person = people[who];
        person.picks[g]++;
        person.byMarket[p.key.split('|')[1]][g]++;
        person.flatNet += singleProfit(p.price, g);
        return { label: label(p.key, p.point), price: p.price, grade: g };
      });
    }

    // Consensus: bets a majority of that week's pickers agreed on.
    const voters = Object.keys(weekPicks).length;
    const need = voters <= 2 ? voters : Math.floor(voters / 2) + 1;
    const agreed = voters >= 2 ? tally(weekPicks, games).filter((s) => s.pickers.length >= need) : [];
    const consensusRows = agreed.map((s) => {
      const g = grade(s);
      consensus[g]++;
      return { label: s.label, price: s.price, pickers: s.pickers, grade: g };
    });

    // Parlays with money on them.
    const parlays = Object.values(data.stakes[key] ?? {}).map((p) => {
      const legs = p.legs.map((l) => ({ ...l, grade: grade(l) }));
      const stakes = Object.fromEntries(Object.entries(p.stakes).filter(([who]) => people[who]));
      const total = Object.values(stakes).reduce((a, b) => a + b, 0);
      const { status, returned } = gradeParlay(legs, total);
      parlayRecord[status]++;
      for (const [who, amt] of Object.entries(stakes)) {
        const share = gradeParlay(legs, amt).returned;
        if (status === 'pending') people[who].inPlay += amt;
        else {
          people[who].staked += amt;
          people[who].returned += share;
        }
      }
      if (status === 'pending') parlayRecord.inPlay += total;
      else {
        parlayRecord.staked += total;
        parlayRecord.returned += returned;
      }
      return { name: p.name, american: p.american, legs, stakes, total, status, returned };
    }).filter((p) => p.total > 0);

    weekly.push({
      key,
      label: weekLabel({ key, start: new Date(`${key}T12:00:00Z`) }),
      picks: pickRows,
      consensus: consensusRows,
      parlays,
      net: parlays.filter((p) => p.status !== 'pending').reduce((a, p) => a + p.returned - p.total, 0),
    });
  }

  for (const p of Object.values(people)) p.net = p.returned - p.staked;
  parlayRecord.net = parlayRecord.returned - parlayRecord.staked;
  return { players: Object.values(people), consensus, parlays: parlayRecord, weeks: weekly.reverse() };
}
