import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDue, extractDueClause, parseMeetingDate, parseCliDate, weekdayOf, formatDate } from '../../src/dates.js';

const due = (raw, meeting) => resolveDue(raw, meeting).date;

test('parseMeetingDate handles the formats seen in notes', () => {
  assert.equal(parseMeetingDate('2026-09-02'), '2026-09-02');
  assert.equal(parseMeetingDate('9 September 2026'), '2026-09-09');
  assert.equal(parseMeetingDate('Monday, 14 September 2026'), '2026-09-14');
  assert.equal(parseMeetingDate('September 9, 2026'), '2026-09-09');
  assert.equal(parseMeetingDate('**2026-10-02**'), '2026-10-02');
});

test('parseMeetingDate refuses vague or ambiguous values', () => {
  assert.equal(parseMeetingDate('sometime last week'), null);
  assert.equal(parseMeetingDate('14/09/2026'), null); // DD/MM vs MM/DD
  assert.equal(parseMeetingDate('2026-02-30'), null);
  assert.equal(parseMeetingDate(''), null);
});

test('bare weekday resolves to the next such day after the meeting', () => {
  assert.equal(weekdayOf('2026-09-01'), 1); // Tuesday
  assert.equal(due('Friday', '2026-09-01'), '2026-09-04');
  assert.equal(due('Thursday', '2026-09-01'), '2026-09-03');
  assert.equal(due('Mon', '2026-09-18'), '2026-09-21');
  assert.equal(due('Wed', '2026-09-08'), '2026-09-09');
});

test('"by Friday" said on a Friday means the following Friday', () => {
  assert.equal(due('Friday', '2026-10-02'), '2026-10-09');
});

test('relative words', () => {
  assert.equal(due('tomorrow', '2026-09-02'), '2026-09-03');
  assert.equal(due('EOD', '2026-10-08'), '2026-10-08');
  assert.equal(due('EOD tomorrow', '2026-09-21'), '2026-09-22');
  assert.equal(due('end of next week', '2026-09-03'), '2026-09-11');
  assert.equal(due('end of the week', '2026-09-01'), '2026-09-04');
  assert.equal(due('end of month', '2026-09-14'), '2026-09-30');
  assert.equal(due('end of next month', '2026-12-10'), '2027-01-31');
});

test('absolute dates, with and without year', () => {
  assert.equal(due('2026-09-08', '2026-09-01'), '2026-09-08');
  assert.equal(due('10 Sep', '2026-09-03'), '2026-09-10');
  assert.equal(due('Oct 3rd', '2026-09-30'), '2026-10-03');
  assert.equal(due('15 October', '2026-09-30'), '2026-10-15');
  assert.equal(due('Wed 16 Sep', '2026-09-14'), '2026-09-16');
  assert.equal(due('5 Jan', '2026-12-20'), '2027-01-05'); // rolls into next year
  assert.equal(due('2026-10-09', null), '2026-10-09'); // ISO needs no meeting date
});

test('weekday that contradicts the date keeps the date and flags it', () => {
  const r = resolveDue('Friday 16 Sep', '2026-09-14');
  assert.equal(r.date, '2026-09-16');
  assert.match(r.note, /does not match/);
});

test('ambiguous or vague dates are never guessed', () => {
  for (const raw of ['next Tuesday', 'mid-October', 'next week', 'November']) {
    const r = resolveDue(raw, '2026-10-05');
    assert.equal(r.date, null, raw);
    assert.ok(r.note, raw);
    assert.equal(r.raw, raw);
  }
});

test('relative dates without a meeting date stay unresolved', () => {
  const r = resolveDue('Friday', null);
  assert.equal(r.date, null);
  assert.match(r.note, /meeting date unknown/);
  assert.equal(resolveDue('10 Sep', null).date, null);
});

test('invalid calendar dates are rejected', () => {
  assert.equal(due('2026-02-30', '2026-02-01'), null);
  assert.equal(due('31 Sep', '2026-09-01'), null);
});

test('extractDueClause splits trailing due phrases', () => {
  assert.deepEqual(extractDueClause('send the revised quote to Acme by Friday'), { task: 'send the revised quote to Acme', dueRaw: 'Friday' });
  assert.deepEqual(extractDueClause('send revised quote to Acme — by Friday'), { task: 'send revised quote to Acme', dueRaw: 'Friday' });
  assert.deepEqual(extractDueClause('cut cloud costs by 10% — proposal by 2026-10-09'), { task: 'cut cloud costs by 10% — proposal', dueRaw: '2026-10-09' });
  assert.deepEqual(extractDueClause('run the customer survey, results due 15 October'), { task: 'run the customer survey', dueRaw: '15 October' });
  assert.deepEqual(extractDueClause('demo the portal to Acme on 2026-10-14'), { task: 'demo the portal to Acme', dueRaw: '2026-10-14' });
  assert.deepEqual(extractDueClause('circulate the offsite summary tomorrow'), { task: 'circulate the offsite summary', dueRaw: 'tomorrow' });
  assert.deepEqual(extractDueClause('write the postmortem by EOD tomorrow'), { task: 'write the postmortem', dueRaw: 'EOD tomorrow' });
});

test('extractDueClause leaves non-date phrases alone', () => {
  assert.deepEqual(extractDueClause('cut cloud costs by 10%'), { task: 'cut cloud costs by 10%', dueRaw: null });
  assert.deepEqual(extractDueClause('schedule cutover for Saturday 10 Oct'), { task: 'schedule cutover for Saturday 10 Oct', dueRaw: null });
  assert.deepEqual(extractDueClause('share the VPN guide'), { task: 'share the VPN guide', dueRaw: null });
});

test('parseCliDate and formatDate', () => {
  assert.equal(parseCliDate('2026-10-31'), '2026-10-31');
  assert.equal(parseCliDate('today', '2026-10-22'), '2026-10-22');
  assert.equal(parseCliDate('tomorrow', '2026-10-22'), '2026-10-23');
  assert.equal(parseCliDate('31/10/2026'), null);
  assert.equal(formatDate('2026-09-11'), 'Fri 11 Sep 2026');
});
