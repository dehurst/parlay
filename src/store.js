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
    this.data.picks ??= {}; // { weekKey: { player: [selectionKey] } }
    this.data.odds ??= {}; // { weekKey: { fetchedAt, events, remaining } }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
