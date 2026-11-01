// Game-day weather for the heat map, NFL only: the hourly forecast at the home
// team's stadium from 3 hours before kickoff to 4 hours after, from
// Open-Meteo (free, no key). Domes get no forecast; retractable roofs do,
// since the roof may be open.

// Each home stadium: where it is and its roof ('dome', 'retractable', or
// 'open'). SoFi's fixed canopy counts as a dome. By team nickname.
const STADIUMS = {
  cardinals: { name: 'State Farm Stadium', lat: 33.5276, lon: -112.2626, roof: 'retractable' },
  falcons: { name: 'Mercedes-Benz Stadium', lat: 33.7554, lon: -84.4008, roof: 'retractable' },
  ravens: { name: 'M&T Bank Stadium', lat: 39.278, lon: -76.6227, roof: 'open' },
  bills: { name: 'Highmark Stadium', lat: 42.7738, lon: -78.787, roof: 'open' },
  panthers: { name: 'Bank of America Stadium', lat: 35.2258, lon: -80.8528, roof: 'open' },
  bears: { name: 'Soldier Field', lat: 41.8623, lon: -87.6167, roof: 'open' },
  bengals: { name: 'Paycor Stadium', lat: 39.0954, lon: -84.516, roof: 'open' },
  browns: { name: 'Huntington Bank Field', lat: 41.5061, lon: -81.6995, roof: 'open' },
  cowboys: { name: 'AT&T Stadium', lat: 32.7473, lon: -97.0945, roof: 'retractable' },
  broncos: { name: 'Empower Field', lat: 39.7439, lon: -105.0201, roof: 'open' },
  lions: { name: 'Ford Field', lat: 42.34, lon: -83.0456, roof: 'dome' },
  packers: { name: 'Lambeau Field', lat: 44.5013, lon: -88.0622, roof: 'open' },
  texans: { name: 'NRG Stadium', lat: 29.6847, lon: -95.4107, roof: 'retractable' },
  colts: { name: 'Lucas Oil Stadium', lat: 39.7601, lon: -86.1639, roof: 'retractable' },
  jaguars: { name: 'EverBank Stadium', lat: 30.3239, lon: -81.6373, roof: 'open' },
  chiefs: { name: 'Arrowhead Stadium', lat: 39.0489, lon: -94.4839, roof: 'open' },
  raiders: { name: 'Allegiant Stadium', lat: 36.0909, lon: -115.1833, roof: 'dome' },
  chargers: { name: 'SoFi Stadium', lat: 33.9535, lon: -118.3392, roof: 'dome' },
  rams: { name: 'SoFi Stadium', lat: 33.9535, lon: -118.3392, roof: 'dome' },
  dolphins: { name: 'Hard Rock Stadium', lat: 25.958, lon: -80.2389, roof: 'open' },
  vikings: { name: 'U.S. Bank Stadium', lat: 44.9738, lon: -93.2581, roof: 'dome' },
  patriots: { name: 'Gillette Stadium', lat: 42.0909, lon: -71.2643, roof: 'open' },
  saints: { name: 'Caesars Superdome', lat: 29.9511, lon: -90.0812, roof: 'dome' },
  giants: { name: 'MetLife Stadium', lat: 40.8135, lon: -74.0745, roof: 'open' },
  jets: { name: 'MetLife Stadium', lat: 40.8135, lon: -74.0745, roof: 'open' },
  eagles: { name: 'Lincoln Financial Field', lat: 39.9008, lon: -75.1675, roof: 'open' },
  steelers: { name: 'Acrisure Stadium', lat: 40.4468, lon: -80.0158, roof: 'open' },
  '49ers': { name: "Levi's Stadium", lat: 37.403, lon: -121.97, roof: 'open' },
  seahawks: { name: 'Lumen Field', lat: 47.5952, lon: -122.3316, roof: 'open' },
  buccaneers: { name: 'Raymond James Stadium', lat: 27.9759, lon: -82.5033, roof: 'open' },
  titans: { name: 'Nissan Stadium', lat: 36.1665, lon: -86.7713, roof: 'open' },
  commanders: { name: 'Northwest Stadium', lat: 38.9077, lon: -76.8645, roof: 'open' },
};
export const stadiumFor = (home) => STADIUMS[String(home).split(' ').pop().toLowerCase()] ?? null;

const HOUR = 3600e3;
const BEFORE = 3;
const AFTER = 4;
const FIELDS = 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day';
// "2026-11-01T18:00" (UTC), as Open-Meteo takes and returns hours.
const utcHour = (ms) => new Date(ms).toISOString().slice(0, 13) + ':00';

// Open-Meteo's hourly response -> [{ time (ISO), temp (°F), rain (% chance),
// code (WMO weather code), wind, gusts (mph), dir (degrees), day }].
export function parseHours(data) {
  const h = data?.hourly;
  if (!h?.time?.length) return [];
  return h.time.map((t, i) => ({
    time: `${t}:00Z`,
    temp: h.temperature_2m?.[i] ?? null,
    rain: h.precipitation_probability?.[i] ?? null,
    code: h.weather_code?.[i] ?? null,
    wind: h.wind_speed_10m?.[i] ?? null,
    gusts: h.wind_gusts_10m?.[i] ?? null,
    dir: h.wind_direction_10m?.[i] ?? null,
    day: h.is_day?.[i] === 1,
  })).filter((x) => x.temp != null);
}

// Forecasts change through the day, so keep each for half an hour.
const cache = new Map();
const TTL = 30 * 60e3;

// { stadium, roof, hours: [...], kickoff } for a game, or { roof: 'dome' }
// with no hours. Hours is empty when the forecast doesn't reach that far
// out yet (about 2 weeks). Null for a home team we don't know.
export async function gameWeather(game, now = Date.now()) {
  const stadium = stadiumFor(game.home);
  if (!stadium) return null;
  const base = { stadium: stadium.name, roof: stadium.roof, kickoff: game.commence };
  if (stadium.roof === 'dome') return { ...base, hours: [] };
  const kick = Math.floor(new Date(game.commence).getTime() / HOUR) * HOUR;
  const key = `${stadium.lat},${stadium.lon},${kick}`;
  const cached = cache.get(key);
  if (cached && now - cached.at < TTL) return { ...base, hours: cached.hours };
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${stadium.lat}&longitude=${stadium.lon}&hourly=${FIELDS}`
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT'
    + `&start_hour=${utcHour(kick - BEFORE * HOUR)}&end_hour=${utcHour(kick + AFTER * HOUR)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  // Too far out (or too long ago) for a forecast: Open-Meteo says 400.
  if (res.status === 400) return { ...base, hours: [] };
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
  const hours = parseHours(await res.json());
  cache.set(key, { at: now, hours });
  return { ...base, hours };
}
