import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// All app data lives in one small JSON document. Locally it's a file; when
// hosted (Vercel has no lasting disk) it's a single key in Upstash Redis.

// Fill in missing sections and drop data from older versions.
export function normalize(data) {
  data.picks ??= {}; // submitted: { weekKey: { player: [{ key, point, price, locked? }] } }
  data.drafts ??= {}; // unsubmitted: { weekKey: { player: [key] } }
  data.draftLocks ??= {}; // which unsubmitted selections are locks: { weekKey: { player: [key] } }
  data.schedule ??= {}; // { weekKey: { games, source, retryAt, demo? } }
  data.lines ??= {}; // { weekKey: { byMatchup, fetchedAt, remaining } }
  data.props ??= {};
  data.research ??= null; // ESPN season scoreboard by week: { season, weeks: { n: { games, fetchedAt, final } }, boxscores: { espnId: { home, away } }, injuries: { fetchedAt, teams: { abbr: [{ id, name, position, depthRank, depthLabel, status, sinceWeek }] }, history: { playerId: { startWeek } } } } // player props: { weekKey: { byGame: { gameId: { td, ptd } }, fetchedAt } }
  // Parlays people put money on: { weekKey: { parlayId: { name, legs, decimal, american, stakes: { player: $ } } } }
  data.stakes ??= {};
  data.results ??= {}; // final scores: { weekKey: { gameId: { homeScore, awayScore } } }
  data.scoresCheckedAt ??= {}; // { weekKey: ms }
  // Likes and dislikes on parlays, and dislikes on legs:
  // { weekKey: { parlays: { parlayId: [player] }, parlayDowns: { parlayId: [player] }, legs: { betKey: [player] } } }
  data.reactions ??= {};
  data.creditsUsed ??= {}; // paid Odds API credits: { 'YYYY-MM-DD' (Eastern): n }
  data.teams ??= {}; // college only, from ESPN: { fullName: { short, abbr, logo, conf } }

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
  if (data.research) {
    // Weeks cached before box scores/team ids were tracked are missing them: fetch those again.
    for (const [week, w] of Object.entries(data.research.weeks ?? {})) {
      if (w.games.some((g) => g.espnId === undefined || g.home?.id === undefined || g.away?.id === undefined)) delete data.research.weeks[week];
    }
  }
  return data;
}

// Past weeks' lines are kept only when someone bet that week: Analysis uses
// them to price what would have hit. Others are dropped to keep the document small.
function prune(data, currentWeek) {
  if (!currentWeek) return;
  for (const kind of ['lines', 'props']) {
    for (const week of Object.keys(data[kind] ?? {})) {
      if (week < currentWeek && !data.picks[week] && !data.stakes[week]) delete data[kind][week];
    }
  }
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

// The big, slow-changing parts of a league's document, each kept under its
// own Redis key so saving a pick doesn't re-upload them and reading the
// document doesn't re-download them unless they changed.
export const LEAGUE_PARTS = ['research', 'schedule', 'lines', 'props', 'results'];

// Upstash Redis over its REST API (no extra packages).
//
// Upstash's free plan caps bandwidth (10 GB a month), and every request
// reads the document, so reads are cheap here: each piece (the main document
// and each part) has a small version tag next to it. A load asks for the tags
// first and only downloads pieces that changed since this server last saw
// them; a save only uploads pieces that changed.
export class RedisStore {
  constructor({ url, token, key = 'parlay:db', parts = [] }) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.key = key;
    this.parts = parts;
    this.data = null;
    this.cache = {}; // piece ('' = main) -> { ver, raw } as last read or written here
  }

  async request(path, body) {
    const res = await fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) throw new Error(`Upstash Redis: ${out.error ?? res.status}`);
    return out;
  }

  async command(args) {
    return (await this.request('', args)).result;
  }

  // Several commands in one round trip.
  async pipeline(cmds) {
    const out = await this.request('/pipeline', cmds);
    const bad = out.find?.((r) => r.error);
    if (bad) throw new Error(`Upstash Redis: ${bad.error}`);
    return out.map((r) => r.result);
  }

  keyOf(piece) {
    return piece ? `${this.key}:${piece}` : this.key;
  }

  // Read fresh on every request (hosted requests can land on different
  // machines), but only download the pieces whose version changed.
  async load() {
    const pieces = ['', ...this.parts];
    const vers = await this.pipeline(pieces.map((p) => ['GET', `${this.keyOf(p)}:ver`]));
    // No version yet (data saved before versions existed): always read it.
    const stale = pieces.filter((p, i) => vers[i] == null || this.cache[p]?.ver !== vers[i]);
    if (stale.length) {
      const raws = await this.pipeline(stale.map((p) => ['GET', this.keyOf(p)]));
      stale.forEach((p, i) => (this.cache[p] = { ver: vers[pieces.indexOf(p)], raw: raws[i] }));
    }
    const main = this.cache[''].raw;
    const data = main ? JSON.parse(main) : {};
    // A part saved on its own wins; until then it's still inside the main
    // document (from before parts were split out).
    for (const p of this.parts) if (this.cache[p]?.raw != null) data[p] = JSON.parse(this.cache[p].raw);
    this.data = normalize(data);
  }

  async save(currentWeek) {
    prune(this.data, currentWeek);
    const main = { ...this.data };
    for (const p of this.parts) delete main[p];
    const pieces = [['', JSON.stringify(main)], ...this.parts.map((p) => [p, JSON.stringify(this.data[p] ?? null)])];
    const cmds = [];
    const wrote = {};
    for (const [p, raw] of pieces) {
      if (this.cache[p]?.ver && this.cache[p].raw === raw) continue; // unchanged
      const ver = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      cmds.push(['SET', this.keyOf(p), raw], ['SET', `${this.keyOf(p)}:ver`, ver]);
      wrote[p] = { ver, raw };
    }
    if (!cmds.length) return;
    await this.pipeline(cmds);
    Object.assign(this.cache, wrote);
  }
}

// Upstash's Vercel integration sets KV_REST_API_*; a direct Upstash database
// gives UPSTASH_REDIS_REST_*. Either works. Each league (NFL, college) has
// its own document: its own file, or its own Redis key.
export function createStore(env, file, key, { parts = [] } = {}) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new RedisStore({ url, token, key, parts });
  if (env.VERCEL) {
    throw new Error('No database connected. In Vercel, add Upstash Redis to this project (Storage tab), then redeploy.');
  }
  return new FileStore(file);
}
