import { americanToDecimal, impliedProb, estFairProb } from './odds-math.js';
import { gradeLeg, legMargin, singleProfit } from './grading.js';
import { selectionLabel, tally } from './parlay.js';
import { isProp } from './props.js';

// Analysis tab: win chances from the book's own prices, other ways to bet the
// same game, and a look back at what nearly hit. No model: the odds (with the
// book's cut removed) are the market's estimate, and that's what this uses.

const OTHER = { home: 'away', away: 'home', over: 'under', under: 'over' };

// Chance a bet wins, from the book's prices on both sides with its cut
// removed. If the line has moved off the one you got, or the other side's
// price is missing, fall back to stripping a typical cut from your price.
export function fairChance(lines, market, side, pick = null) {
  const mine = lines?.[market]?.[side];
  const other = lines?.[market]?.[OTHER[side]];
  if (mine && other && (!pick || mine.point === pick.point)) {
    const a = impliedProb(mine.price);
    const b = impliedProb(other.price);
    return a / (a + b);
  }
  const price = pick?.price ?? mine?.price;
  return price == null ? null : estFairProb(price);
}

// The other way to back the same team: spread <-> moneyline. Totals have none
// (alternate totals aren't pulled).
function alternative(game, market, side) {
  if (market === 'total') return null;
  const altMarket = market === 'spread' ? 'ml' : 'spread';
  const line = game.lines?.[altMarket]?.[side] ?? null;
  if (altMarket === 'spread' && !line) return null; // need the spread's number
  return {
    key: `${game.id}|${altMarket}|${side}`,
    market: altMarket,
    point: line?.point ?? null,
    price: line?.price ?? null,
    label: selectionLabel(game, altMarket, side, line?.point ?? null),
  };
}

const pays = (price, stake = 10) => (price == null ? null : stake * americanToDecimal(price));

// Your picks on games that haven't started: the chance each one hits, and the
// spread/moneyline alternative for the same team.
function upcoming(games, myPicks) {
  const byId = new Map(games.map((g) => [g.id, g]));
  return myPicks
    .map((p) => {
      const [gameId, market, side] = p.key.split('|');
      const game = byId.get(gameId);
      if (!game || game.started || p.price == null) return null;
      const alt = alternative(game, market, side);
      return {
        key: p.key,
        label: selectionLabel(game, market, side, p.point),
        matchup: `${game.away} @ ${game.home}`,
        commence: game.commence,
        market,
        price: p.price,
        chance: fairChance(game.lines, market, side, p),
        pays: pays(p.price),
        alt: alt?.price == null ? null : { ...alt, chance: fairChance(game.lines, alt.market, side), pays: pays(alt.price) },
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.commence.localeCompare(b.commence));
}

// Parlays with money on them that aren't decided: the chance the rest of it
// hits, leg by leg (legs that already won count as done).
function liveParlays(parlays, games) {
  const byId = new Map(games.map((g) => [g.id, g]));
  return parlays
    .filter((p) => p.status === 'pending')
    .map((p) => {
      const left = p.legs
        .filter((l) => l.grade === 'pending')
        .map((l) => {
          const [gameId, market, side] = l.key.split('|');
          return { label: l.label, price: l.price, chance: fairChance(byId.get(gameId)?.lines, market, side, l) };
        });
      const known = left.every((l) => l.chance != null);
      return {
        id: p.id,
        name: p.name,
        legs: p.legs.length,
        won: p.legs.filter((l) => l.grade === 'win').length,
        total: p.total,
        payout: p.payout,
        left: left.sort((a, b) => (a.chance ?? 1) - (b.chance ?? 1)),
        hitChance: known ? left.reduce((c, l) => c * l.chance, 1) : null,
      };
    })
    .sort((a, b) => b.total - a.total);
}

// What a losing bet would have needed: how far it missed, and whether the
// other way to back that team (spread <-> moneyline) would have won.
function missInfo(game, leg) {
  const [, market, side] = leg.key.split('|');
  if (isProp(market)) return { margin: null, alt: null }; // no points to miss by
  const margin = legMargin(leg, game.result);
  const alt = alternative(game, market, side);
  const altWon = alt && gradeLeg(alt, game.result) === 'win';
  return { margin, alt: altWon ? { label: alt.label, price: alt.price } : null };
}

// Lost picks on finished games, everyone's, grouped by bet: how close each
// came and what would have hit instead. Closest misses first.
function misses(games, picks) {
  const byId = new Map(games.map((g) => [g.id, g]));
  return tally(picks, byId)
    .map((s) => {
      const game = byId.get(s.gameId);
      // Props are left out: there's no score margin or alternative to show.
      if (isProp(s.market) || !game?.result || gradeLeg(s, game.result) !== 'loss') return null;
      return { label: s.label, matchup: s.matchup, price: s.price, pickers: s.pickers, market: s.market, ...missInfo(game, s) };
    })
    .filter(Boolean)
    .sort((a, b) => b.margin - a.margin);
}

// Lost parlays that only one leg sank, and what that leg's alternative would
// have paid (when we have its price).
function oneLegAway(parlays, games) {
  const byId = new Map(games.map((g) => [g.id, g]));
  return parlays
    .filter((p) => p.status === 'lost' && p.legs.filter((l) => l.grade === 'loss').length === 1)
    .map((p) => {
      const leg = p.legs.find((l) => l.grade === 'loss');
      const game = byId.get(leg.key.split('|')[0]);
      const info = game?.result ? missInfo(game, leg) : { margin: null, alt: null };
      // Payout with the alternative in place of the losing leg: the other legs
      // as they finished (pushes drop out), times the alternative's odds.
      let altPayout = null;
      if (info.alt?.price != null) {
        const rest = p.legs.filter((l) => l !== leg && l.grade === 'win').reduce((d, l) => d * americanToDecimal(l.price), 1);
        altPayout = p.total * rest * americanToDecimal(info.alt.price);
      }
      return {
        id: p.id, name: p.name, total: p.total, payout: p.payout,
        leg: { label: leg.label, price: leg.price, margin: info.margin },
        alt: info.alt ? { ...info.alt, payout: altPayout } : null,
      };
    });
}

// Same money, two ways: the parlays as placed, or that stake split evenly
// across the same legs as straight bets. `parlays` are settled stats parlays.
export function parlaysVsSingles(parlays) {
  const out = { count: 0, staked: 0, parlayNet: 0, singlesNet: 0 };
  for (const p of parlays) {
    if (p.status === 'pending' || !p.total) continue;
    out.count++;
    out.staked += p.total;
    out.parlayNet += p.returned - p.total;
    const each = p.total / p.legs.length;
    for (const l of p.legs) out.singlesNet += singleProfit(l.price, l.grade, each);
  }
  return out;
}

// Everything on the Analysis tab for one week.
// games: the week's games with lines, result, and started; picks: everyone's
// submitted picks; myPicks: your picks (or selections) to rate; parlays: the
// week's graded parlays with money on them; stats: { week, season } from
// computeStats, for parlays vs. straight bets.
export function analyzeWeek({ games, picks, myPicks, parlays, stats }) {
  return {
    mine: upcoming(games, myPicks),
    live: liveParlays(parlays, games),
    misses: misses(games, picks),
    oneLegAway: oneLegAway(parlays, games),
    vsSingles: {
      week: parlaysVsSingles(stats.week.weeks.flatMap((w) => w.parlays)),
      season: parlaysVsSingles(stats.season.weeks.flatMap((w) => w.parlays)),
    },
  };
}
