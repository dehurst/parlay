import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHours, stadiumFor, gameWeather } from '../src/weather.js';

test('every home team has a stadium, with its roof', () => {
  assert.equal(stadiumFor('Green Bay Packers').roof, 'open');
  assert.equal(stadiumFor('Detroit Lions').roof, 'dome');
  assert.equal(stadiumFor('Dallas Cowboys').roof, 'retractable');
  assert.equal(stadiumFor('San Francisco 49ers').name, "Levi's Stadium");
  assert.equal(stadiumFor('Nowhere Team'), null);
});

test('Open-Meteo hours become one row per hour, in UTC', () => {
  const hours = parseHours({ hourly: {
    time: ['2026-11-01T17:00', '2026-11-01T18:00'], temperature_2m: [48.2, null], precipitation_probability: [30, 40],
    weather_code: [61, 3], wind_speed_10m: [16.4, 12], wind_gusts_10m: [25, 20], wind_direction_10m: [315, 300], is_day: [1, 1],
  } });
  assert.deepEqual(hours, [{ time: '2026-11-01T17:00:00Z', temp: 48.2, rain: 30, code: 61, wind: 16.4, gusts: 25, dir: 315, day: true }]);
  assert.deepEqual(parseHours({}), []);
});

test('a dome game has no forecast to fetch', async () => {
  const w = await gameWeather({ home: 'New Orleans Saints', commence: '2026-11-01T18:00:00Z' });
  assert.deepEqual(w, { stadium: 'Caesars Superdome', roof: 'dome', kickoff: '2026-11-01T18:00:00Z', hours: [] });
});
