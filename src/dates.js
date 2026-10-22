/**
 * Date utilities and due-date resolution.
 *
 * All calendar dates are handled as ISO strings ("YYYY-MM-DD") and computed
 * in UTC so results never shift with the machine's time zone.
 *
 * Resolution policy (never invent information):
 *  - Absolute dates (2026-09-08, 10 Sep, Oct 3rd) resolve directly. A missing
 *    year is taken from the meeting date (rolled forward if it would land
 *    more than 60 days before the meeting).
 *  - Relative dates (Friday, tomorrow, EOD, end of next week) resolve against
 *    the meeting date. A bare weekday means the next such day strictly after
 *    the meeting ("by Friday" said on a Friday = the following Friday).
 *  - Vague or ambiguous phrases ("next Tuesday", "mid-October", "next week")
 *    and relative phrases without a known meeting date stay unresolved: the
 *    raw text is kept and a note explains why.
 */

const WEEKDAYS = {
  monday: 0, mon: 0,
  tuesday: 1, tue: 1, tues: 1,
  wednesday: 2, wed: 2,
  thursday: 3, thu: 3, thur: 3, thurs: 3,
  friday: 4, fri: 4,
  saturday: 5, sat: 5,
  sunday: 6, sun: 6,
};

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

const WD = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY = '\\d{1,2}(?:st|nd|rd|th)?';
const YEAR = '\\d{4}';

/** Every date expression we recognise, longest/most specific first. */
const DATE_EXPR = [
  `${YEAR}-\\d{2}-\\d{2}`,
  `(?:${WD},?\\s+)?${DAY}\\s+${MON}\\.?(?:,?\\s+${YEAR})?`,
  `(?:${WD},?\\s+)?${MON}\\.?\\s+${DAY}(?:,?\\s+${YEAR})?`,
  `(?:eod|cob|end\\s+of\\s+(?:the\\s+)?day|close\\s+of\\s+business)(?:\\s+tomorrow)?`,
  'tomorrow',
  'today',
  `end\\s+of\\s+(?:the\\s+|this\\s+|next\\s+)?(?:week|month)`,
  `(?:mid|early|late|end)[-\\s](?:of\\s+)?${MON}`,
  `(?:next|this)\\s+(?:week|month)`,
  `(?:next|this)\\s+${WD}`,
  WD,
  MON,
].join('|');

const DUE_MARKER = '(?:no\\s+later\\s+than|(?:results\\s+)?due(?:\\s+(?:by|on))?|by|before|on|from|until)';

/**
 * Matches a trailing due clause, e.g. " by Friday", " — by 2026-10-09",
 * ", results due 15 October", " (by Mon)".
 */
const DUE_CLAUSE_RE = new RegExp(
  `[\\s,;:\\u2014\\u2013-]*\\(?\\s*\\b${DUE_MARKER}\\s+(${DATE_EXPR})\\s*\\)?[\\s.!]*$`,
  'i',
);

/** "... circulate the summary tomorrow" - relative words that need no "by". */
const BARE_RELATIVE_RE = /[\s,;:—–-]+((?:eod|cob|end\s+of\s+(?:the\s+)?day)(?:\s+tomorrow)?|tomorrow|today)[\s.!]*$/i;

// ---------------------------------------------------------------- helpers

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Build an ISO date string, or null if the calendar date is invalid. */
export function makeDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return makeDate(y, m, d) !== null;
}

function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTC(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(iso, n) {
  const d = toUTC(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}

/** Monday = 0 ... Sunday = 6 */
export function weekdayOf(iso) {
  return (toUTC(iso).getUTCDay() + 6) % 7;
}

export function diffDays(a, b) {
  return Math.round((toUTC(a) - toUTC(b)) / 86400000);
}

function lastDayOfMonth(year, month) {
  return fromUTC(new Date(Date.UTC(year, month, 0)));
}

/** Today's date in local time as ISO (what a user means by "today"). */
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Human-friendly rendering, e.g. "Fri 11 Sep 2026". */
export function formatDate(iso) {
  if (!iso) return '';
  const d = toUTC(iso);
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][weekdayOf(iso)];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${wd} ${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}`;
}

function lookupMonth(token) {
  return MONTHS[token.toLowerCase().replace(/\.$/, '')];
}

function lookupWeekday(token) {
  return WEEKDAYS[token.toLowerCase().replace(/,$/, '')];
}

// --------------------------------------------------------- meeting dates

/**
 * Parse the value of a "Date:" header. Accepts ISO, "9 September 2026",
 * "Monday, 14 September 2026", "September 9, 2026". Anything else (e.g.
 * "sometime last week", "14/09/2026" which is DD/MM vs MM/DD ambiguous)
 * returns null.
 */
export function parseMeetingDate(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/[*_`]/g, '').trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (m) return makeDate(+m[1], +m[2], +m[3]);

  const wdPrefix = `(?:${WD},?\\s+)?`;
  m = s.match(new RegExp(`^${wdPrefix}(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})\\.?,?\\s+(\\d{4})$`, 'i'));
  if (m) {
    const month = lookupMonth(m[2]);
    return month ? makeDate(+m[3], month, +m[1]) : null;
  }
  m = s.match(new RegExp(`^${wdPrefix}(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})$`, 'i'));
  if (m) {
    const month = lookupMonth(m[1]);
    return month ? makeDate(+m[3], month, +m[2]) : null;
  }
  return null;
}

/**
 * Parse a user-supplied date on the command line (--due-before, --today).
 * Accepts ISO dates plus "today" / "tomorrow".
 */
export function parseCliDate(text, today = todayISO()) {
  const s = String(text || '').trim().toLowerCase();
  if (s === 'today') return today;
  if (s === 'tomorrow') return addDays(today, 1);
  if (isISODate(s)) return s;
  return null;
}

// ------------------------------------------------------------ due dates

/**
 * Split a trailing due clause off an action's text.
 * @returns {{ task: string, dueRaw: string|null }}
 */
export function extractDueClause(text) {
  const m = text.match(DUE_CLAUSE_RE) || text.match(BARE_RELATIVE_RE);
  if (!m) return { task: text.trim(), dueRaw: null };
  const task = text.slice(0, m.index).replace(/[\s,;:—–-]+$/, '').trim();
  if (!task) return { task: text.trim(), dueRaw: null };
  return { task, dueRaw: m[1].trim() };
}

function resolved(date, raw, note = null) {
  return { date, raw, note };
}

function unresolved(raw, note) {
  return { date: null, raw, note };
}

/**
 * Resolve a due expression (the part after "by") to an ISO date.
 * @param {string|null} raw  e.g. "Friday", "10 Sep", "2026-10-09"
 * @param {string|null} meetingDate ISO date of the meeting, if known
 * @returns {{date: string|null, raw: string|null, note: string|null}}
 */
export function resolveDue(raw, meetingDate) {
  if (!raw) return resolved(null, null);
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');

  // ISO
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = makeDate(+m[1], +m[2], +m[3]);
    return d ? resolved(d, raw) : unresolved(raw, `invalid date "${raw}"`);
  }

  // [weekday] day month [year]  |  [weekday] month day [year]
  const dm = s.match(new RegExp(`^(?:(${WD}),? )?(\\d{1,2})(?:st|nd|rd|th)? (${MON})\\.?(?:,? (\\d{4}))?$`, 'i'));
  const md = s.match(new RegExp(`^(?:(${WD}),? )?(${MON})\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$`, 'i'));
  if (dm || md) {
    const wdTok = dm ? dm[1] : md[1];
    const day = +(dm ? dm[2] : md[3]);
    const month = lookupMonth(dm ? dm[3] : md[2]);
    const yearTok = dm ? dm[4] : md[4];
    let date;
    if (yearTok) {
      date = makeDate(+yearTok, month, day);
    } else {
      if (!meetingDate) return unresolved(raw, 'no year given and meeting date unknown');
      const year = +meetingDate.slice(0, 4);
      date = makeDate(year, month, day);
      if (date && diffDays(date, meetingDate) < -60) date = makeDate(year + 1, month, day);
    }
    if (!date) return unresolved(raw, `invalid date "${raw}"`);
    if (wdTok && lookupWeekday(wdTok) !== weekdayOf(date)) {
      return resolved(date, raw, `weekday in "${raw}" does not match ${formatDate(date)}`);
    }
    return resolved(date, raw);
  }

  // Vague phrases: never guess.
  if (new RegExp(`^(?:mid|early|late|end)[- ](?:of )?${MON}$`).test(s) ||
      /^(?:next|this) (?:week|month)$/.test(s) ||
      new RegExp(`^${MON}$`).test(s)) {
    return unresolved(raw, `vague due date "${raw}"`);
  }
  if (new RegExp(`^next ${WD}$`).test(s)) {
    return unresolved(raw, `ambiguous due date "${raw}" (this coming or the following week?)`);
  }

  // Everything below is relative to the meeting date.
  if (!meetingDate) return unresolved(raw, 'relative due date but meeting date unknown');

  if (s === 'today' || /^(?:eod|cob|end of (?:the )?day|close of business)$/.test(s)) {
    return resolved(meetingDate, raw);
  }
  if (s === 'tomorrow' || /^(?:eod|cob|end of (?:the )?day|close of business) tomorrow$/.test(s)) {
    return resolved(addDays(meetingDate, 1), raw);
  }

  m = s.match(new RegExp(`^(?:this )?(${WD})$`));
  if (m) {
    const target = lookupWeekday(m[1]);
    let delta = (target - weekdayOf(meetingDate) + 7) % 7;
    if (delta === 0) delta = 7;
    return resolved(addDays(meetingDate, delta), raw);
  }

  m = s.match(/^end of (?:the |this |next )?(week|month)$/);
  if (m) {
    const next = /\bnext\b/.test(s);
    if (m[1] === 'week') {
      const wd = weekdayOf(meetingDate);
      if (!next && wd > 4) return unresolved(raw, `"${raw}" said after Friday is ambiguous`);
      return resolved(addDays(meetingDate, 4 - wd + (next ? 7 : 0)), raw);
    }
    const y = +meetingDate.slice(0, 4);
    const mo = +meetingDate.slice(5, 7) + (next ? 1 : 0);
    return resolved(mo > 12 ? lastDayOfMonth(y + 1, mo - 12) : lastDayOfMonth(y, mo), raw);
  }

  return unresolved(raw, `unrecognised due date "${raw}"`);
}
