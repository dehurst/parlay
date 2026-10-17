// One-time copy of your local data (data/db.json) into Upstash Redis, so the
// hosted site starts with the picks and history you already have.
//
//   1. Put UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env
//      (or KV_REST_API_URL / KV_REST_API_TOKEN from Vercel).
//   2. npm run upload-data            (add -- --force to overwrite existing data)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnvFile } from '../src/env.js';
import { RedisStore, normalize } from '../src/store.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnvFile(join(root, '.env'));
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
if (!url || !token) {
  console.error('Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to .env first.');
  process.exit(1);
}

const file = process.env.DATA_FILE || join(root, 'data', 'db.json');
let local;
try {
  local = normalize(JSON.parse(readFileSync(file, 'utf8')));
} catch {
  console.error(`Couldn't read ${file}. Nothing to upload.`);
  process.exit(1);
}

const store = new RedisStore({ url, token });
await store.load();
const hasData = Object.keys(store.data.picks).length || Object.keys(store.data.stakes).length;
if (hasData && !process.argv.includes('--force')) {
  console.error('The hosted database already has picks. Run with -- --force to replace them with your local data.');
  process.exit(1);
}
store.data = local;
await store.save();
const weeks = new Set([...Object.keys(local.picks), ...Object.keys(local.stakes)]);
console.log(`Uploaded ${weeks.size} week(s) of picks and parlays.`);
