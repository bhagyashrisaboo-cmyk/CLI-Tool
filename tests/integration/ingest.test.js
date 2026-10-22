/**
 * Integration tests: ingest the real sample notes folder and check the traps
 * it contains (quoted / commented / fenced fake tasks, two Priyas, two Rahuls,
 * vague dates, malformed files, carry-over items).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/store.js';
import { ingestFolder } from '../../src/ingest.js';
import { FIXTURES, tmpDir, writeNotes } from '../helpers.js';

function ingestFixtures() {
  const store = Store.open(path.join(tmpDir(), 'store.json'));
  const report = ingestFolder(store, FIXTURES, { now: new Date('2026-10-22T09:00:00Z') });
  return { store, report };
}

const find = (store, owner, re) => store.allItems().filter((i) => (owner === null || i.owners.includes(owner) || i.ownerRaw === owner) && re.test(i.task));

test('every file is accounted for; bad files are skipped, not fatal', () => {
  const { report } = ingestFixtures();
  const byFile = Object.fromEntries(report.files.map((f) => [f.file, f]));
  assert.equal(report.files.length, 35);
  assert.equal(byFile['2026-09-09-notes-final-v2.md'].status, 'skipped');
  assert.equal(byFile['scratch.md'].status, 'skipped');
  assert.match(byFile['scratch.md'].reason, /binary/);
  assert.deepEqual(report.ignored, ['2026-09-19-offsite-draft.txt']);
  assert.equal(byFile['untitled.md'].status, 'ok');
  assert.equal(byFile['2026-10-03-sales-pipeline.md'].status, 'ok');
});

test('re-ingesting the same notes adds nothing', () => {
  const { store } = ingestFixtures();
  const before = JSON.stringify(store.data.items);
  const again = ingestFolder(store, FIXTURES, { now: new Date('2026-10-23T09:00:00Z') });
  assert.equal(again.totals.new, 0);
  assert.equal(again.totals.linked, 0);
  assert.ok(again.totals.duplicates > 100);
  assert.equal(JSON.stringify(Store.open(store.filePath).data.items), before);
});

test('relative due dates resolve against the meeting date', () => {
  const { store } = ingestFixtures();
  assert.equal(find(store, 'Rahul Mehta', /repo access/)[0].dueDate, '2026-09-03'); // tomorrow
  assert.equal(find(store, 'Priya Shah', /test plan for invoice rounding/)[0].dueDate, '2026-09-11'); // end of next week
  assert.equal(find(store, 'Anita Desai', /colour contrast/)[0].dueDate, '2026-09-21'); // @anita ... by Mon
  assert.equal(find(store, 'Sam Okafor', /postmortem/)[0].dueDate, '2026-09-22'); // EOD tomorrow
  assert.equal(find(store, 'Karan Joshi', /circulate the offsite summary/)[0].dueDate, '2026-10-01'); // ACTION: ... tomorrow
  assert.equal(find(store, 'Lena Fischer', /customer survey/)[0].dueDate, '2026-10-15');
  assert.equal(find(store, 'Priya Shah', /test data/)[0].dueDate, null); // no date given
});

test('quoted, commented and fenced "tasks" are not tracked', () => {
  const { store } = ingestFixtures();
  const refund = find(store, 'Karan Joshi', /refund affected customers/);
  assert.equal(refund.length, 1);
  assert.equal(refund[0].dueDate, null); // the quoted "by Friday" wish is ignored
  assert.equal(find(store, null, /hardware tokens/).length, 0);
  assert.equal(find(store, null, /remediate finding/).length, 0);
  assert.equal(find(store, null, /Book the venue/).length, 0);
});

test('tables, nested items and ACTION lines are tracked', () => {
  const { store } = ingestFixtures();
  assert.equal(find(store, 'Anita Desai', /brand kit/)[0].dueDate, '2026-10-09');
  assert.equal(find(store, 'Karan Joshi', /validate targets/)[0].dueDate, '2026-10-05');
  assert.equal(find(store, 'Sam Okafor', /on-call rotation/).length, 1);
});

test('owners: initials, two Priyas, two Rahuls, groups and missing lists', () => {
  const { store } = ingestFixtures();
  assert.equal(find(store, 'Priya Nair', /notify customers/).length, 1); // "Priya N."
  assert.equal(find(store, 'Priya Shah', /invoice rounding tests/).length, 1); // "Priya S."
  const hiring = find(store, 'Priya', /hiring plan/)[0];
  assert.equal(hiring.ownerStatus, 'ambiguous');
  assert.deepEqual(hiring.owners, []);
  const arch = find(store, 'Rahul', /architecture overview/)[0];
  assert.equal(arch.ownerStatus, 'ambiguous');
  const everyone = find(store, 'Everyone', /review the prototype/)[0];
  assert.equal(everyone.ownerStatus, 'group');
  assert.equal(find(store, 'Someone', /CRM notes/)[0].ownerStatus, 'unassigned');
  // Standup with no attendee list: Sam is unique in the roster, Rahul is not.
  assert.deepEqual(find(store, 'Sam Okafor', /rotate the staging credentials/)[0].owners, ['Sam Okafor']);
  assert.equal(find(store, 'Rahul', /rebase the feature branch/)[0].ownerStatus, 'ambiguous');
  // Shared ownership and collaborators
  assert.deepEqual(find(store, 'Anita Desai', /component API/)[0].owners, ['Anita Desai', 'Rahul Mehta']);
  const fb = find(store, 'Lena Fischer', /user feedback/)[0];
  assert.deepEqual(fb.collaborators, ['Priya Nair']);
});

test('unknown meeting dates never produce invented due dates', () => {
  const { store } = ingestFixtures();
  const chase = find(store, 'Meera Iyer', /chase Orbit Labs/)[0];
  assert.equal(chase.dueDate, null);
  assert.equal(chase.dueRaw, 'Friday');
  assert.ok(chase.flags.some((f) => /meeting date unknown/.test(f)));
  const slides = find(store, 'Priya', /send the slides/)[0];
  assert.equal(slides.dueDate, null);
  assert.equal(slides.ownerStatus, 'ambiguous');
  const sso = find(store, 'Rahul Verma', /start SSO spike/)[0];
  assert.equal(sso.dueDate, null);
  assert.ok(sso.flags.some((f) => /ambiguous due date/.test(f)));
  assert.equal(find(store, 'Sam Okafor', /on-call rotation/)[0].dueDate, null); // "mid-October"
});

test('carry-over items are linked, rescheduled and closed by later notes', () => {
  const { store } = ingestFixtures();
  const quote = find(store, 'Priya Nair', /revised quote/);
  assert.equal(quote.length, 1);
  assert.equal(quote[0].status, 'done');
  assert.equal(quote[0].completedBy, 'notes:2026-09-15-quote-portal-weekly.md');

  const pagination = find(store, 'Rahul Mehta', /pagination bug/);
  assert.equal(pagination.length, 1);
  assert.equal(pagination[0].dueDate, '2026-09-23'); // first had no date, then "by Wednesday" on 22 Sep
  assert.equal(pagination[0].status, 'open');

  const deploy = find(store, 'Rahul Mehta', /deploy the beta/);
  assert.equal(deploy.length, 1);
  assert.equal(deploy[0].status, 'done');
  assert.ok(deploy[0].history.some((h) => /rescheduled from 2026-10-02 to 2026-10-07/.test(h.event)));

  // Same text, different Rahul => different items
  const schema = find(store, 'Rahul Verma', /schema mapping/);
  assert.equal(schema.length, 1);
  assert.equal(schema[0].dueDate, '2026-09-07'); // a later mention without a date keeps the commitment

  // Distinct tasks with similar text are not merged
  assert.equal(find(store, 'Anita Desai', /wireframes/).length, 2);
});

test('the same task in two different files is one item; same file twice is not duplicated', () => {
  const dir = writeNotes({
    'a.md': 'Date: 2026-01-05\nAttendees: Sam Okafor\n- [ ] Sam to send the deck by Friday\n',
    'b.md': 'Date: 2026-01-12\nAttendees: Sam Okafor\n- [ ] Sam to send the deck by Wednesday\n',
    'c.md': 'Date: 2026-01-19\nAttendees: Sam Okafor\n- [x] Sam to send the deck\n',
  });
  const store = Store.open(path.join(tmpDir(), 'store.json'));
  const r = ingestFolder(store, dir);
  assert.equal(r.totals.new, 1);
  assert.equal(r.totals.linked, 2);
  const [item] = store.allItems();
  assert.equal(item.status, 'done');
  assert.equal(item.dueDate, '2026-01-14');
  assert.equal(item.completedAt, '2026-01-19');
});

test('CLI "done" is sticky: re-ingest never reopens it', () => {
  const dir = writeNotes({ 'a.md': 'Date: 2026-01-05\nAttendees: Sam Okafor\n- [ ] Sam to send the deck by Friday\n' });
  const store = Store.open(path.join(tmpDir(), 'store.json'));
  ingestFolder(store, dir);
  const id = store.allItems()[0].id;
  store.transaction(() => { store.getItem(id).status = 'done'; store.getItem(id).completedBy = 'cli'; });
  fs.writeFileSync(path.join(dir, 'b.md'), 'Date: 2026-01-12\nAttendees: Sam Okafor\n- [ ] Sam to send the deck by Wednesday\n');
  ingestFolder(store, dir);
  assert.equal(store.allItems().length, 1);
  assert.equal(store.getItem(id).status, 'done');
});

test('a missing folder is a clear error', () => {
  const store = Store.open(path.join(tmpDir(), 'store.json'));
  assert.throws(() => ingestFolder(store, path.join(tmpDir(), 'nope')), /Folder not found/);
});
