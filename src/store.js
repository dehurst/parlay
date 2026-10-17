import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// All app data lives in one small JSON document. Locally it's a file; when
// hosted (Vercel has no lasting disk) it's a single key in Upstash Redis.

// Fill in missing sections and drop data from older versions.
export function normalize(data) {
  data.picks ??= {}; // submitted: { weekKey: { player: [{ key, point, price }] } }
  data.drafts ??= {}; // unsubmitted: { weekKey: { player: [key] } }
  data.schedule ??= {}; // { weekKey: { games, source, retryAt, demo? } }
  data.lines ??= {}; // { weekKey: { byMatchup, fetchedAt, remaining } }
  // Parlays people put money on: { weekKey: { parlayId: { name, legs, decimal, american, stakes: { player: $ } } } }
  data.stakes ??= {};
  data.results ??= {}; // final scores: { weekKey: { gameId: { homeScore, awayScore } } }
  data.scoresCheckedAt ??= {}; // { weekKey: ms }

  delete data.players; // players are configured now (PLAYERS)
  delete data.votes; // replaced by stakes
  delete data.odds; // auto-odds picks from the first version
  for (const week of Object.values(data.picks)) {
    for (const [player, picks] of Object.entries(week)) {
      week[player] = picks.filter((p) => typeof p === 'object');
      if (!week[player].length) delete week[player];
    }
  }
  for (const [week, sched] of Object.entries(data.schedule)) {
    // Demo slates are placeholders, and schedules cached before multi-source
    // support used other game IDs: fetch those again.
    if (!sched.source || sched.demo) delete data.schedule[week];
  }
  return data;
}

// Only the current week's lines are needed (for "line moved" notes and new
// picks), so older ones are dropped to keep the document small.
function prune(data, currentWeek) {
  if (!currentWeek) return;
  for (const week of Object.keys(data.lines)) if (week < currentWeek) delete data.lines[week];
}

export class FileStore {
  constructor(file) {
    this.file = file;
    this.data = null;
  }

  // Read once; this process is the only writer.
  async load() {
    if (this.data) return;
    let data = {};
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {}
    this.data = normalize(data);
  }

  async save(currentWeek) {
    prune(this.data, currentWeek);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}

// Upstash Redis over its REST API (no extra packages).
export class RedisStore {
  constructor({ url, token, key = 'parlay:db' }) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.key = key;
    this.data = null;
  }

  async command(args) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Upstash Redis: ${body.error ?? res.status}`);
    return body.result;
  }

  // Read fresh on every request: hosted requests can land on different machines.
  async load() {
    const raw = await this.command(['GET', this.key]);
    this.data = normalize(raw ? JSON.parse(raw) : {});
  }

  async save(currentWeek) {
    prune(this.data, currentWeek);
    await this.command(['SET', this.key, JSON.stringify(this.data)]);
  }
}

// Upstash's Vercel integration sets KV_REST_API_*; a direct Upstash database
// gives UPSTASH_REDIS_REST_*. Either works.
export function createStore(env, file) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new RedisStore({ url, token });
  if (env.VERCEL) {
    throw new Error('No database connected. In Vercel, add Upstash Redis to this project (Storage tab), then redeploy.');
  }
  return new FileStore(file);
}
