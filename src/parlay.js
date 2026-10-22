import { americanToDecimal, decimalToAmerican, estFairProb } from './odds-math.js';
import { isProp, propLabel } from './props.js';

export const MARKETS = {
  spread: ['home', 'away'],
  total: ['over', 'under'],
  ml: ['home', 'away'],
};

const fmtPoint = (p) => (p > 0 ? `+${p}` : `${p}`);

export function selectionLabel(game, market, side, point) {
  if (isProp(market)) return propLabel(market, side, point);
  if (market === 'total') return `${side === 'over' ? 'Over' : 'Under'} ${point}`;
  const team = side === 'home' ? game.homeShort : game.awayShort;
  return market === 'ml' ? `${team} ML` : `${team} ${fmtPoint(point)}`;
}

// The value that shows up most often; ties go to the first one entered.
function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
}

// picksByUser: { name: [{ key, point, price }] } where key = "gameId|market|side".
// Groups everyone's picks of the same side of the same bet, even if they got
// slightly different lines, and settles on the most common one.
export function tally(picksByUser, gamesById) {
  const groups = new Map();
  for (const [user, entries] of Object.entries(picksByUser)) {
    for (const e of entries) {
      const [gameId, market, side] = e.key.split('|');
      const game = gamesById.get(gameId);
      if (!game) continue;
      if (!groups.has(e.key)) {
        groups.set(e.key, {
          key: e.key, gameId, market, side, game,
          commence: game.commence,
          matchup: `${game.away} @ ${game.home}`,
          entries: [],
        });
      }
      groups.get(e.key).entries.push({ user, point: e.point, price: e.price });
    }
  }

  const tallied = [...groups.values()].map(({ entries, game, ...g }) => {
    const point = mode(entries.map((e) => e.point));
    const price = mode(entries.filter((e) => e.point === point).map((e) => e.price));
    const lines = new Map();
    for (const e of entries) {
      const id = `${e.point}|${e.price}`;
      if (!lines.has(id)) lines.set(id, { point: e.point, price: e.price, users: [] });
      lines.get(id).users.push(e.user);
    }
    return {
      ...g,
      point,
      price,
      label: selectionLabel(game, g.market, g.side, point),
      fairProb: estFairProb(price),
      pickers: entries.map((e) => e.user),
      lines: [...lines.values()],
    };
  });
  return tallied.sort((a, b) => b.pickers.length - a.pickers.length || b.fairProb - a.fairProb);
}

// Combine legs into one parlay with price, payout, and a rough edge estimate.
export function priceParlay(legs, stake = 10) {
  const decimal = legs.reduce((d, l) => d * americanToDecimal(l.price), 1);
  const hitProb = legs.reduce((p, l) => p * l.fairProb, 1);
  return {
    legs,
    decimal,
    american: decimalToAmerican(decimal),
    payout: stake * decimal,
    stake,
    hitProb,
    // Expected return per $1 at those probabilities (negative = house edge).
    ev: hitProb * decimal - 1,
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
// startedIds: games that have kicked off and can't be bet anymore.
export function buildParlays(tallied, voters, { startedIds = new Set(), stake = 10 } = {}) {
  if (voters === 0) return { need: 0, voters, consensus: [], options: [], almost: [] };
  const open = tallied.filter((s) => !startedIds.has(s.gameId));
  const need = voters <= 2 ? voters : Math.floor(voters / 2) + 1;
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
