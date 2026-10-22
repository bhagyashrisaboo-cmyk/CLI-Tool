/**
 * End-to-end CLI tests (in-process, isolated ACTIONTRACK_HOME per test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, FIXTURES, tmpDir } from '../helpers.js';

async function seeded(people = null) {
  const home = tmpDir('at-home-');
  if (people) fs.writeFileSync(path.join(home, 'people.json'), JSON.stringify({ people }));
  const r = await cli(['ingest', FIXTURES], { home });
  assert.equal(r.code, 0, r.err);
  return home;
}

test('help and usage errors', async () => {
  const home = tmpDir();
  const help = await cli(['--help'], { home });
  assert.equal(help.code, 0);
  assert.match(help.out, /ingest/);
  assert.match(help.out, /followup/);
  assert.match(help.out, /Examples:/);
  const bad = await cli(['frobnicate'], { home });
  assert.equal(bad.code, 2);
  const missing = await cli(['done'], { home });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /missing required argument/);
});

test('ingest prints a summary; second run is idempotent', async () => {
  const home = tmpDir();
  const first = await cli(['ingest', FIXTURES], { home });
  assert.equal(first.code, 0);
  assert.match(first.out, /SKIP {2}scratch\.md: binary content/);
  assert.match(first.out, /Summary: \d+ new/);
  const second = await cli(['ingest', FIXTURES], { home });
  assert.match(second.out, /Summary: 0 new, 0 carried over, 0 closed by later notes, 0 rescheduled, \d+ already tracked/);
  const bad = await cli(['ingest', path.join(home, 'nope')], { home });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Folder not found/);
});

test('list filters: owner, status, due-before, json', async () => {
  const home = await seeded();
  const json = async (...args) => JSON.parse((await cli(['list', ...args, '--today', '2026-10-22', '--json'], { home })).out);

  const rahul = await json('--owner', 'Rahul Mehta');
  assert.ok(rahul.length > 0);
  assert.ok(rahul.every((i) => i.owners.includes('Rahul Mehta')));

  const overdue = await json('--status', 'overdue');
  assert.ok(overdue.every((i) => i.effectiveStatus === 'overdue' && i.dueDate < '2026-10-22'));

  const done = await json('--status', 'done');
  assert.ok(done.length >= 10 && done.every((i) => i.status === 'done'));

  const both = await json('--status', 'open,done');
  assert.ok(both.some((i) => i.effectiveStatus === 'done') && both.some((i) => i.effectiveStatus === 'open'));

  const early = await json('--due-before', '2026-09-05');
  assert.ok(early.length > 0 && early.every((i) => i.dueDate < '2026-09-05'));

  const table = await cli(['list', '--owner', 'meera', '--today', '2026-10-22'], { home });
  assert.match(table.out, /^ID\s+!\s+STATUS\s+DUE\s+OWNER\s+TASK/);
  assert.match(table.out, /Meera Iyer/);

  const badStatus = await cli(['list', '--status', 'late'], { home });
  assert.equal(badStatus.code, 1);
  const badDate = await cli(['list', '--due-before', 'next week'], { home });
  assert.equal(badDate.code, 1);
  assert.match(badDate.err, /Invalid --due-before/);
});

test('overdue is computed from today', async () => {
  const home = await seeded();
  const ids = async (today) => JSON.parse((await cli(['list', '--status', 'overdue', '--owner', 'Sam Okafor', '--today', today, '--json'], { home })).out).map((i) => i.task);
  assert.ok(!(await ids('2026-10-01')).includes('decommission the old billing DB'));
  assert.ok((await ids('2026-10-31')).includes('decommission the old billing DB'));
});

test('done: marks, persists, and reports invalid / repeated ids', async () => {
  const home = await seeded();
  const list = JSON.parse((await cli(['list', '--owner', 'Sam Okafor', '--json'], { home })).out);
  const id = list[0].id;

  const r = await cli(['done', id.slice(0, 5)], { home });
  assert.equal(r.code, 0);
  assert.match(r.out, /Marked done/);

  const after = JSON.parse((await cli(['list', '--status', 'done', '--owner', 'Sam Okafor', '--json'], { home })).out);
  assert.ok(after.some((i) => i.id === id && i.completedBy === 'cli'));

  const again = await cli(['done', id], { home });
  assert.equal(again.code, 0);
  assert.match(again.out, /Already done/);

  const bad = await cli(['done', 'ffffffff'], { home });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /No action item with ID/);

  const re = await cli(['reopen', id], { home });
  assert.match(re.out, /Re-opened/);
});

test('followup: ambiguous / unknown owners are rejected', async () => {
  const home = await seeded();
  const amb = await cli(['followup', 'Priya'], { home });
  assert.equal(amb.code, 1);
  assert.match(amb.err, /Priya Nair, Priya Shah/);
  const unknown = await cli(['followup', 'Zelda'], { home });
  assert.equal(unknown.code, 1);
});

test('followup --dry-run prints the email and creates nothing', async () => {
  const home = await seeded([{ name: 'Rahul Mehta', email: 'rahul.mehta@example.com' }]);
  const r = await cli(['followup', 'Rahul Mehta', '--dry-run', '--today', '2026-10-22'], { home });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /To: Rahul Mehta <rahul.mehta@example.com>/);
  assert.match(r.out, /Subject: Follow-up: \d+ open action items? \(\d+ overdue\)/);
  assert.match(r.out, /Fix the pagination bug - due Wed 23 Sep 2026/);
  assert.match(r.out, /dry run/);
  assert.match(r.err, /ambiguous "Rahul"/);
  assert.ok(!fs.existsSync(path.join(home, 'outbox')));
});

test('followup creates a Gmail draft via the API client and never sends', async () => {
  const home = await seeded([{ name: 'Priya Nair', email: 'priya.nair@example.com', aliases: ['Priya N.'] }]);
  const calls = [];
  const gmailClient = {
    users: {
      drafts: {
        create: async (req) => { calls.push(req); return { data: { id: 'r-42' } }; },
        send: async () => { throw new Error('must not send'); },
      },
      messages: { send: async () => { throw new Error('must not send'); } },
    },
  };
  const r = await cli(['followup', 'Priya Nair', '--today', '2026-10-22'], { home, gmailClient });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Gmail draft created for Priya Nair \(draft id r-42\)/);
  assert.match(r.out, /Nothing was sent/);
  assert.equal(calls.length, 1);
  const mime = Buffer.from(calls[0].requestBody.message.raw, 'base64url').toString();
  assert.match(mime, /^To: Priya Nair <priya.nair@example.com>/);
  const body = Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString();
  assert.match(body, /Collect beta feedback from Acme/);
  assert.doesNotMatch(body, /Send the revised quote/); // done items are excluded
});

test('followup falls back to an .eml in the outbox when Gmail is not set up', async () => {
  const home = await seeded();
  const r = await cli(['followup', 'Sam Okafor', '--today', '2026-10-22'], { home });
  assert.equal(r.code, 3);
  assert.match(r.err, /Gmail is not set up/);
  assert.match(r.err, /actiontrack auth/);
  assert.match(r.out, /saved for review instead/);
  const files = fs.readdirSync(path.join(home, 'outbox'));
  assert.equal(files.length, 1);
  assert.match(files[0], /sam-okafor\.eml$/);
});

test('followup --outbox writes an .eml without touching Gmail', async () => {
  const home = await seeded();
  const dir = path.join(home, 'drafts');
  const r = await cli(['followup', 'Lena Fischer', '--outbox', dir, '--today', '2026-10-22'], { home });
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('followup for someone with nothing open creates no draft', async () => {
  const home = tmpDir();
  const notes = tmpDir();
  fs.writeFileSync(path.join(notes, 'a.md'), 'Date: 2026-01-05\nAttendees: Sam Okafor\n- [x] Sam to send the deck\n');
  await cli(['ingest', notes], { home });
  const r = await cli(['followup', 'Sam Okafor'], { home });
  assert.equal(r.code, 0);
  assert.match(r.out, /no open action items/);
});

test('invalid address book gives a clear error', async () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'people.json'), JSON.stringify({ people: [{ name: 'X', email: 'not-an-email' }] }));
  const r = await cli(['list'], { home });
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid email/);
});
