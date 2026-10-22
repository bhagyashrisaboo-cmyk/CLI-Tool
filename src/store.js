/**
 * Persistent storage: a single JSON document written atomically.
 *
 * Layout (schema version 1):
 * {
 *   "version": 1,
 *   "items":    { "<id>": Item },
 *   "mentions": { "<mentionKey>": Mention },   // one per action line per file
 *   "files":    { "<fileName>": FileRecord }   // last ingest result per file
 * }
 *
 * Writes go to a temp file that is fsync'd and renamed over the original, so
 * a crash mid-write never leaves a half-written store. A lock file prevents
 * two ActionTrack processes from writing at the same time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ActionTrackError } from './errors.js';

export const SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 30_000;

function emptyData() {
  return { version: SCHEMA_VERSION, items: {}, mentions: {}, files: {} };
}

export class Store {
  /** @param {string} filePath path to the JSON store */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = emptyData();
    this.lockPath = `${filePath}.lock`;
    this.locked = false;
  }

  /** Open (or create) the store. */
  static open(filePath) {
    const store = new Store(filePath);
    store.load();
    return store;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.data = emptyData();
      return;
    }
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      throw new ActionTrackError(`Cannot read store ${this.filePath}: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ActionTrackError(
        `Store file ${this.filePath} is corrupted (invalid JSON). ` +
        'Restore it from the .bak copy next to it, or delete it and re-run "actiontrack ingest".',
      );
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.items !== 'object') {
      throw new ActionTrackError(`Store file ${this.filePath} has an unexpected format.`);
    }
    if (parsed.version > SCHEMA_VERSION) {
      throw new ActionTrackError(
        `Store file was written by a newer ActionTrack (schema v${parsed.version}). Please upgrade.`,
      );
    }
    this.data = { ...emptyData(), ...parsed, version: SCHEMA_VERSION };
  }

  /** Run fn while holding the write lock, then save. */
  transaction(fn) {
    this.acquireLock();
    try {
      this.load(); // pick up changes made by another process before we locked
      const result = fn(this);
      this.save();
      return result;
    } finally {
      this.releaseLock();
    }
  }

  acquireLock() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        this.locked = true;
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw new ActionTrackError(`Cannot create lock file: ${err.message}`);
        let age = 0;
        try {
          age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
        } catch { /* lock vanished: retry */ }
        if (age > LOCK_STALE_MS) {
          try { fs.unlinkSync(this.lockPath); } catch { /* ignore */ }
          continue;
        }
        throw new ActionTrackError(
          `Another ActionTrack process is updating the store (${this.lockPath}). Try again in a moment.`,
        );
      }
    }
    throw new ActionTrackError(`Could not acquire lock ${this.lockPath}.`);
  }

  releaseLock() {
    if (!this.locked) return;
    try { fs.unlinkSync(this.lockPath); } catch { /* ignore */ }
    this.locked = false;
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(this.filePath)) {
      try { fs.copyFileSync(this.filePath, `${this.filePath}.bak`); } catch { /* best effort */ }
    }
    fs.renameSync(tmp, this.filePath);
  }

  // ------------------------------------------------------------ accessors

  allItems() {
    return Object.values(this.data.items);
  }

  getItem(id) {
    return this.data.items[id] || null;
  }

  putItem(item) {
    this.data.items[item.id] = item;
  }

  hasMention(key) {
    return Boolean(this.data.mentions[key]);
  }

  putMention(key, mention) {
    this.data.mentions[key] = mention;
  }

  putFile(name, record) {
    this.data.files[name] = record;
  }

  /** Everyone who has ever owned an item (used as part of the roster). */
  knownPeople() {
    const set = new Set();
    for (const item of this.allItems()) for (const o of item.owners) set.add(o);
    for (const f of Object.values(this.data.files)) for (const a of f.attendees || []) set.add(a);
    return [...set];
  }

  /**
   * Find items by full id or unique prefix (min 4 chars).
   * @returns {object[]} matches
   */
  findById(idOrPrefix) {
    const q = String(idOrPrefix || '').trim().toLowerCase();
    if (!q) return [];
    if (this.data.items[q]) return [this.data.items[q]];
    if (q.length < 4) return [];
    return this.allItems().filter((i) => i.id.startsWith(q));
  }
}
