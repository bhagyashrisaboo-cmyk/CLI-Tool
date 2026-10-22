/**
 * Configuration and file locations.
 *
 * Home directory (ACTIONTRACK_HOME, default ~/.actiontrack) holds:
 *   store.json          tracked items (override with --db / ACTIONTRACK_DB)
 *   people.json         address book: names, aliases, emails
 *   config.json         optional settings (sender name, Gmail paths)
 *   credentials.json    Google OAuth client (Desktop app) for Gmail drafts
 *   token.json          cached Gmail OAuth token (created on first auth)
 *   outbox/             .eml drafts saved when Gmail is unavailable / --outbox
 *   actiontrack.log     debug log
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionTrackError } from './errors.js';

export function homeDir(env = process.env) {
  return env.ACTIONTRACK_HOME || path.join(os.homedir(), '.actiontrack');
}

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new ActionTrackError(`Cannot read ${what} ${file}: ${err.message}`);
  }
}

export function loadConfig({ home = homeDir(), dbOverride = null, env = process.env } = {}) {
  const cfgFile = path.join(home, 'config.json');
  const cfg = readJson(cfgFile, 'config file') || {};
  const resolve = (p, fallback) => (p ? path.resolve(home, p) : path.join(home, fallback));
  return {
    home,
    storePath: dbOverride || env.ACTIONTRACK_DB || resolve(cfg.store, 'store.json'),
    peoplePath: env.ACTIONTRACK_PEOPLE || resolve(cfg.people, 'people.json'),
    credentialsPath: env.ACTIONTRACK_GMAIL_CREDENTIALS || resolve(cfg.gmail?.credentials, 'credentials.json'),
    tokenPath: resolve(cfg.gmail?.token, 'token.json'),
    outboxDir: resolve(cfg.outbox, 'outbox'),
    logPath: path.join(home, 'actiontrack.log'),
    senderName: cfg.senderName || env.ACTIONTRACK_SENDER_NAME || null,
  };
}

/**
 * Load the address book.
 * Format:
 * { "people": [ { "name": "Priya Nair", "email": "priya.nair@example.com", "aliases": ["Priya N."] } ] }
 * @returns {{ people: {name: string, email: string|null, aliases: string[]}[], aliases: Record<string,string> } | null}
 */
export function loadAddressBook(file) {
  if (!file) return null;
  const raw = readJson(file, 'address book');
  if (!raw) return null;
  if (!Array.isArray(raw.people)) {
    throw new ActionTrackError(`Address book ${file} must contain a "people" array.`);
  }
  const people = [];
  const aliases = {};
  const norm = (s) => s.toLowerCase().replace(/^@/, '').replace(/[.’']/g, '').replace(/\s+/g, ' ').trim();
  raw.people.forEach((p, i) => {
    if (!p || typeof p.name !== 'string' || !p.name.trim()) {
      throw new ActionTrackError(`Address book ${file}: entry ${i + 1} has no "name".`);
    }
    if (p.email != null && (typeof p.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email))) {
      throw new ActionTrackError(`Address book ${file}: "${p.name}" has an invalid email "${p.email}".`);
    }
    const entry = { name: p.name.trim(), email: p.email || null, aliases: Array.isArray(p.aliases) ? p.aliases : [] };
    people.push(entry);
    for (const a of entry.aliases) aliases[norm(a)] = entry.name;
  });
  return { people, aliases };
}
