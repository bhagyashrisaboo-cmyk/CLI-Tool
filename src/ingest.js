/**
 * Ingestion: parse a folder of notes and merge the action items into the store.
 *
 * Duplicate prevention works at two levels:
 *  1. Mention level - every action line is keyed by (file name, line text).
 *     Re-ingesting the same notes is a no-op.
 *  2. Item level - the same task carried over from meeting to meeting
 *     ("Rahul to fix the pagination bug" on 15 Sep and again on 22 Sep) is
 *     linked to one tracked item when the owner is the same and the task text
 *     matches. A later "[x]" closes it; a later mention with a new due date
 *     reschedules it. Linking only happens when the owner is certain.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractDueClause, resolveDue } from './dates.js';
import { parseNoteFile } from './parser.js';
import { splitOwner, resolveOwner, displayToken } from './owners.js';
import { ActionTrackError } from './errors.js';
import { logger } from './logger.js';

const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'our', 'their', 'with', 'on', 'in']);
export const LINK_THRESHOLD = 0.85;

export function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

/** Normalised task text used for matching carry-over items. */
export function taskKey(task) {
  return task
    .toLowerCase()
    .replace(/[’']s\b/g, 's')
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w))
    .join(' ');
}

/** Sørensen-Dice similarity over character bigrams (0..1). */
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) || 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

function mentionKey(fileName, rawLine) {
  return sha1(`${fileName}\n${rawLine.replace(/\s+/g, ' ').trim()}`);
}

/** List the Markdown files to ingest (sorted, optionally recursive). */
export function listNoteFiles(folder, { recursive = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(folder);
  } catch {
    throw new ActionTrackError(`Folder not found: ${folder}`);
  }
  if (!stat.isDirectory()) throw new ActionTrackError(`Not a folder: ${folder}`);

  const md = [];
  const ignored = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      logger.warn(`cannot read folder ${dir}: ${err.message}`);
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && !e.name.startsWith('.')) walk(full);
      } else if (e.isFile()) {
        if (/\.(md|markdown)$/i.test(e.name)) md.push(full);
        else ignored.push(full);
      }
    }
  };
  walk(folder);
  md.sort();
  return { files: md, ignored };
}

/**
 * Interpret one raw action line into a candidate item.
 * Exported for unit tests.
 */
export function interpretAction(action, note, roster, aliases) {
  const flags = [];
  const split = splitOwner(action.text, action.ownerHint);
  let { task } = split;

  // Due date: explicit table column first, then a trailing "by ..." clause.
  let dueRaw = null;
  if (action.dueHint) {
    dueRaw = action.dueHint;
  } else {
    const d = extractDueClause(task);
    task = d.task;
    dueRaw = d.dueRaw;
  }
  const due = resolveDue(dueRaw, note.meetingDate);
  if (due.note) flags.push(due.note);

  let owners = [];
  let ownerStatus = split.kind;
  if (split.kind === 'named') {
    const resolvedNames = [];
    let worst = 'resolved';
    for (const tok of split.ownerTokens) {
      const r = resolveOwner(tok, note.attendees, roster, aliases);
      if (r.status === 'resolved') {
        resolvedNames.push(r.name);
        if (r.via === 'roster' && note.attendees.length) flags.push(`owner "${tok}" is not on the attendee list; matched ${r.name} from the team roster`);
        if (r.via === 'roster' && !note.attendees.length) flags.push(`owner "${tok}" matched ${r.name} from the team roster (no attendee list)`);
      } else if (r.status === 'ambiguous') {
        worst = 'ambiguous';
        flags.push(`ambiguous owner "${tok}": could be ${r.candidates.join(' or ')}`);
      } else {
        if (worst !== 'ambiguous') worst = 'unknown';
        resolvedNames.push(displayToken(tok));
        flags.push(`owner "${tok}" is not a known person`);
      }
    }
    ownerStatus = worst;
    owners = worst === 'ambiguous' ? [] : [...new Set(resolvedNames)];
  } else if (split.kind === 'group') {
    flags.push(`group owner "${split.ownerRaw}": no single person is responsible`);
  } else if (split.kind === 'unassigned') {
    flags.push(`unassigned ("${split.ownerRaw}")`);
  } else {
    flags.push('no owner named');
  }

  const collaborators = split.collaborators.map((c) => {
    const r = resolveOwner(c, note.attendees, roster, aliases);
    return r.status === 'resolved' ? r.name : displayToken(c);
  });

  return {
    owners,
    ownerRaw: split.ownerRaw,
    ownerStatus,
    collaborators,
    task,
    taskKey: taskKey(task),
    dueDate: due.date,
    dueRaw: due.raw,
    flags,
  };
}

function ownersKey(owners) {
  return [...owners].sort().join('|');
}

function findLinkedItem(store, cand) {
  if (!cand.owners.length || !['resolved', 'unknown'].includes(cand.ownerStatus)) return null;
  const key = ownersKey(cand.owners);
  let best = null;
  let bestScore = 0;
  for (const item of store.allItems()) {
    if (!item.owners.length || ownersKey(item.owners) !== key) continue;
    const score = similarity(item.taskKey, cand.taskKey);
    // Prefer open items on ties so a new mention attaches to the live one.
    const adjusted = score + (item.status === 'open' ? 0.001 : 0);
    if (score >= LINK_THRESHOLD && adjusted > bestScore) {
      best = item;
      bestScore = adjusted;
    }
  }
  return best;
}

function newItemId(store, key) {
  for (let len = 7; len <= 40; len++) {
    const id = sha1(`item:${key}`).slice(0, len);
    if (!store.getItem(id)) return id;
  }
  throw new Error('could not allocate an item id');
}

/**
 * Ingest a folder into the store.
 * @returns {object} report with per-file results and totals
 */
export function ingestFolder(store, folder, { recursive = false, addressBook = null, now = new Date() } = {}) {
  const { files, ignored } = listNoteFiles(folder, { recursive });
  const stamp = now.toISOString();
  const report = { folder, files: [], ignored: ignored.map((f) => path.basename(f)), totals: { new: 0, linked: 0, completed: 0, rescheduled: 0, duplicates: 0, skipped: 0, flagged: 0 } };

  // Parse everything first so the roster includes every attendee list.
  const notes = files.map((f) => {
    try {
      return parseNoteFile(f);
    } catch (err) {
      logger.error(`unexpected error parsing ${f}: ${err.stack || err}`);
      return { fileName: path.basename(f), path: f, skipped: `parser error: ${err.message}`, warnings: [], actions: [] };
    }
  });

  store.transaction(() => {
    const roster = new Set(store.knownPeople());
    for (const n of notes) for (const a of n.attendees || []) roster.add(a);
    if (addressBook) for (const p of addressBook.people) roster.add(p.name);
    const rosterList = [...roster];
    const aliases = addressBook ? addressBook.aliases : {};

    const ordered = [...notes].sort((a, b) => {
      const da = a.meetingDate || '9999-99-99';
      const db = b.meetingDate || '9999-99-99';
      return da === db ? a.fileName.localeCompare(b.fileName) : da.localeCompare(db);
    });

    for (const note of ordered) {
      const fr = { file: note.fileName, status: 'ok', meetingDate: note.meetingDate || null, actions: 0, new: 0, linked: 0, completed: 0, rescheduled: 0, duplicates: 0, warnings: [...(note.warnings || [])] };
      report.files.push(fr);

      if (note.skipped) {
        fr.status = 'skipped';
        fr.reason = note.skipped;
        report.totals.skipped++;
        store.putFile(note.fileName, { path: note.path, status: 'skipped', reason: note.skipped, ingestedAt: stamp });
        logger.debug(`skipped ${note.fileName}: ${note.skipped}`);
        continue;
      }

      for (const action of note.actions) {
        fr.actions++;
        try {
          processAction(store, note, action, rosterList, aliases, stamp, fr);
        } catch (err) {
          fr.warnings.push(`line ${action.lineNo}: could not process action (${err.message})`);
          logger.error(`${note.fileName}:${action.lineNo}: ${err.stack || err}`);
        }
      }
      if (!note.actions.length) fr.warnings.push('no action items found');

      store.putFile(note.fileName, {
        path: note.path, status: 'ok', title: note.title, meetingDate: note.meetingDate,
        attendees: note.attendees, actions: note.actions.length, warnings: fr.warnings, ingestedAt: stamp,
      });
      for (const k of ['new', 'linked', 'completed', 'rescheduled', 'duplicates']) report.totals[k] += fr[k];
      for (const w of fr.warnings) logger.debug(`${note.fileName}: ${w}`);
    }
    report.totals.flagged = store.allItems().filter((i) => i.status === 'open' && i.flags.length).length;
  });

  return report;
}

function processAction(store, note, action, roster, aliases, stamp, fr) {
  const key = mentionKey(note.fileName, action.raw);
  if (store.hasMention(key)) {
    fr.duplicates++;
    return;
  }
  const cand = interpretAction(action, note, roster, aliases);
  const where = `${note.fileName}:${action.lineNo}`;
  for (const f of cand.flags) fr.warnings.push(`line ${action.lineNo}: ${f}`);

  const linked = findLinkedItem(store, cand);
  let item;
  if (linked) {
    item = linked;
    fr.linked++;
    item.history.push({ at: note.meetingDate, event: action.checked ? 'marked done in notes' : 'mentioned again', source: where });
    if (action.checked && item.status === 'open') {
      item.status = 'done';
      item.completedAt = note.meetingDate || stamp.slice(0, 10);
      item.completedBy = `notes:${note.fileName}`;
      fr.completed++;
    } else if (!action.checked && item.status === 'open') {
      const isLater = !item.lastSeenDate || (note.meetingDate && note.meetingDate >= item.lastSeenDate);
      if (isLater && cand.dueDate && cand.dueDate !== item.dueDate) {
        item.history.push({ at: note.meetingDate, event: `rescheduled from ${item.dueDate || 'no date'} to ${cand.dueDate}`, source: where });
        item.dueDate = cand.dueDate;
        item.dueRaw = cand.dueRaw;
        item.flags = item.flags.filter((f) => !/due date|meeting date unknown|no year given/.test(f));
        fr.rescheduled++;
      } else if (isLater && !item.dueDate && cand.dueRaw) {
        item.dueRaw = cand.dueRaw;
      }
    }
    if (note.meetingDate && (!item.lastSeenDate || note.meetingDate >= item.lastSeenDate)) {
      item.lastSeenDate = note.meetingDate;
      item.lastSeenFile = note.fileName;
    }
    item.updatedAt = stamp;
  } else {
    item = {
      id: newItemId(store, key),
      owners: cand.owners,
      ownerRaw: cand.ownerRaw,
      ownerStatus: cand.ownerStatus,
      collaborators: cand.collaborators,
      task: cand.task,
      taskKey: cand.taskKey,
      dueDate: cand.dueDate,
      dueRaw: cand.dueRaw,
      status: action.checked ? 'done' : 'open',
      sourceFile: note.fileName,
      sourceLine: action.lineNo,
      meetingTitle: note.title,
      meetingDate: note.meetingDate,
      lastSeenFile: note.fileName,
      lastSeenDate: note.meetingDate,
      flags: cand.flags,
      history: [{ at: note.meetingDate, event: action.checked ? 'recorded as done' : 'created', source: where }],
      createdAt: stamp,
      updatedAt: stamp,
      completedAt: action.checked ? note.meetingDate || stamp.slice(0, 10) : null,
      completedBy: action.checked ? `notes:${note.fileName}` : null,
    };
    store.putItem(item);
    fr.new++;
  }
  store.putMention(key, { itemId: item.id, file: note.fileName, line: action.lineNo, raw: action.raw, checked: action.checked, meetingDate: note.meetingDate, ingestedAt: stamp });
}
