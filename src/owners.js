/**
 * Owner extraction and resolution.
 *
 * splitOwner("Priya N. to send the quote by Friday")
 *   -> { ownerTokens: ["Priya N."], collaborators: [], kind: "named", task: "send the quote by Friday" }
 *
 * resolveOwner("Priya N.", attendees, roster)
 *   -> { name: "Priya Nair", status: "resolved", via: "attendees" }
 *
 * Resolution never guesses: if a short name matches two attendees (two Priyas
 * in the room) the owner is reported as ambiguous and left unassigned.
 */

const GROUP_WORDS = new Set(['everyone', 'everybody', 'team', 'the team', 'all', 'all of us', 'whole team']);
const PLACEHOLDER_WORDS = new Set(['someone', 'somebody', 'tbd', 'tba', 'tbc', 'nobody', 'owner', 'anyone', 'unassigned', 'n/a', '?', '??']);

const VERB_RE = /\s+(?:to|will|should|must|needs\s+to|has\s+to|is\s+to|shall)\s+/i;

function isNameWord(w) {
  return /^[A-Z][\p{L}'’-]*\.?$/u.test(w) || /^[A-Z]\.$/.test(w);
}

function isPersonToken(tok) {
  const words = tok.trim().split(/\s+/);
  return words.length >= 1 && words.length <= 3 && words.every(isNameWord);
}

function classify(tok) {
  const t = tok.trim().toLowerCase();
  if (GROUP_WORDS.has(t)) return 'group';
  if (PLACEHOLDER_WORDS.has(t)) return 'unassigned';
  return null;
}

/**
 * Split "Owner to do something" into owner tokens and the task.
 * @param {string} text  action text without the checkbox
 * @param {string|null} ownerHint explicit owner (e.g. from a table column)
 */
export function splitOwner(text, ownerHint = null) {
  const clean = text.trim();

  if (ownerHint !== null && ownerHint !== undefined) {
    const hint = ownerHint.trim();
    const kind = !hint ? 'none' : classify(hint) || 'named';
    return { ownerRaw: hint || null, ownerTokens: kind === 'named' ? splitNames(hint) : [], collaborators: [], kind, task: clean };
  }

  // "@anita: audit colour contrast" / "@anita audit ..."
  let m = clean.match(/^@([\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*)?)\s*[:,-]\s*(.+)$/u) ||
          clean.match(/^@([\p{L}][\p{L}.'-]*)\s+(.+)$/u);
  if (m) {
    return { ownerRaw: `@${m[1]}`, ownerTokens: [m[1]], collaborators: [], kind: 'named', task: m[2].trim() };
  }

  // "Name: task" (e.g. "Sam: rotate creds")
  m = clean.match(/^([A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*)?)\s*:\s+(.+)$/u);
  if (m && isPersonToken(m[1]) && !classify(m[1])) {
    return { ownerRaw: m[1], ownerTokens: [m[1]], collaborators: [], kind: 'named', task: m[2].trim() };
  }

  const verb = clean.match(VERB_RE);
  if (verb && verb.index > 0 && verb.index <= 60) {
    let ownerPart = clean.slice(0, verb.index).trim();
    const task = clean.slice(verb.index + verb[0].length).trim();
    const collaborators = [];
    ownerPart = ownerPart.replace(/\s*\((?:with|w\/|cc|plus|and)\s+([^)]+)\)\s*/i, (_, who) => {
      collaborators.push(...splitNames(who));
      return ' ';
    }).trim();

    const kind = classify(ownerPart);
    if (kind) return { ownerRaw: ownerPart, ownerTokens: [], collaborators, kind, task };

    const tokens = splitNames(ownerPart);
    if (tokens.length && tokens.every(isPersonToken)) {
      return { ownerRaw: ownerPart, ownerTokens: tokens, collaborators, kind: 'named', task };
    }
  }

  return { ownerRaw: null, ownerTokens: [], collaborators: [], kind: 'none', task: clean };
}

function splitNames(s) {
  return s.split(/\s*(?:&|,|\/|\band\b|\+)\s*/i).map((x) => x.trim()).filter(Boolean);
}

function norm(s) {
  return s.toLowerCase().replace(/^@/, '').replace(/[.’']/g, '').replace(/\s+/g, ' ').trim();
}

/** Does a short token ("Priya", "Priya N.", "priya nair") refer to fullName? */
export function nameMatches(token, fullName) {
  const t = norm(token).split(' ');
  const f = norm(fullName).split(' ');
  if (t.join(' ') === f.join(' ')) return true;
  if (t[0] !== f[0]) return false;
  if (t.length === 1) return true;
  if (f.length < 2) return false;
  // "Priya N" / "Priya Nair" / "Priya Na"
  return f[f.length - 1].startsWith(t[t.length - 1]);
}

/**
 * Resolve an owner token to a canonical person.
 * @param {string} token
 * @param {string[]} attendees meeting attendees (may be empty)
 * @param {string[]} roster every known person (all attendee lists + address book)
 * @param {Record<string,string>} aliases lower-case alias -> full name (address book)
 * @returns {{name: string|null, status: 'resolved'|'ambiguous'|'unknown', via: string|null, candidates: string[]}}
 */
export function resolveOwner(token, attendees = [], roster = [], aliases = {}) {
  const alias = aliases[norm(token)];
  if (alias) return { name: alias, status: 'resolved', via: 'address book', candidates: [alias] };

  if (attendees.length) {
    const hits = attendees.filter((a) => nameMatches(token, a));
    if (hits.length === 1) return { name: hits[0], status: 'resolved', via: 'attendees', candidates: hits };
    if (hits.length > 1) return { name: null, status: 'ambiguous', via: 'attendees', candidates: hits };
  }

  const hits = [...new Set(roster.filter((p) => nameMatches(token, p)))];
  if (hits.length === 1) return { name: hits[0], status: 'resolved', via: 'roster', candidates: hits };
  if (hits.length > 1) return { name: null, status: 'ambiguous', via: 'roster', candidates: hits };
  return { name: null, status: 'unknown', via: null, candidates: [] };
}

/** Capitalise a bare token for display ("@anita" -> "Anita"). */
export function displayToken(token) {
  return token.replace(/^@/, '').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}
