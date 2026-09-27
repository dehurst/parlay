import { fairProb } from './odds-math.js';

const API = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds';

// Fetch raw events from The Odds API for the given window.
// Costs 3 credits per call (one per market, one region).
export async function fetchOdds({ apiKey, start, end }) {
  const params = new URLSearchParams({
    apiKey,
    regions: 'us',
    markets: 'h2h,spreads,totals',
    oddsFormat: 'american',
    commenceTimeFrom: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    commenceTimeTo: end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odds API ${res.status}: ${body.slice(0, 200)}`);
  }
  return {
    events: await res.json(),
    remaining: res.headers.get('x-requests-remaining'),
  };
}

// Turn Odds API events into games with a flat list of pickable selections.
export function normalizeEvents(events, preferredBook) {
  return events
    .map((ev) => {
      const book = ev.bookmakers?.find((b) => b.key === preferredBook) ?? ev.bookmakers?.[0];
      if (!book) return null;
      const market = (key) => book.markets.find((m) => m.key === key)?.outcomes ?? [];
      const game = {
        id: ev.id,
        commence: ev.commence_time,
        home: ev.home_team,
        away: ev.away_team,
        book: book.title,
        selections: [],
      };
      addPair(game, 'ml', market('h2h'), ev);
      addPair(game, 'spread', market('spreads'), ev);
      addPair(game, 'total', market('totals'), ev);
      return game;
    })
    .filter(Boolean)
    .sort((a, b) => a.commence.localeCompare(b.commence));
}

function addPair(game, marketKey, outcomes, ev) {
  if (outcomes.length !== 2) return;
  const sideOf = (o) =>
    marketKey === 'total' ? o.name.toLowerCase() : o.name === ev.home_team ? 'home' : 'away';
  const [a, b] = outcomes;
  for (const [o, other] of [[a, b], [b, a]]) {
    const side = sideOf(o);
    game.selections.push({
      key: `${game.id}|${marketKey}|${side}`,
      gameId: game.id,
      market: marketKey,
      side,
      price: o.price,
      point: o.point ?? null,
      fairProb: fairProb(o.price, other.price),
      label: selectionLabel(marketKey, o),
    });
  }
}

function selectionLabel(market, o) {
  if (market === 'ml') return `${o.name} ML`;
  if (market === 'spread') return `${o.name} ${o.point > 0 ? '+' : ''}${o.point}`;
  return `${o.name} ${o.point}`;
}

// Demo slate in the same shape the API returns, spread across the given week.
export function demoEvents(start) {
  const matchups = [
    ['Buffalo Bills', 'Miami Dolphins', -6.5, 47.5, 'thu'],
    ['Kansas City Chiefs', 'Denver Broncos', -3.5, 44.5, 'sun1'],
    ['Philadelphia Eagles', 'Dallas Cowboys', -4, 48.5, 'sun1'],
    ['Baltimore Ravens', 'Cincinnati Bengals', -2.5, 51.5, 'sun1'],
    ['Detroit Lions', 'Green Bay Packers', -1.5, 49.5, 'sun1'],
    ['Houston Texans', 'Jacksonville Jaguars', -5.5, 43.5, 'sun1'],
    ['Tampa Bay Buccaneers', 'New Orleans Saints', -3, 45.5, 'sun1'],
    ['Pittsburgh Steelers', 'Cleveland Browns', -7, 38.5, 'sun1'],
    ['San Francisco 49ers', 'Los Angeles Rams', -2.5, 46.5, 'sun4'],
    ['Seattle Seahawks', 'Arizona Cardinals', -3, 45, 'sun4'],
    ['Los Angeles Chargers', 'Las Vegas Raiders', -6, 42.5, 'sun4'],
    ['Minnesota Vikings', 'Chicago Bears', -1, 44, 'snf'],
    ['New York Jets', 'New England Patriots', 2.5, 40.5, 'mnf'],
  ];
  // Offsets from Tuesday 12:00 UTC to typical ET kickoffs (EDT, UTC-4).
  const M = 60 * 1000;
  const at = (day, h, m) => ((day * 24 + h) * 60 + m) * M;
  const slot = { thu: at(2, 12, 15), sun1: at(5, 5, 0), sun4: at(5, 8, 25), snf: at(5, 12, 20), mnf: at(6, 12, 15) };
  return matchups.map(([home, away, spread, total, s], i) => {
    const [homeMl, awayMl] = moneylineFromSpread(spread);
    return {
      id: `demo-${start.toISOString().slice(0, 10)}-${i}`,
      commence_time: new Date(start.getTime() + slot[s]).toISOString(),
      home_team: home,
      away_team: away,
      bookmakers: [
        {
          key: 'demo',
          title: 'Demo Odds',
          markets: [
            { key: 'h2h', outcomes: [{ name: home, price: homeMl }, { name: away, price: awayMl }] },
            {
              key: 'spreads',
              outcomes: [
                { name: home, price: -110, point: spread },
                { name: away, price: -110, point: -spread },
              ],
            },
            {
              key: 'totals',
              outcomes: [
                { name: 'Over', price: -110, point: total },
                { name: 'Under', price: -110, point: total },
              ],
            },
          ],
        },
      ],
    };
  });
}

// Rough spread -> moneyline conversion, good enough for demo data.
function moneylineFromSpread(spread) {
  const fav = Math.round((100 + Math.abs(spread) * 42) / 5) * 5;
  const dog = Math.max(fav - 20, 100);
  if (spread === 0) return [-110, -110];
  return spread < 0 ? [-fav, dog] : [dog, -fav];
}
