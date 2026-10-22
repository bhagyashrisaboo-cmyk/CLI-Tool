/**
 * Follow-up email composition.
 *
 * Builds a short, professional plain-text email listing one owner's overdue
 * and open action items. Only ever produces drafts; sending is left to a human.
 */

import { effectiveStatus } from './query.js';
import { nameMatches } from './owners.js';
import { formatDate } from './dates.js';
import { ActionTrackError } from './errors.js';

/**
 * Resolve the owner argument to exactly one person.
 * Looks at item owners and the address book.
 */
export function resolveFollowupOwner(store, query, addressBook) {
  const q = query.trim();
  if (!q) throw new ActionTrackError('Owner name is required, e.g. actiontrack followup "Priya Nair".');
  const people = new Set();
  for (const item of store.allItems()) for (const o of item.owners) people.add(o);
  if (addressBook) for (const p of addressBook.people) people.add(p.name);

  const alias = addressBook?.aliases[q.toLowerCase().replace(/[.']/g, '').replace(/\s+/g, ' ')];
  if (alias) return alias;

  const exact = [...people].filter((p) => p.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  const hits = [...people].filter((p) => nameMatches(q, p));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new ActionTrackError(`"${q}" matches more than one person: ${hits.sort().join(', ')}. Use the full name.`);
  }
  throw new ActionTrackError(`No tracked owner matches "${q}". Run "actiontrack list" to see owners.`);
}

/** Items for one person, split into overdue / open. */
export function collectItems(store, person, today) {
  const mine = store.allItems().filter((i) => i.status === 'open' && i.owners.includes(person));
  const withStatus = mine.map((i) => ({ ...i, effectiveStatus: effectiveStatus(i, today) }));
  const byDue = (a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.task.localeCompare(b.task);
  const overdue = withStatus.filter((i) => i.effectiveStatus === 'overdue').sort(byDue);
  const open = withStatus.filter((i) => i.effectiveStatus === 'open').sort(byDue);
  // Items that *might* be this person's but could not be attributed safely.
  const firstName = person.split(' ')[0].toLowerCase();
  const possible = store.allItems().filter((i) => i.status === 'open' && !i.owners.length &&
    i.ownerStatus === 'ambiguous' && (i.ownerRaw || '').toLowerCase().startsWith(firstName));
  return { overdue, open, possible };
}

function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function itemLine(item, today, person) {
  let due;
  if (item.dueDate) {
    due = `due ${formatDate(item.dueDate)}`;
    if (item.dueDate < today) {
      const days = Math.round((Date.parse(today) - Date.parse(item.dueDate)) / 86400000);
      due += ` (${days} day${days === 1 ? '' : 's'} overdue)`;
    }
  } else if (item.dueRaw) {
    due = `due "${item.dueRaw}" (exact date unclear)`;
  } else {
    due = 'no due date set';
  }
  const shared = item.owners.length > 1 ? `, shared with ${item.owners.filter((o) => o !== person).join(' & ')}` : '';
  const from = item.meetingTitle ? ` [${item.meetingTitle}${item.meetingDate ? `, ${formatDate(item.meetingDate)}` : ''}]` : '';
  return `- ${capitalise(item.task)} - ${due}${shared}${from} (ref ${item.id})`;
}

/**
 * Compose the email.
 * @returns {{to: string|null, toName: string, subject: string, body: string, items: object[], warnings: string[]}}
 */
export function composeFollowup({ person, overdue, open, possible = [], today, addressBook, senderName }) {
  const warnings = [];
  const entry = addressBook?.people.find((p) => p.name === person) || null;
  const to = entry?.email || null;
  if (!to) warnings.push(`No email address for ${person} in the address book; the draft has no recipient.`);
  if (possible.length) {
    warnings.push(`${possible.length} open item(s) name an ambiguous "${person.split(' ')[0]}" and were not included: ${possible.map((p) => p.id).join(', ')}.`);
  }

  const first = person.split(' ')[0];
  const total = overdue.length + open.length;
  const subject = overdue.length
    ? `Follow-up: ${total} open action item${total === 1 ? '' : 's'} (${overdue.length} overdue)`
    : `Follow-up: ${total} open action item${total === 1 ? '' : 's'}`;

  const lines = [`Hi ${first},`, ''];
  lines.push(`Here is a quick round-up of the action items from our recent meetings that are still open with you, as of ${formatDate(today)}.`);
  lines.push('');
  if (overdue.length) {
    lines.push('Overdue:');
    for (const i of overdue) lines.push(itemLine(i, today, person));
    lines.push('');
  }
  if (open.length) {
    lines.push(overdue.length ? 'Still open:' : 'Open:');
    for (const i of open) lines.push(itemLine(i, today, person));
    lines.push('');
  }
  lines.push(overdue.length
    ? 'Could you reply with a short status update on each, and a revised date for anything overdue? If something is already done or no longer needed, just let me know and I will update the tracker.'
    : 'Could you reply with a short status update when you get a moment? If something is already done or no longer needed, just let me know and I will update the tracker.');
  lines.push('');
  lines.push('Thanks,');
  if (senderName) lines.push(senderName);

  return { to, toName: person, subject, body: `${lines.join('\n')}\n`, items: [...overdue, ...open], warnings };
}

function encodeHeader(value) {
  // RFC 2047 encode non-ASCII header values.
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Build an RFC 5322 message (string). */
export function toMime(email, { date = new Date() } = {}) {
  const headers = [];
  if (email.to) headers.push(`To: ${encodeHeader(email.toName)} <${email.to}>`);
  headers.push(`Subject: ${encodeHeader(email.subject)}`);
  headers.push(`Date: ${date.toUTCString().replace('GMT', '+0000')}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: base64');
  headers.push('X-ActionTrack: draft-for-review');
  const body = Buffer.from(email.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}
