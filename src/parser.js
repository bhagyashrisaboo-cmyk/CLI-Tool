/**
 * Meeting-note parser.
 *
 * Turns one Markdown file into a structured ParsedNote: title, meeting date,
 * attendees and raw action lines. Owner / due-date interpretation happens in
 * owners.js and dates.js; this module only decides *which lines are actions*.
 *
 * What counts as an action item:
 *   - Markdown checklist items anywhere in the note: "- [ ] ...", "* [x] ...",
 *     "+ [X] ...", including nested (indented) ones.
 *   - "ACTION: ..." / "TODO: ..." lines.
 *   - Rows of a Markdown table whose header has an owner column and an
 *     action/task column.
 *   - Plain bullets ("- Sam to ...") inside an "Action items" / "Next steps"
 *     section.
 *
 * What is deliberately ignored (it looks like a task but was not agreed):
 *   - Lines inside fenced code blocks (``` or ~~~).
 *   - Lines inside HTML comments.
 *   - Block quotes ("> - [ ] ...").
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseMeetingDate } from './dates.js';

const CHECKBOX_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const ACTION_LINE_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?(ACTION(?:\s+ITEM)?|TODO)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$/i;
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?!\[[ xX]\])(.+?)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FIELD_RE = /^\s*(?:[-*]\s+)?(?:\*\*|__)?(date|when|attendees|participants|present)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*?)\s*$/i;
const ACTION_SECTION_RE = /^(?:action\s*items?|actions|next\s+steps|to-?dos?|follow[-\s]?ups?)\b/i;

/** Files larger than this are almost certainly not meeting notes. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Read a note from disk, refusing binary or undecodable content.
 * @returns {{ text: string|null, skipReason: string|null, warnings: string[] }}
 */
export function readNoteFile(filePath) {
  const warnings = [];
  let buf;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      return { text: null, skipReason: `file too large (${stat.size} bytes)`, warnings };
    }
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { text: null, skipReason: `cannot read file: ${err.message}`, warnings };
  }
  if (buf.length === 0) return { text: null, skipReason: 'empty file', warnings };
  if (buf.includes(0)) return { text: null, skipReason: 'binary content (NUL bytes)', warnings };

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { text: null, skipReason: 'not valid UTF-8 text', warnings };
  }
  text = text.replace(/^﻿/, '');
  // eslint-disable-next-line no-control-regex
  const controlChars = (text.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  if (controlChars > 10 && controlChars / text.length > 0.01) {
    return { text: null, skipReason: 'binary-looking content (control characters)', warnings };
  }
  if (!text.trim()) return { text: null, skipReason: 'file has no content', warnings };
  return { text, skipReason: null, warnings };
}

/** Replace HTML comments with blank lines so line numbers stay correct. */
function blankOutComments(text) {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ''));
}

function splitList(value) {
  return value
    .replace(/^\[|\]$/g, '')
    .split(/\s*(?:,|;|\band\b|&)\s*/i)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** Minimal YAML front-matter reader: "key: value" and "key: [a, b]". */
function parseFrontMatter(lines) {
  if (lines[0]?.trim() !== '---') return { fields: {}, endLine: 0 };
  const fields = {};
  for (let i = 1; i < lines.length && i < 200; i++) {
    const line = lines[i];
    if (line.trim() === '---' || line.trim() === '...') return { fields, endLine: i + 1 };
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (m) fields[m[1].toLowerCase()] = m[2].trim();
  }
  return { fields: {}, endLine: 0 }; // unterminated: treat as body
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

/**
 * Parse note text.
 * @param {string} text
 * @param {string} fileName used for messages / title fallback
 */
export function parseNoteText(text, fileName = '<memory>') {
  const warnings = [];
  const lines = blankOutComments(text.replace(/\r\n?/g, '\n')).split('\n');
  const { fields: fm, endLine } = parseFrontMatter(lines);

  let title = fm.title ? fm.title.replace(/^["']|["']$/g, '') : null;
  let dateRaw = fm.date ? fm.date.replace(/^["']|["']$/g, '') : null;
  let attendees = fm.attendees ? splitList(fm.attendees) : [];
  let sawAttendees = Boolean(fm.attendees);

  const actions = [];
  let fence = null; // the fence marker currently open, e.g. "```"
  let section = '';
  let table = null; // { ownerCol, taskCol, dueCol }

  for (let i = endLine; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];

    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^\s*>/.test(line)) continue; // quoted text is not an agreed action

    const heading = line.match(HEADING_RE);
    if (heading) {
      table = null;
      const h = heading[2].trim();
      if (!title && heading[1].length === 1) title = h.replace(/^meeting\s*:\s*/i, '');
      section = h;
      continue;
    }

    const field = line.match(FIELD_RE);
    if (field && !CHECKBOX_RE.test(line)) {
      const key = field[1].toLowerCase();
      if ((key === 'date' || key === 'when') && dateRaw === null) dateRaw = field[2];
      if (['attendees', 'participants', 'present'].includes(key) && !sawAttendees) {
        attendees = splitList(field[2]);
        sawAttendees = true;
      }
      continue;
    }

    // Tables
    if (/^\s*\|/.test(line)) {
      const cells = splitTableRow(line);
      if (!table) {
        const lower = cells.map((c) => c.toLowerCase());
        const ownerCol = lower.findIndex((c) => /^(owner|who|assignee|responsible)$/.test(c));
        const taskCol = lower.findIndex((c) => /^(action|action item|task|what|item)$/.test(c));
        const dueCol = lower.findIndex((c) => /^(due|due date|deadline|when|by)$/.test(c));
        table = ownerCol >= 0 && taskCol >= 0 ? { ownerCol, taskCol, dueCol } : { ignore: true };
        continue;
      }
      if (table.ignore || isTableSeparator(line)) continue;
      const task = cells[table.taskCol];
      if (!task) continue;
      const checked = /^\[[xX]\]\s*/.test(task);
      actions.push({
        lineNo,
        raw: line.trim(),
        text: task.replace(/^\[[ xX]\]\s*/, ''),
        checked,
        kind: 'table',
        ownerHint: cells[table.ownerCol] || null,
        dueHint: table.dueCol >= 0 ? cells[table.dueCol] || null : null,
      });
      continue;
    }
    table = null;

    const cb = line.match(CHECKBOX_RE);
    if (cb) {
      actions.push({
        lineNo,
        raw: line.trim(),
        text: cb[3],
        checked: cb[2].toLowerCase() === 'x',
        kind: 'checkbox',
        nested: cb[1].length > 0,
        ownerHint: null,
        dueHint: null,
      });
      continue;
    }

    const act = line.match(ACTION_LINE_RE);
    if (act) {
      actions.push({ lineNo, raw: line.trim(), text: act[2], checked: false, kind: 'action-line', ownerHint: null, dueHint: null });
      continue;
    }

    if (ACTION_SECTION_RE.test(section)) {
      const b = line.match(BULLET_RE);
      if (b) {
        actions.push({ lineNo, raw: line.trim(), text: b[1], checked: false, kind: 'bullet', ownerHint: null, dueHint: null });
      }
    }
  }

  if (fence) warnings.push('unterminated code block; lines after it were ignored');

  let meetingDate = null;
  if (dateRaw === null || dateRaw === '') {
    warnings.push('no meeting date found; relative due dates cannot be resolved');
  } else {
    meetingDate = parseMeetingDate(dateRaw);
    if (!meetingDate) warnings.push(`unrecognised meeting date "${dateRaw}"; relative due dates cannot be resolved`);
  }
  if (!sawAttendees) warnings.push('no attendee list; owners are matched against the team roster');
  if (!title) title = path.basename(fileName).replace(/\.md$/i, '');

  return { fileName, title, meetingDate, dateRaw, attendees, actions, warnings };
}

/** Read + parse a file. Never throws for bad content. */
export function parseNoteFile(filePath) {
  const fileName = path.basename(filePath);
  const { text, skipReason, warnings } = readNoteFile(filePath);
  if (skipReason) return { fileName, path: filePath, skipped: skipReason, warnings, actions: [] };
  const note = parseNoteText(text, fileName);
  note.path = filePath;
  note.skipped = null;
  note.warnings = [...warnings, ...note.warnings];
  return note;
}
