import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Tiny JSON-file store. Plenty for a group of friends; swap for a real DB
// if you ever host this somewhere with an ephemeral filesystem.
export class Store {
  constructor(file) {
    this.file = file;
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
    this.data.players ??= [];
    this.data.picks ??= {}; // { weekKey: { player: [{ key, point, price }] } }
    this.data.schedule ??= {}; // { weekKey: { games, retryAt, demo? } }
    // Drop data from the old auto-odds version (picks were plain strings then).
    delete this.data.odds;
    for (const week of Object.values(this.data.picks)) {
      for (const [player, picks] of Object.entries(week)) {
        week[player] = picks.filter((p) => typeof p === 'object');
        if (!week[player].length) delete week[player];
      }
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
