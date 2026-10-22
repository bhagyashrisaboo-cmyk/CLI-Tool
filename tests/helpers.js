import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'notes');

export function tmpDir(prefix = 'at-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a set of notes { name: content } into a fresh folder. */
export function writeNotes(files) {
  const dir = tmpDir('at-notes-');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

class Sink {
  constructor() { this.data = ''; this.columns = 200; }
  write(s) { this.data += s; return true; }
}

/** Run the CLI in-process against an isolated home directory. */
export async function cli(args, { home, now = new Date('2026-10-22T09:00:00Z'), gmailClient = null, env = {} } = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(args, { stdout, stderr, env: { ACTIONTRACK_HOME: home, ...env }, now, gmailClient, columns: 200 });
  return { code, out: stdout.data, err: stderr.data };
}
