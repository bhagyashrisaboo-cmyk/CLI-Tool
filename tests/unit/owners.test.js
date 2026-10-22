import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitOwner, resolveOwner, nameMatches } from '../../src/owners.js';

test('splitOwner: "X to ..."', () => {
  const r = splitOwner('Priya to send the revised quote by Friday');
  assert.deepEqual(r.ownerTokens, ['Priya']);
  assert.equal(r.kind, 'named');
  assert.equal(r.task, 'send the revised quote by Friday');
});

test('splitOwner: initials, @mentions, multiple owners, collaborators', () => {
  assert.deepEqual(splitOwner('Priya N. to send it').ownerTokens, ['Priya N.']);
  const at = splitOwner('@anita: audit colour contrast by Mon');
  assert.deepEqual(at.ownerTokens, ['anita']);
  assert.equal(at.task, 'audit colour contrast by Mon');
  assert.deepEqual(splitOwner('Anita & Rahul to agree on the component API').ownerTokens, ['Anita', 'Rahul']);
  const w = splitOwner('Lena (with Priya) to collect user feedback');
  assert.deepEqual(w.ownerTokens, ['Lena']);
  assert.deepEqual(w.collaborators, ['Priya']);
});

test('splitOwner: group, placeholder and missing owners', () => {
  assert.equal(splitOwner('Everyone to review the prototype').kind, 'group');
  assert.equal(splitOwner('Team to decide on the launch date').kind, 'group');
  assert.equal(splitOwner('Someone to update the CRM notes').kind, 'unassigned');
  assert.equal(splitOwner('TBD to write the changelog').kind, 'unassigned');
  const none = splitOwner('Book the venue');
  assert.equal(none.kind, 'none');
  assert.equal(none.task, 'Book the venue');
  assert.equal(splitOwner('Review the plan to cut costs').kind, 'none'); // lower-case words are not names
});

test('splitOwner: explicit owner hint (table column)', () => {
  const r = splitOwner('Refresh the brand kit', 'Anita');
  assert.deepEqual(r.ownerTokens, ['Anita']);
  assert.equal(r.task, 'Refresh the brand kit');
  assert.equal(splitOwner('Do it', '').kind, 'none');
});

test('nameMatches', () => {
  assert.ok(nameMatches('Priya', 'Priya Nair'));
  assert.ok(nameMatches('priya n.', 'Priya Nair'));
  assert.ok(!nameMatches('Priya S.', 'Priya Nair'));
  assert.ok(nameMatches('@anita', 'Anita Desai'));
  assert.ok(!nameMatches('Rahul', 'Priya Nair'));
});

const roster = ['Priya Nair', 'Priya Shah', 'Rahul Mehta', 'Rahul Verma', 'Sam Okafor'];

test('resolveOwner prefers meeting attendees', () => {
  const r = resolveOwner('Priya', ['Priya Nair', 'Karan Joshi'], roster);
  assert.equal(r.name, 'Priya Nair');
  assert.equal(r.via, 'attendees');
});

test('resolveOwner reports ambiguity instead of guessing', () => {
  const r = resolveOwner('Priya', ['Priya Nair', 'Priya Shah'], roster);
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.name, null);
  assert.deepEqual(r.candidates.sort(), ['Priya Nair', 'Priya Shah']);
  assert.equal(resolveOwner('Priya S.', ['Priya Nair', 'Priya Shah'], roster).name, 'Priya Shah');
});

test('resolveOwner falls back to the roster only when unique', () => {
  assert.equal(resolveOwner('Sam', [], roster).name, 'Sam Okafor');
  assert.equal(resolveOwner('Sam', [], roster).via, 'roster');
  assert.equal(resolveOwner('Rahul', [], roster).status, 'ambiguous');
  assert.equal(resolveOwner('Zed', [], roster).status, 'unknown');
});

test('resolveOwner uses address-book aliases first', () => {
  const r = resolveOwner('PN', ['Priya Nair', 'Priya Shah'], roster, { pn: 'Priya Nair' });
  assert.equal(r.name, 'Priya Nair');
  assert.equal(r.via, 'address book');
});
