import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/store.js';
import { filterItems, effectiveStatus, markDone, reopen, ownerMatches } from '../../src/query.js';
import { ActionTrackError } from '../../src/errors.js';
import { tmpDir } from '../helpers.js';

function item(over) {
  return {
    id: 'aaaaaaa', owners: ['Rahul Mehta'], ownerRaw: 'Rahul', ownerStatus: 'resolved', collaborators: [],
    task: 'fix bug', taskKey: 'fix bug', dueDate: null, dueRaw: null, status: 'open', sourceFile: 'a.md',
    sourceLine: 1, meetingTitle: 'M', meetingDate: '2026-09-01', lastSeenFile: 'a.md', lastSeenDate: '2026-09-01',
    flags: [], history: [], createdAt: '', updatedAt: '', completedAt: null, completedBy: null, ...over,
  };
}

const items = [
  item({ id: 'a1111111', dueDate: '2026-10-01' }),
  item({ id: 'b2222222', dueDate: '2026-11-01', owners: ['Priya Nair'], ownerRaw: 'Priya N.' }),
  item({ id: 'c3333333', status: 'done', dueDate: '2026-09-01' }),
  item({ id: 'd4444444', dueDate: null, owners: [], ownerRaw: 'Priya', ownerStatus: 'ambiguous', flags: ['ambiguous owner'] }),
];
const today = '2026-10-22';

test('effective status: overdue only for open items past due', () => {
  assert.equal(effectiveStatus(items[0], today), 'overdue');
  assert.equal(effectiveStatus(items[1], today), 'open');
  assert.equal(effectiveStatus(items[2], today), 'done');
  assert.equal(effectiveStatus(items[3], today), 'open');
  assert.equal(effectiveStatus(item({ dueDate: today }), today), 'open'); // due today is not overdue yet
});

test('default list shows open + overdue, overdue first', () => {
  assert.deepEqual(filterItems(items, { today }).map((i) => i.id), ['a1111111', 'b2222222', 'd4444444']);
});

test('status, owner, due-before and flagged filters', () => {
  assert.deepEqual(filterItems(items, { today, statuses: ['done'] }).map((i) => i.id), ['c3333333']);
  assert.deepEqual(filterItems(items, { today, statuses: ['overdue'] }).map((i) => i.id), ['a1111111']);
  assert.deepEqual(filterItems(items, { today, owner: 'priya' }).map((i) => i.id), ['b2222222', 'd4444444']);
  assert.deepEqual(filterItems(items, { today, owner: 'Priya Nair' }).map((i) => i.id), ['b2222222']);
  assert.deepEqual(filterItems(items, { today, dueBefore: '2026-10-31' }).map((i) => i.id), ['a1111111']);
  assert.deepEqual(filterItems(items, { today, flagged: true }).map((i) => i.id), ['d4444444']);
  assert.deepEqual(filterItems(items, { today, statuses: ['open', 'overdue', 'done'], owner: 'rahul' }).map((i) => i.id), ['a1111111', 'c3333333']);
});

test('ownerMatches is case-insensitive and handles @', () => {
  assert.ok(ownerMatches(items[0], 'RAHUL'));
  assert.ok(ownerMatches(items[0], 'mehta'));
  assert.ok(!ownerMatches(items[0], 'Verma'));
});

test('store persists across instances and done/reopen validate ids', () => {
  const file = path.join(tmpDir(), 'store.json');
  const s = Store.open(file);
  s.transaction(() => { for (const i of items) s.putItem(structuredClone(i)); });

  const r = markDone(Store.open(file), 'a111', { today });
  assert.equal(r.changed, true);
  assert.equal(Store.open(file).getItem('a1111111').status, 'done');
  assert.equal(Store.open(file).getItem('a1111111').completedBy, 'cli');

  assert.equal(markDone(Store.open(file), 'a1111111', { today }).changed, false);
  assert.throws(() => markDone(Store.open(file), 'zzzz', { today }), ActionTrackError);
  assert.throws(() => markDone(Store.open(file), 'a1', { today }), /at least 4/);

  assert.equal(reopen(Store.open(file), 'a1111111', { today }).changed, true);
  assert.equal(Store.open(file).getItem('a1111111').status, 'open');
  assert.ok(!fs.existsSync(`${file}.lock`));
});

test('ambiguous id prefix is rejected', () => {
  const file = path.join(tmpDir(), 'store.json');
  const s = Store.open(file);
  s.transaction(() => { s.putItem(item({ id: 'abcd111' })); s.putItem(item({ id: 'abcd222' })); });
  assert.throws(() => markDone(Store.open(file), 'abcd', { today }), /ambiguous/);
});

test('corrupted store gives a clear error; lock blocks concurrent writers', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'store.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => Store.open(file), /corrupted/);

  const file2 = path.join(dir, 'store2.json');
  fs.writeFileSync(`${file2}.lock`, '123');
  assert.throws(() => Store.open(file2).transaction(() => {}), /Another ActionTrack process/);
});

test('save is atomic and keeps a backup', () => {
  const file = path.join(tmpDir(), 'store.json');
  const s = Store.open(file);
  s.transaction(() => s.putItem(item({ id: 'x1' })));
  s.transaction(() => s.putItem(item({ id: 'x2' })));
  assert.ok(fs.existsSync(`${file}.bak`));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).items).sort(), ['x1', 'x2']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), []);
});
