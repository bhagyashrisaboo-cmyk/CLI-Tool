import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { composeFollowup, toMime } from '../../src/followup.js';
import { GmailApiBackend, OutboxBackend } from '../../src/gmail.js';
import { GmailUnavailableError } from '../../src/errors.js';
import { tmpDir } from '../helpers.js';

const today = '2026-10-22';
const base = { owners: ['Rahul Mehta'], meetingTitle: 'Quote portal weekly', meetingDate: '2026-09-15', dueRaw: null };
const overdue = [{ ...base, id: 'e720b49', task: 'fix the pagination bug', dueDate: '2026-09-23' }];
const open = [
  { ...base, id: 'aaa1111', task: 'write the runbook', dueDate: null },
  { ...base, id: 'bbb2222', task: 'agree on the component API', dueDate: '2026-10-30', owners: ['Anita Desai', 'Rahul Mehta'] },
];
const book = { people: [{ name: 'Rahul Mehta', email: 'rahul@example.com', aliases: [] }], aliases: {} };

test('compose lists overdue then open items with due dates and refs', () => {
  const e = composeFollowup({ person: 'Rahul Mehta', overdue, open, today, addressBook: book, senderName: 'Bhagyashri' });
  assert.equal(e.to, 'rahul@example.com');
  assert.equal(e.subject, 'Follow-up: 3 open action items (1 overdue)');
  assert.match(e.body, /^Hi Rahul,/);
  assert.match(e.body, /Overdue:\n- Fix the pagination bug - due Wed 23 Sep 2026 \(29 days overdue\)/);
  assert.match(e.body, /Still open:\n- Write the runbook - no due date set/);
  assert.match(e.body, /shared with Anita Desai/);
  assert.match(e.body, /\(ref e720b49\)/);
  assert.match(e.body, /Thanks,\nBhagyashri\n$/);
  assert.ok(e.body.indexOf('Overdue:') < e.body.indexOf('Still open:'));
  assert.deepEqual(e.warnings, []);
});

test('missing email -> no recipient and a warning (nothing invented)', () => {
  const e = composeFollowup({ person: 'Rahul Mehta', overdue: [], open, today, addressBook: null });
  assert.equal(e.to, null);
  assert.equal(e.subject, 'Follow-up: 2 open action items');
  assert.ok(e.warnings.some((w) => /No email address/.test(w)));
  assert.doesNotMatch(toMime(e), /^To:/m);
});

test('MIME output is a valid draft message', () => {
  const e = composeFollowup({ person: 'Rahul Mehta', overdue, open, today, addressBook: book });
  const mime = toMime(e, { date: new Date('2026-10-22T09:00:00Z') });
  assert.match(mime, /^To: Rahul Mehta <rahul@example.com>\r\n/);
  assert.match(mime, /Subject: Follow-up: 3 open action items \(1 overdue\)\r\n/);
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
  const body = Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(body, /Fix the pagination bug/);
});

function fakeGmail({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    users: {
      drafts: {
        create: async (req) => {
          calls.push(req);
          if (fail) throw fail;
          return { data: { id: 'r-123' } };
        },
        send: async () => { throw new Error('drafts.send must never be called'); },
      },
      messages: { send: async () => { throw new Error('messages.send must never be called'); } },
    },
  };
}

test('Gmail backend creates a draft (never sends) with base64url raw', async () => {
  const gmail = fakeGmail();
  const backend = new GmailApiBackend({ credentialsPath: 'x', tokenPath: 'y', gmailClient: gmail });
  const r = await backend.createDraft('Subject: hi\r\n\r\nbody?>>');
  assert.equal(r.id, 'r-123');
  assert.equal(gmail.calls.length, 1);
  assert.equal(gmail.calls[0].userId, 'me');
  const raw = gmail.calls[0].requestBody.message.raw;
  assert.doesNotMatch(raw, /[+/=]/);
  assert.equal(Buffer.from(raw, 'base64url').toString(), 'Subject: hi\r\n\r\nbody?>>');
});

test('Gmail backend source never references a send endpoint', () => {
  const src = fs.readFileSync(new URL('../../src/gmail.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/^\s*(\*|\/\/).*$/gm, ''), /\.send\s*\(/);
});

test('Gmail failures become GmailUnavailableError with a hint', async () => {
  const cases = [
    [{ code: 401, message: 'invalid_grant' }, /rejected the saved sign-in/],
    [{ code: 403, message: 'insufficient scope' }, /refused/],
    [{ message: 'getaddrinfo ENOTFOUND gmail.googleapis.com' }, /Could not reach Gmail/],
  ];
  for (const [fail, re] of cases) {
    const backend = new GmailApiBackend({ credentialsPath: 'x', tokenPath: 'y', gmailClient: fakeGmail({ fail: Object.assign(new Error(fail.message), fail) }) });
    await assert.rejects(backend.createDraft('x'), (err) => err instanceof GmailUnavailableError && re.test(err.message));
  }
});

test('missing credentials / token fail gracefully without network', async () => {
  const dir = tmpDir();
  const noCreds = new GmailApiBackend({ credentialsPath: path.join(dir, 'credentials.json'), tokenPath: path.join(dir, 'token.json') });
  await assert.rejects(noCreds.createDraft('x'), (e) => e instanceof GmailUnavailableError && /not set up/.test(e.message) && /Desktop app/.test(e.hint));

  fs.writeFileSync(path.join(dir, 'credentials.json'), '{"nope": 1}');
  await assert.rejects(noCreds.createDraft('x'), (e) => e instanceof GmailUnavailableError && /Invalid Gmail credentials/.test(e.message));
});

test('outbox backend writes unique .eml files', async () => {
  const dir = tmpDir();
  const ob = new OutboxBackend(dir);
  const now = new Date('2026-10-22T09:00:00Z');
  const a = await ob.createDraft('A', { slug: 'Rahul Mehta', now });
  const b = await ob.createDraft('B', { slug: 'Rahul Mehta', now });
  assert.notEqual(a.location, b.location);
  assert.match(path.basename(a.location), /^20261022-090000-rahul-mehta\.eml$/);
  assert.equal(fs.readFileSync(b.location, 'utf8'), 'B');
});
