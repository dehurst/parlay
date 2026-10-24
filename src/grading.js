import { americanToDecimal } from './odds-math.js';
import { isProp, gradeProp } from './props.js';

// Grade one bet against a final score: 'win' | 'loss' | 'push' | 'pending'.
// A leg is { key: "gameId|market|side", point, price }. Moneylines push on a
// tie, as they do at FanDuel for NFL two-way moneylines.
export function gradeLeg(leg, result) {
  if (!result) return 'pending';
  // Props grade from the game's player stats (result.players), once fetched.
  const [, market, side] = leg.key.split('|');
  if (isProp(market)) return gradeProp(market, side, leg.point, result.players);
  const diff = legMargin(leg, result);
  return diff > 0 ? 'win' : diff < 0 ? 'loss' : 'push';
}

// How many points a bet won (+) or lost (-) by against a final score.
export function legMargin(leg, { homeScore: h, awayScore: a }) {
  const [, market, side] = leg.key.split('|');
  if (market === 'spread') return (side === 'home' ? h - a : a - h) + leg.point;
  if (market === 'total') return side === 'over' ? h + a - leg.point : leg.point - (h + a);
  return side === 'home' ? h - a : a - h;
}

// Grade a parlay whose legs already carry a `grade`. Any loss loses it; a
// pushed leg drops out and the rest pay as a smaller parlay; all pushes
// refund the stake. `returned` is the total paid back (stake included).
// `scale` adjusts for the real payout when it differs from the legs' odds
// (e.g. the bet was placed at moved lines): actual multiplier / estimated.
export function gradeParlay(legs, stake, scale = 1) {
  if (legs.some((l) => l.grade === 'loss')) return { status: 'lost', returned: 0 };
  if (legs.some((l) => l.grade === 'pending')) return { status: 'pending', returned: null };
  const wins = legs.filter((l) => l.grade === 'win');
  if (!wins.length) return { status: 'push', returned: stake };
  const decimal = wins.reduce((d, l) => d * americanToDecimal(l.price), 1);
  return { status: 'won', returned: stake * decimal * scale };
}

// Multiplier the parlay actually pays: the payout entered when it was placed
// (divided by the total stake), else the estimate from its legs' odds.
export function actualDecimal(p, totalStake) {
  return p.placed?.payout && totalStake > 0 ? p.placed.payout / totalStake : p.decimal;
}

// Profit from betting `stake` on a single pick (used for "if you'd bet $10 on
// every pick" stats).
export function singleProfit(price, grade, stake = 10) {
  if (grade === 'win') return stake * (americanToDecimal(price) - 1);
  if (grade === 'loss') return -stake;
  return 0;
}
