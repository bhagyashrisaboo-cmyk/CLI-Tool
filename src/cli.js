/**
 * Command-line interface.
 *
 * `run(argv, io)` is the testable entry point: it never calls process.exit
 * and writes through the supplied streams; bin/actiontrack.js wires it to the
 * real process.
 */

import { Command, CommanderError, Option } from 'commander';
import { loadConfig, loadAddressBook, homeDir } from './config.js';
import { Store } from './store.js';
import { ingestFolder } from './ingest.js';
import { filterItems, markDone, reopen, getItem, ownerLabel, STATUSES, effectiveStatus } from './query.js';
import { resolveFollowupOwner, collectItems, composeFollowup, toMime } from './followup.js';
import { GmailApiBackend, OutboxBackend } from './gmail.js';
import { parseCliDate, todayISO, formatDate } from './dates.js';
import { ActionTrackError, GmailUnavailableError } from './errors.js';
import { logger } from './logger.js';

const VERSION = '1.0.0';

function truncate(s, n) {
  if (s.length <= n) return s.padEnd(n);
  return `${s.slice(0, Math.max(0, n - 3))}...`;
}

function renderTable(items, width) {
  const cols = [
    { h: 'ID', w: 7, v: (i) => i.id.slice(0, 7) },
    { h: '!', w: 1, v: (i) => (i.flags.length ? '!' : ' ') },
    { h: 'STATUS', w: 7, v: (i) => i.effectiveStatus },
    { h: 'DUE', w: 10, v: (i) => i.dueDate || (i.dueRaw ? '?' : '-') },
    { h: 'OWNER', w: 18, v: (i) => ownerLabel(i) },
    { h: 'TASK', w: 0, v: (i) => i.task },
    { h: 'SOURCE', w: 24, v: (i) => i.lastSeenFile || i.sourceFile },
  ];
  const fixed = cols.reduce((n, c) => n + c.w + 2, 0);
  cols[5].w = Math.max(20, width - fixed);
  const line = (vals) => vals.map((v, idx) => truncate(String(v), cols[idx].w)).join('  ').trimEnd();
  const out = [line(cols.map((c) => c.h))];
  for (const item of items) out.push(line(cols.map((c) => c.v(item))));
  return out.join('\n');
}

function parseStatuses(values) {
  const list = (values || []).flatMap((v) => v.split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const s of list) {
    if (!STATUSES.includes(s)) throw new ActionTrackError(`Invalid --status "${s}". Use one of: ${STATUSES.join(', ')}.`);
  }
  return list;
}

function resolveToday(opt, now) {
  if (!opt) return todayISO(now);
  const d = parseCliDate(opt, todayISO(now));
  if (!d) throw new ActionTrackError(`Invalid --today "${opt}". Use YYYY-MM-DD.`);
  return d;
}

/**
 * @param {string[]} argv arguments after the program name
 * @param {{stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, env?: object, now?: Date, gmailClient?: object, columns?: number}} io
 * @returns {Promise<number>} exit code
 */
export async function run(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const now = io.now || new Date();
  const out = (s = '') => stdout.write(`${s}\n`);
  const columns = io.columns || stdout.columns || 120;
  let exitCode = 0;

  const program = new Command();
  program
    .name('actiontrack')
    .description('Track action items from Markdown meeting notes and draft follow-up emails for review.')
    .version(VERSION)
    .option('--db <file>', 'store file (default: $ACTIONTRACK_HOME/store.json)')
    .option('--people <file>', 'address book JSON (default: $ACTIONTRACK_HOME/people.json)')
    .option('-v, --verbose', 'show progress and per-line warnings')
    .option('--debug', 'show debug output')
    .option('-q, --quiet', 'only show errors')
    .exitOverride()
    .configureOutput({ writeOut: (s) => stdout.write(s), writeErr: (s) => stderr.write(s) })
    .showHelpAfterError('(run "actiontrack --help" for usage)')
    .addHelpText('after', `
Examples:
  $ actiontrack ingest ./notes
  $ actiontrack list --owner Priya --status overdue
  $ actiontrack list --due-before 2026-10-31
  $ actiontrack done 3f9a1c2
  $ actiontrack followup "Rahul Mehta" --dry-run
  $ actiontrack followup "Rahul Mehta"          # creates a Gmail draft (never sends)

Data lives in ${homeDir(env)} (set ACTIONTRACK_HOME to change).`);

  const ctx = () => {
    const g = program.opts();
    const level = g.quiet ? 'error' : g.debug ? 'debug' : g.verbose ? 'info' : 'warn';
    const cfg = loadConfig({ home: homeDir(env), dbOverride: g.db || null, env });
    if (g.people) cfg.peoplePath = g.people;
    logger.configure({ level, filePath: cfg.logPath, stream: stderr });
    logger.debug(`actiontrack ${argv.join(' ')}`);
    return { cfg, store: Store.open(cfg.storePath), addressBook: loadAddressBook(cfg.peoplePath) };
  };

  // ------------------------------------------------------------- ingest
  program
    .command('ingest')
    .description('Parse every .md note in a folder and track its action items (safe to re-run).')
    .argument('<folder>', 'folder containing Markdown meeting notes')
    .option('-r, --recursive', 'also read sub-folders')
    .option('--json', 'print the ingest report as JSON')
    .action((folder, opts) => {
      const { store, addressBook } = ctx();
      const report = ingestFolder(store, folder, { recursive: opts.recursive, addressBook, now });
      if (opts.json) return out(JSON.stringify(report, null, 2));

      const t = report.totals;
      out(`Ingested ${report.files.length} note(s) from ${folder}`);
      for (const f of report.files) {
        if (f.status === 'skipped') {
          out(`  SKIP  ${f.file}: ${f.reason}`);
          continue;
        }
        const parts = [`${f.new} new`];
        if (f.linked) parts.push(`${f.linked} carried over`);
        if (f.completed) parts.push(`${f.completed} closed`);
        if (f.rescheduled) parts.push(`${f.rescheduled} rescheduled`);
        if (f.duplicates) parts.push(`${f.duplicates} already tracked`);
        const warn = f.warnings.length ? `  (${f.warnings.length} warning${f.warnings.length === 1 ? '' : 's'})` : '';
        out(`  OK    ${f.file}: ${parts.join(', ')}${warn}`);
        if (program.opts().verbose) for (const w of f.warnings) out(`          - ${w}`);
      }
      if (report.ignored.length) out(`  Ignored non-Markdown files: ${report.ignored.join(', ')}`);
      out('');
      out(`Summary: ${t.new} new, ${t.linked} carried over, ${t.completed} closed by later notes, ` +
        `${t.rescheduled} rescheduled, ${t.duplicates} already tracked, ${t.skipped} file(s) skipped.`);
      if (t.flagged) out(`${t.flagged} open item(s) need review (unclear owner or date): actiontrack list --flagged`);
      if (!program.opts().verbose && report.files.some((f) => f.warnings.length)) out('Run with -v to see every warning.');
    });

  // --------------------------------------------------------------- list
  program
    .command('list')
    .description('Show tracked action items (open and overdue by default).')
    .option('-o, --owner <name>', 'filter by owner (full or first name, case-insensitive)')
    .addOption(new Option('-s, --status <status...>', 'filter by status: open, done, overdue (repeatable or comma-separated)'))
    .option('--due-before <date>', 'only items due before this date (YYYY-MM-DD, "today", "tomorrow")')
    .option('-a, --all', 'include done items')
    .option('--flagged', 'only items that need review (ambiguous owner or date)')
    .option('--today <date>', 'treat this date as today (YYYY-MM-DD) when computing overdue')
    .option('--json', 'output JSON')
    .action((opts) => {
      const { store } = ctx();
      const today = resolveToday(opts.today, now);
      let statuses = parseStatuses(opts.status);
      if (opts.all && !statuses.length) statuses = [...STATUSES];
      let dueBefore = null;
      if (opts.dueBefore) {
        dueBefore = parseCliDate(opts.dueBefore, today);
        if (!dueBefore) throw new ActionTrackError(`Invalid --due-before "${opts.dueBefore}". Use YYYY-MM-DD.`);
      }
      const items = filterItems(store.allItems(), { owner: opts.owner, statuses, dueBefore, flagged: opts.flagged, today });
      if (opts.json) return out(JSON.stringify(items, null, 2));
      if (!store.allItems().length) return out('No action items tracked yet. Run "actiontrack ingest <folder>" first.');
      if (!items.length) return out('No matching action items.');
      out(renderTable(items, columns));
      const overdue = items.filter((i) => i.effectiveStatus === 'overdue').length;
      out('');
      out(`${items.length} item(s)${overdue ? `, ${overdue} overdue` : ''} as of ${today}.` +
        (items.some((i) => i.flags.length) ? '  ! = needs review (actiontrack show <id>)' : ''));
    });

  // --------------------------------------------------------------- show
  program
    .command('show')
    .description('Show full details and history of one action item.')
    .argument('<id>', 'item ID (or a unique prefix of at least 4 characters)')
    .option('--today <date>', 'treat this date as today (YYYY-MM-DD)')
    .action((id, opts) => {
      const { store } = ctx();
      const today = resolveToday(opts.today, now);
      const item = getItem(store, id);
      out(`ID:        ${item.id}`);
      out(`Task:      ${item.task}`);
      out(`Owner:     ${ownerLabel(item)}${item.collaborators.length ? `  (with ${item.collaborators.join(', ')})` : ''}`);
      out(`Status:    ${effectiveStatus(item, today)}${item.completedAt ? ` on ${item.completedAt} (${item.completedBy})` : ''}`);
      out(`Due:       ${item.dueDate ? formatDate(item.dueDate) : 'not set'}${item.dueRaw ? `  (notes said "${item.dueRaw}")` : ''}`);
      out(`Meeting:   ${item.meetingTitle || '?'}${item.meetingDate ? `, ${formatDate(item.meetingDate)}` : ' (date unknown)'}`);
      out(`Source:    ${item.sourceFile}:${item.sourceLine}`);
      if (item.flags.length) {
        out('Review:');
        for (const f of item.flags) out(`  - ${f}`);
      }
      out('History:');
      for (const h of item.history) out(`  ${h.at || '????-??-??'}  ${h.event}  (${h.source})`);
    });

  // --------------------------------------------------------------- done
  program
    .command('done')
    .description('Mark an action item as done.')
    .argument('<id>', 'item ID (or a unique prefix of at least 4 characters)')
    .action((id) => {
      const { store } = ctx();
      const { item, changed } = markDone(store, id, { today: todayISO(now), now });
      if (changed) out(`Marked done: [${item.id}] ${ownerLabel(item)} - ${item.task}`);
      else out(`Already done: [${item.id}] ${item.task} (completed ${item.completedAt} via ${item.completedBy}). Nothing changed.`);
    });

  program
    .command('reopen')
    .description('Re-open an item that was marked done by mistake.')
    .argument('<id>', 'item ID (or a unique prefix)')
    .action((id) => {
      const { store } = ctx();
      const { item, changed } = reopen(store, id, { today: todayISO(now), now });
      out(changed ? `Re-opened: [${item.id}] ${item.task}` : `[${item.id}] is not done; nothing changed.`);
    });

  // ----------------------------------------------------------- followup
  program
    .command('followup')
    .description('Draft a follow-up email to an owner about their open and overdue items. Never sends.')
    .argument('<owner>', 'owner name (full name, or first name if unique)')
    .option('--dry-run', 'print the email instead of creating a draft')
    .option('--outbox [dir]', 'save the draft as an .eml file instead of using Gmail')
    .option('--today <date>', 'treat this date as today (YYYY-MM-DD)')
    .action(async (owner, opts) => {
      const { cfg, store, addressBook } = ctx();
      const today = resolveToday(opts.today, now);
      const person = resolveFollowupOwner(store, owner, addressBook);
      const { overdue, open, possible } = collectItems(store, person, today);
      if (!overdue.length && !open.length) {
        out(`${person} has no open action items. No draft created.`);
        return;
      }
      const email = composeFollowup({ person, overdue, open, possible, today, addressBook, senderName: cfg.senderName });
      for (const w of email.warnings) logger.warn(w);
      const mime = toMime(email, { date: now });

      if (opts.dryRun) {
        out(`To: ${email.to ? `${email.toName} <${email.to}>` : '(no recipient - add one in people.json)'}`);
        out(`Subject: ${email.subject}`);
        out('');
        stdout.write(email.body);
        out('');
        out('(dry run - no draft created)');
        return;
      }

      const slug = person;
      if (opts.outbox !== undefined) {
        const dir = typeof opts.outbox === 'string' ? opts.outbox : cfg.outboxDir;
        const r = await new OutboxBackend(dir).createDraft(mime, { slug, now });
        out(`Draft saved for review: ${r.location}`);
        out(`${email.items.length} item(s) for ${person}. Nothing was sent.`);
        return;
      }

      const gmail = new GmailApiBackend({ credentialsPath: cfg.credentialsPath, tokenPath: cfg.tokenPath, interactive: false, gmailClient: io.gmailClient || null });
      try {
        const r = await gmail.createDraft(mime);
        out(`Gmail draft created for ${person} (draft id ${r.id}). Review and send it from ${r.location}`);
        out(`${email.items.length} item(s) included. Nothing was sent.`);
      } catch (err) {
        if (!(err instanceof GmailUnavailableError)) throw err;
        const r = await new OutboxBackend(cfg.outboxDir).createDraft(mime, { slug, now });
        stderr.write(`warning: ${err.message}\n`);
        if (err.hint) stderr.write(`${err.hint}\n`);
        out(`Gmail draft NOT created. The email was saved for review instead: ${r.location}`);
        exitCode = err.exitCode;
      }
    });

  // --------------------------------------------------------------- auth
  program
    .command('auth')
    .description('Sign in to Google once so ActionTrack can create Gmail drafts.')
    .action(async () => {
      const { cfg } = ctx();
      const gmail = new GmailApiBackend({ credentialsPath: cfg.credentialsPath, tokenPath: cfg.tokenPath, interactive: true });
      await gmail.client();
      out(`Gmail authorised. Token saved to ${cfg.tokenPath}.`);
      out('ActionTrack only requests the "compose" permission and only ever creates drafts.');
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode === 0 || err.code === 'commander.helpDisplayed' || err.code === 'commander.version' ? 0 : 2;
    }
    if (err instanceof ActionTrackError) {
      stderr.write(`error: ${err.message}\n`);
      if (err.hint) stderr.write(`${err.hint}\n`);
      logger.debug(err.stack);
      return err.exitCode;
    }
    stderr.write(`unexpected error: ${err.message}\n(see the log in ${homeDir(env)} or re-run with --debug)\n`);
    logger.error(err.stack || String(err));
    return 1;
  }
  return exitCode;
}
