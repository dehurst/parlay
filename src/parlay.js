import { americanToDecimal, decimalToAmerican } from './odds-math.js';

// picksByUser: { name: [selectionKey, ...] }
// Returns every picked selection with who picked it, most popular first.
export function tally(picksByUser, selectionsByKey) {
  const counts = new Map();
  for (const [user, keys] of Object.entries(picksByUser)) {
    for (const key of keys) {
      const sel = selectionsByKey.get(key);
      if (!sel) continue;
      if (!counts.has(key)) counts.set(key, { ...sel, pickers: [] });
      counts.get(key).pickers.push(user);
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.pickers.length - a.pickers.length || b.fairProb - a.fairProb,
  );
}

// Combine legs into one parlay with price, payout, and an honest edge estimate.
export function priceParlay(legs, stake = 10) {
  const decimal = legs.reduce((d, l) => d * americanToDecimal(l.price), 1);
  const trueProb = legs.reduce((p, l) => p * l.fairProb, 1);
  return {
    legs,
    decimal,
    american: decimalToAmerican(decimal),
    payout: stake * decimal,
    stake,
    // Chance of hitting, estimated from vig-free lines.
    hitProb: trueProb,
    // Expected return per $1 at those probabilities (negative = house edge).
    ev: trueProb * decimal - 1,
  };
}

// Keep only the most popular selection per game: books won't let you parlay
// both sides of a game, and many limit same-game combos in regular parlays.
function onePerGame(selections) {
  const seen = new Set();
  return selections.filter((s) => (seen.has(s.gameId) ? false : seen.add(s.gameId)));
}

const sameLegs = (a, b) =>
  a.length === b.length && a.every((l) => b.some((m) => m.key === l.key));

// Build a few parlay options out of what the group agrees on.
// voters: number of friends who made at least one pick this week.
// minShare: fraction of voters a pick needs to count as consensus (strict >).
export function buildParlays(tallied, voters, { minShare = 0.5, now = new Date(), stake = 10 } = {}) {
  if (voters === 0) return { need: 0, voters, consensus: [], options: [], almost: [] };
  const open = tallied.filter((s) => new Date(s.commence) > now);
  const need = voters <= 2 ? voters : Math.floor(voters * minShare) + 1;
  const consensus = onePerGame(open.filter((s) => s.pickers.length >= need));
  const unanimous = consensus.filter((s) => s.pickers.length === voters);

  const options = [];
  const add = (name, blurb, legs) => {
    if (legs.length < 2) return;
    if (options.some((o) => sameLegs(o.legs, legs))) return;
    options.push({ name, blurb, ...priceParlay(legs, stake) });
  };

  add('Everybody Agrees', `Every pick all ${voters} of you made.`, unanimous);
  add('Crowd Favorites', 'The 3 most-picked plays.', consensus.slice(0, 3));
  // Leave one play out when the pool is small so these differ from Crowd Favorites.
  const size = Math.min(3, consensus.length - 1);
  add(
    'Safest Majority',
    `The ${size} majority picks most likely to hit, per the lines.`,
    [...consensus].sort((a, b) => b.fairProb - a.fairProb).slice(0, size),
  );
  add(
    'Plus-Money Swing',
    `The ${size} majority picks with the biggest payouts.`,
    [...consensus].sort((a, b) => a.fairProb - b.fairProb).slice(0, size),
  );
  add('Full Send', `Every majority pick (${consensus.length} legs).`, consensus);

  // Near-misses help the group see what's one vote short.
  const inConsensus = new Set(consensus.map((s) => s.gameId));
  const almost = onePerGame(
    open.filter((s) => s.pickers.length === need - 1 && s.pickers.length >= 1 && !inConsensus.has(s.gameId)),
  );
  return { need, voters, consensus, options, almost };
}
