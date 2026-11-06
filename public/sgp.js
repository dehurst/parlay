// Same-game parlay estimate, shared by the server and the page.
//
// FanDuel prices legs from one game together: outcomes that tend to happen
// together (a team winning and its QB throwing TDs) pay less than their odds
// multiplied. Nobody outside FanDuel has its model, so this is an estimate:
// each pair of legs from the same game that move together cuts the payout,
// then an adjustment learned from your own placed same-game parlays (actual
// payout vs. this estimate) nudges it closer over time.
//
// Keys look like "gameId|market|side": spread/ml (home|away), total
// (over|under), and props "td:Player|yes", "ptd:Player|over|under".

// How a leg moves: a side (a team doing well), the total, or a player prop,
// and whether it rides on scoring going UP (over, a TD, more pass TDs).
function kind(key) {
  const [, market, side] = String(key).split('|');
  if (market === 'spread' || market === 'ml') return { cat: 'side', up: true };
  if (market === 'total') return { cat: 'total', up: side === 'over' };
  return { cat: 'prop', up: side !== 'under' };
}

// Payout multiplier for one pair of same-game legs. Calibrated so a team ML +
// its QB over pass TDs + a TD scorer (FanDuel paid about 0.56x the multiplied
// odds) comes out close. Pairs pulling opposite ways (an under with a TD) are
// left alone.
export const PAIR_FACTORS = { 'side+total': 0.95, 'prop+side': 0.84, 'prop+total': 0.86, 'prop+prop': 0.84 };
function pairFactor(a, b) {
  if (!a.up || !b.up) return 1;
  return PAIR_FACTORS[[a.cat, b.cat].sort().join('+')] ?? 1;
}

// Combined cut for every pair of legs that share a game (1 when none do).
export function sgpFactor(keys) {
  const byGame = new Map();
  for (const key of keys) {
    const game = String(key).split('|')[0];
    if (!byGame.has(game)) byGame.set(game, []);
    byGame.get(game).push(kind(key));
  }
  let factor = 1;
  for (const legs of byGame.values()) {
    for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) factor *= pairFactor(legs[i], legs[j]);
  }
  return Math.max(0.35, factor);
}

export const isSameGameKeys = (keys) => new Set(keys.map((k) => String(k).split('|')[0])).size < keys.length;

// The estimated payout multiplier (stake included) for legs priced at
// `decimal` multiplied, with `adjust` learned from past bets. Unchanged for
// legs from different games.
export function sgpDecimal(decimal, keys, adjust = 1) {
  if (!isSameGameKeys(keys)) return decimal;
  // Never below even money back, never above the multiplied odds.
  return Math.min(decimal, Math.max(1.01, decimal * sgpFactor(keys) * adjust));
}

// The learned adjustment from placed same-game parlays: how FanDuel's real
// payout compared with this estimate. Each is a ratio; their geometric mean is
// shrunk toward 1 (as if two bets had come in right on the estimate) so a
// single bet can't swing it far. Kept between 0.6 and 1.3.
export function learnAdjust(history) {
  let sum = 0;
  for (const { decimal, keys, actual } of history) {
    const est = decimal * sgpFactor(keys);
    if (est > 1 && actual > 1) sum += Math.log(actual / est);
  }
  return Math.min(1.3, Math.max(0.6, Math.exp(sum / (history.length + 2))));
}
