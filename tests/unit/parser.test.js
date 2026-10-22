import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseNoteText, parseNoteFile, readNoteFile } from '../../src/parser.js';

const texts = (note) => note.actions.map((a) => a.text);

test('reads header fields and checklist items', () => {
  const n = parseNoteText([
    '# Meeting: Team standup',
    'Date: 2026-09-02',
    'Attendees: Rahul Mehta, Sam Okafor, Anita Desai',
    '',
    '## Action items',
    '- [ ] Rahul to open the repo access request by tomorrow',
    '- [x] Sam to share the VPN guide',
  ].join('\n'));
  assert.equal(n.title, 'Team standup');
  assert.equal(n.meetingDate, '2026-09-02');
  assert.deepEqual(n.attendees, ['Rahul Mehta', 'Sam Okafor', 'Anita Desai']);
  assert.equal(n.actions.length, 2);
  assert.equal(n.actions[0].checked, false);
  assert.equal(n.actions[1].checked, true);
  assert.equal(n.actions[0].lineNo, 6);
});

test('YAML front matter', () => {
  const n = parseNoteText('---\ntitle: Team standup\ndate: 2026-09-16\nattendees: [Anita Desai, Lena Fischer]\n---\n- [ ] Lena to draft it\n');
  assert.equal(n.title, 'Team standup');
  assert.equal(n.meetingDate, '2026-09-16');
  assert.deepEqual(n.attendees, ['Anita Desai', 'Lena Fischer']);
  assert.deepEqual(texts(n), ['Lena to draft it']);
});

test('all bullet styles, upper-case X, nested items and CRLF', () => {
  const n = parseNoteText('Date: 2026-10-02\r\n- [X] A to x\r\n* [ ] B to y\r\n+ [ ] C to z\r\n  - [ ] D to w\r\n');
  assert.deepEqual(texts(n), ['A to x', 'B to y', 'C to z', 'D to w']);
  assert.equal(n.actions[0].checked, true);
  assert.equal(n.actions[3].nested, true);
});

test('ignores block quotes, fenced code and HTML comments', () => {
  const n = parseNoteText([
    'Date: 2026-10-09',
    '> - [ ] Karan to refund affected customers by Friday',
    '```',
    '- [ ] Owner to remediate finding by <date>',
    '```',
    '<!-- - [ ] Sam to buy hardware tokens by Friday -->',
    '<!--',
    '- [ ] Hidden to do this',
    '-->',
    '- [ ] Sam to enable MFA by 2026-10-16',
  ].join('\n'));
  assert.deepEqual(texts(n), ['Sam to enable MFA by 2026-10-16']);
  assert.equal(n.actions[0].lineNo, 10);
});

test('tables with owner/action/due columns and ACTION: lines', () => {
  const n = parseNoteText([
    'Date: 2026-09-30',
    '| Owner | Action | Due |',
    '|-------|--------|-----|',
    '| Anita | Refresh the brand kit | 2026-10-09 |',
    '',
    '| Metric | Value |',
    '|---|---|',
    '| Churn | 2% |',
    '',
    'ACTION: Karan to circulate the offsite summary tomorrow',
  ].join('\n'));
  assert.equal(n.actions.length, 2);
  assert.deepEqual(n.actions[0], { lineNo: 4, raw: '| Anita | Refresh the brand kit | 2026-10-09 |', text: 'Refresh the brand kit', checked: false, kind: 'table', ownerHint: 'Anita', dueHint: '2026-10-09' });
  assert.equal(n.actions[1].kind, 'action-line');
  assert.equal(n.actions[1].text, 'Karan to circulate the offsite summary tomorrow');
});

test('plain bullets count only inside an action-items section', () => {
  const n = parseNoteText('Date: 2026-01-05\n## Discussion\n- Sam will look into it\n## Next steps\n- Sam to send the deck by Friday\n');
  assert.deepEqual(texts(n), ['Sam to send the deck by Friday']);
});

test('warnings for missing / unparseable metadata', () => {
  const n = parseNoteText('# Meeting: Sales\nDate: sometime last week\n- [ ] Meera to chase Orbit Labs by Friday\n');
  assert.equal(n.meetingDate, null);
  assert.ok(n.warnings.some((w) => /unrecognised meeting date/.test(w)));
  assert.ok(n.warnings.some((w) => /no attendee list/.test(w)));

  const u = parseNoteText('- [ ] Sam to chase the vendor\n', 'untitled.md');
  assert.equal(u.title, 'untitled');
  assert.ok(u.warnings.some((w) => /no meeting date/.test(w)));
});

test('unterminated code fence is reported', () => {
  const n = parseNoteText('Date: 2026-01-01\n```\n- [ ] A to b\n');
  assert.equal(n.actions.length, 0);
  assert.ok(n.warnings.some((w) => /unterminated/.test(w)));
});

test('readNoteFile rejects empty, binary and invalid UTF-8 files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-parse-'));
  const write = (name, data) => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p; };
  assert.equal(readNoteFile(write('empty.md', '')).skipReason, 'empty file');
  assert.match(readNoteFile(write('bin.md', Buffer.from([0, 1, 2, 0x89, 0x50]))).skipReason, /binary/);
  assert.match(readNoteFile(write('latin.md', Buffer.from([0x63, 0x61, 0x66, 0xe9]))).skipReason, /UTF-8/);
  assert.equal(readNoteFile(write('blank.md', '   \n\n')).skipReason, 'file has no content');
  assert.equal(readNoteFile(path.join(dir, 'missing.md')).skipReason.startsWith('cannot read'), true);
  const ok = parseNoteFile(write('bom.md', '﻿Date: 2026-01-01\n- [ ] A to b\n'));
  assert.equal(ok.skipped, null);
  assert.equal(ok.meetingDate, '2026-01-01');
});
