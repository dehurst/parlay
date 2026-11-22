import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedisStore, LEAGUE_PARTS } from '../src/store.js';

// A fake Upstash REST API (single commands and /pipeline) that counts the
// bytes it sends back, like the bandwidth Upstash bills.
function fakeUpstash(seed = {}) {
  const db = new Map(Object.entries(seed));
  const stats = { down: 0, up: 0, gets: [] };
  const run = ([cmd, key, value]) => {
    if (cmd === 'SET') { db.set(key, value); stats.up += value.length; return 'OK'; }
    if (cmd === 'GET') { const v = db.get(key) ?? null; stats.down += v?.length ?? 0; stats.gets.push(key); return v; }
    throw new Error(`unexpected ${cmd}`);
  };
  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url.endsWith('/pipeline')) return Response.json(body.map((c) => ({ result: run(c) })));
    return Response.json({ result: run(body) });
  };
  return { db, stats, fetch };
}

test('Redis store: reads only what changed, writes only what changed', async () => {
  const research = { season: 2026, weeks: { 1: { games: Array.from({ length: 500 }, (_, i) => ({ id: i, espnId: String(i), home: { id: '1' }, away: { id: '2' }, name: 'x'.repeat(50) })) } } };
  // Data saved before parts were split out: one big document, no versions.
  const legacy = { picks: { w: { Daniel: [{ key: 'g|ml|home', point: null, price: -110 }] } }, stakes: {}, research, lines: { w: { a: 1 } } };
  const up = fakeUpstash({ 'parlay:db': JSON.stringify(legacy) });
  const real = globalThis.fetch;
  globalThis.fetch = up.fetch;
  try {
    const a = new RedisStore({ url: 'https://x.upstash.io', token: 't', parts: LEAGUE_PARTS });
    await a.load();
    assert.equal(a.data.picks.w.Daniel.length, 1);
    assert.equal(a.data.research.weeks[1].games.length, 500); // still read from the old document

    // First save splits the parts out; the main document gets small.
    await a.save('w');
    assert.ok(up.db.get('parlay:db').length < 300);
    assert.equal(JSON.parse(up.db.get('parlay:db:research')).season, 2026);
    assert.ok(up.db.get('parlay:db:ver') && up.db.get('parlay:db:research:ver'));

    // Another server reads it back the same.
    const b = new RedisStore({ url: 'https://x.upstash.io', token: 't', parts: LEAGUE_PARTS });
    await b.load();
    assert.deepEqual(b.data.research, a.data.research);
    assert.deepEqual(b.data.picks, a.data.picks);
    assert.deepEqual(b.data.lines, { w: { a: 1 } });

    // Nothing changed: reloading downloads only the version tags.
    up.stats.down = 0;
    up.stats.gets = [];
    await b.load();
    assert.ok(up.stats.down < 100, `downloaded ${up.stats.down} bytes`);
    assert.ok(up.stats.gets.every((k) => k.endsWith(':ver')));

    // A pick changes on one server: the other re-downloads just the main document.
    a.data.picks.w.Asher = [{ key: 'g|ml|away', point: null, price: 120 }];
    up.stats.up = 0;
    await a.save('w');
    assert.ok(up.stats.up < 400, `uploaded ${up.stats.up} bytes`); // not the research
    up.stats.gets = [];
    await b.load();
    assert.equal(b.data.picks.w.Asher.length, 1);
    assert.deepEqual(up.stats.gets.filter((k) => !k.endsWith(':ver')), ['parlay:db']);
    assert.equal(b.data.research.weeks[1].games.length, 500); // kept from before

    // Saving with nothing changed sends nothing.
    up.stats.up = 0;
    await b.save('w');
    assert.equal(up.stats.up, 0);
  } finally {
    globalThis.fetch = real;
  }
});
