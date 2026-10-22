/**
 * Querying and status changes.
 *
 * Effective status is derived, not stored:
 *   done     - marked done (via CLI or a checked box in a later note)
 *   overdue  - not done and due date is before today
 *   open     - not done and not overdue (including items with no due date)
 */

import { nameMatches } from './owners.js';
import { ActionTrackError } from './errors.js';

export const STATUSES = ['open', 'done', 'overdue'];

export function effectiveStatus(item, today) {
  if (item.status === 'done') return 'done';
  if (item.dueDate && item.dueDate < today) return 'overdue';
  return 'open';
}

/** Display owner: canonical names, or the raw text with a marker. */
export function ownerLabel(item) {
  if (item.owners.length) return item.owners.join(' & ');
  if (item.ownerStatus === 'ambiguous') return `${item.ownerRaw} (?)`;
  if (item.ownerRaw) return `(${item.ownerRaw})`;
  return '(none)';
}

/** Does the --owner query match this item? Case-insensitive, first names OK. */
export function ownerMatches(item, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.owners.some((o) => nameMatches(query, o) || o.toLowerCase().includes(q))) return true;
  return Boolean(item.ownerRaw && item.ownerRaw.toLowerCase().replace(/^@/, '').includes(q.replace(/^@/, '')));
}

/**
 * Filter + sort items.
 * @param {object[]} items
 * @param {{owner?: string, statuses?: string[], dueBefore?: string, flagged?: boolean, today: string}} opts
 */
export function filterItems(items, { owner = null, statuses = null, dueBefore = null, flagged = false, today }) {
  const want = statuses && statuses.length ? new Set(statuses) : new Set(['open', 'overdue']);
  const rank = { overdue: 0, open: 1, done: 2 };
  return items
    .map((item) => ({ ...item, effectiveStatus: effectiveStatus(item, today) }))
    .filter((i) => want.has(i.effectiveStatus))
    .filter((i) => !owner || ownerMatches(i, owner))
    .filter((i) => !dueBefore || (i.dueDate && i.dueDate < dueBefore))
    .filter((i) => !flagged || i.flags.length > 0)
    .sort((a, b) =>
      rank[a.effectiveStatus] - rank[b.effectiveStatus] ||
      (a.dueDate || '9999').localeCompare(b.dueDate || '9999') ||
      ownerLabel(a).localeCompare(ownerLabel(b)) ||
      a.id.localeCompare(b.id));
}

function lookupOne(store, id) {
  const hits = store.findById(id);
  if (!hits.length) {
    const hint = String(id || '').trim().length < 4 ? ' (use at least 4 characters of the ID)' : '';
    throw new ActionTrackError(`No action item with ID "${id}"${hint}. Run "actiontrack list --all" to see IDs.`);
  }
  if (hits.length > 1) {
    throw new ActionTrackError(`ID prefix "${id}" is ambiguous; it matches ${hits.map((h) => h.id).join(', ')}.`);
  }
  return hits[0];
}

/**
 * Mark an item done.
 * @returns {{item: object, changed: boolean}}
 */
export function markDone(store, id, { today, now = new Date() }) {
  return store.transaction(() => {
    const item = lookupOne(store, id);
    if (item.status === 'done') return { item, changed: false };
    item.status = 'done';
    item.completedAt = today;
    item.completedBy = 'cli';
    item.updatedAt = now.toISOString();
    item.history.push({ at: today, event: 'marked done via CLI', source: 'cli' });
    return { item, changed: true };
  });
}

/** Undo "done" (for mistakes). */
export function reopen(store, id, { today, now = new Date() }) {
  return store.transaction(() => {
    const item = lookupOne(store, id);
    if (item.status !== 'done') return { item, changed: false };
    item.status = 'open';
    item.completedAt = null;
    item.completedBy = null;
    item.updatedAt = now.toISOString();
    item.history.push({ at: today, event: 'reopened via CLI', source: 'cli' });
    return { item, changed: true };
  });
}

export function getItem(store, id) {
  return lookupOne(store, id);
}
