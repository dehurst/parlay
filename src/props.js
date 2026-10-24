// Player props: anytime touchdown scorer and passing touchdowns.
//
// A prop bet's key fits the usual "gameId|market|side" shape, with the player
// in the market so each player's bet is separate:
//   anytime TD:    "gameId|td:Christian McCaffrey|yes"
//   passing TDs:   "gameId|ptd:Patrick Mahomes|over" (or |under)

export const PROP_MARKETS = { td: 'player_anytime_td', ptd: 'player_pass_tds' };
export const PROP_SIDES = { td: ['yes'], ptd: ['over', 'under'] };

export const isProp = (market) => String(market).includes(':');

// "td:Christian McCaffrey" -> { type: 'td', player: 'Christian McCaffrey' }
export function propParts(market) {
  const i = market.indexOf(':');
  return { type: market.slice(0, i), player: market.slice(i + 1) };
}

// The kind of bet for records: 'spread', 'total', 'ml', or 'props'.
export const marketType = (market) => (isProp(market) ? 'props' : market);

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// "Kenneth Walker III" -> "K. Walker", "Amon-Ra St. Brown" -> "A. St. Brown"
export function shortName(player) {
  const parts = player.trim().split(/\s+/).filter((p) => !SUFFIXES.has(p.toLowerCase().replace(/\./g, '')));
  if (parts.length < 2) return player;
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

// For matching names across FanDuel and ESPN: lowercase letters only, no
// suffixes ("Kenneth Walker III" and "Kenneth Walker" both -> "kennethwalker").
export function normName(player) {
  return player.toLowerCase().split(/\s+/)
    .filter((p) => !SUFFIXES.has(p.replace(/\./g, '')))
    .join('')
    .replace(/[^a-z]/g, '');
}

// "C. McCaffrey TD", "P. Mahomes o1.5 pass TDs"
export function propLabel(market, side, point) {
  const { type, player } = propParts(market);
  const name = shortName(player);
  if (type === 'td') return `${name} TD`;
  return `${name} ${side === 'over' ? 'o' : 'u'}${point} pass TDs`;
}

// The current line for a prop from a game's props: { point, price } or null.
export function propLine(props, market, side) {
  if (!props) return null;
  const { type, player } = propParts(market);
  if (type === 'td') {
    const p = props.td?.find((x) => x.player === player);
    return p && side === 'yes' ? { point: null, price: p.price } : null;
  }
  const p = props.ptd?.find((x) => x.player === player);
  return p?.[side] != null ? { point: p.point, price: p[side] } : null;
}

export function validProp(market, side) {
  if (!isProp(market)) return false;
  const { type, player } = propParts(market);
  return !!PROP_SIDES[type]?.includes(side) && player.length > 0 && player.length <= 60;
}

// One game's props from The Odds API's event odds:
// { td: [{ player, price }], ptd: [{ player, point, over, under }] }
export function parseProps(event, book) {
  const bm = event?.bookmakers?.find((b) => b.key === book);
  const out = { td: [], ptd: [] };
  if (!bm) return out;
  const market = (key) => bm.markets?.find((m) => m.key === key)?.outcomes ?? [];
  // The player is in `description` ("Yes"/"Over" in `name`); older responses
  // put the player in `name`.
  const who = (o) => (o.description || o.name || '').trim();
  for (const o of market(PROP_MARKETS.td)) {
    if (o.name === 'No') continue;
    out.td.push({ player: who(o), price: o.price });
  }
  const qbs = new Map();
  for (const o of market(PROP_MARKETS.ptd)) {
    const player = who(o);
    const side = o.name?.toLowerCase();
    if (!['over', 'under'].includes(side)) continue;
    const row = qbs.get(player) ?? { player, point: o.point, over: null, under: null };
    row[side] = o.price;
    qbs.set(player, row);
  }
  out.ptd = [...qbs.values()];
  out.td.sort((a, b) => a.price - b.price); // most likely scorers first
  return out;
}

// Touchdowns per player from ESPN's game summary box score:
// { normName: { td, passTd } }. Anytime TD counts every touchdown a player
// scores (rushing, receiving, returns), not the ones they throw.
export function parseBoxScore(summary) {
  const out = {};
  for (const team of summary?.boxscore?.players ?? []) {
    for (const cat of team.statistics ?? []) {
      const keys = cat.keys ?? [];
      const labels = cat.labels ?? [];
      const tdCols = [];
      keys.forEach((k, i) => { if (/touchdowns$/i.test(k)) tdCols.push({ i, passing: /^passing/i.test(k) }); });
      // Fall back to the "TD" column when keys aren't there.
      if (!tdCols.length) labels.forEach((l, i) => { if (l === 'TD') tdCols.push({ i, passing: cat.name === 'passing' }); });
      for (const a of cat.athletes ?? []) {
        const name = a.athlete?.displayName;
        if (!name) continue;
        const row = (out[normName(name)] ??= { td: 0, passTd: 0 });
        for (const col of tdCols) {
          const n = Number(a.stats?.[col.i]) || 0;
          if (col.passing) row.passTd += n;
          else row.td += n;
        }
      }
    }
  }
  return out;
}

// Grade a prop against a game's player stats ({ normName: { td, passTd } }).
// A player who didn't play (not in the box score) is a push, like a void at
// the sportsbook.
export function gradeProp(market, side, point, players) {
  if (!players) return 'pending';
  const { type, player } = propParts(market);
  const row = players[normName(player)];
  if (!row) return 'push';
  if (type === 'td') return row.td > 0 ? 'win' : 'loss';
  const diff = side === 'over' ? row.passTd - point : point - row.passTd;
  return diff > 0 ? 'win' : diff < 0 ? 'loss' : 'push';
}
