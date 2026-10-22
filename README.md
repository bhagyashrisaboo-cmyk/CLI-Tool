# ActionTrack

A command-line tool that reads Markdown meeting notes, tracks the action items in them, and drafts follow-up emails in Gmail for a human to review. It never sends email.

```
actiontrack ingest ./notes              # parse notes, track action items (safe to re-run)
actiontrack list --status overdue       # what's late?
actiontrack done 4663501                # close an item
actiontrack followup "Rahul Mehta"      # create a Gmail draft (never sent)
```

## Setup

You need Node.js 22 or newer.

```bash
cd actiontrack
npm install          # installs commander plus the optional Gmail packages
npm link             # puts `actiontrack` on your PATH (or use: node bin/actiontrack.js)
npm test             # 70 unit + integration tests
```

On Windows, run these in PowerShell or cmd. `npm link` creates an `actiontrack.cmd` shim.

### Address book (for follow-up emails)

Notes name people ("Priya N.", "@anita"), not email addresses. Copy `people.example.json` to `~/.actiontrack/people.json` and fill in real addresses:

```json
{ "people": [ { "name": "Priya Nair", "email": "priya.nair@company.com", "aliases": ["Priya N.", "PN"] } ] }
```

If someone has no email in the address book, their draft is created with an empty "To" line and a warning. ActionTrack never guesses an address.

### Gmail drafts (one-time)

ActionTrack calls the Gmail API directly with the `gmail.compose` scope and only ever uses `users.drafts.create`.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or reuse one) and enable the **Gmail API**.
2. Under **APIs & Services → OAuth consent screen**, configure an internal app (or an external one in testing mode with yourself as a test user).
3. Under **Credentials**, create an **OAuth client ID** of type **Desktop app**, download the JSON, and save it as `~/.actiontrack/credentials.json`.
4. Run `actiontrack auth`. A browser opens for Google sign-in, and the token is saved to `~/.actiontrack/token.json`.

If Gmail isn't available (packages missing, no credentials, expired token, or no network), `followup` doesn't fail silently. It saves the email as an `.eml` file in `~/.actiontrack/outbox/`, prints what went wrong and how to fix it, and exits with code 3.

## Commands

| Command | What it does |
|---|---|
| `ingest <folder> [-r] [--json]` | Parses every `.md` file in the folder (`-r` also reads sub-folders). Re-running it is safe. |
| `list [-o owner] [-s status...] [--due-before date] [-a] [--flagged] [--today date] [--json]` | Shows items. By default it shows open and overdue items, with overdue ones first. |
| `show <id>` | Shows full details for one item, including its history and any review notes. |
| `done <id>` | Marks an item done. An ID prefix of at least 4 characters works. |
| `reopen <id>` | Undoes a `done` made by mistake. |
| `followup <owner> [--dry-run] [--outbox [dir]] [--today date]` | Drafts a follow-up email listing the owner's overdue and open items. |
| `auth` | Signs in to Google once. |

Global options: `--db <file>`, `--people <file>`, `-v` (show each warning), `--debug`, `-q`.

Exit codes: `0` success · `1` error (bad ID, bad input, missing folder) · `2` usage error · `3` Gmail unavailable (the draft was saved to the outbox instead).

### Examples

```bash
actiontrack list --owner priya                     # both Priyas, plus items that just say "Priya"
actiontrack list --owner "Priya Nair" --status overdue
actiontrack list --status open,overdue --due-before 2026-10-31
actiontrack list --status done
actiontrack list --flagged                         # items that need a human decision
actiontrack followup "Sam Okafor" --dry-run        # preview the email
actiontrack followup "Sam Okafor" --outbox         # save an .eml file and skip Gmail
```

## How notes are interpreted

**Meeting metadata.** ActionTrack reads `Date:` and `Attendees:` lines and YAML front matter (`date:`, `attendees: [...]`). These date formats work: `2026-09-02`, `9 September 2026`, `Monday, 14 September 2026` and `September 9, 2026`. Ambiguous values like `14/09/2026` and vague ones like "sometime last week" are reported and treated as unknown.

**What counts as an action item:**
- Checklist items anywhere in the note: `- [ ]`, `* [ ]`, `+ [ ]`, `[x]` and `[X]`, including nested ones.
- `ACTION: …` and `TODO: …` lines.
- Rows of a Markdown table that has an Owner column and an Action/Task column (a Due column is optional).
- Plain bullets inside an "Action items" or "Next steps" section.

**What is ignored on purpose:** items inside block quotes (`> - [ ] …`, someone else's wish), inside fenced code blocks (templates and examples), and inside HTML comments (cut from the agenda). Only `.md` files are read. Empty, binary and non-UTF-8 files are skipped with a reason, and the rest of the folder is still ingested.

**Owners.** The name before "to" ("Priya N. to …", "Anita & Rahul to …", "@anita: …", "Lena (with Priya) to …") is matched against that meeting's attendee list first:
- `Priya N.` → Priya Nair.
- `Priya`, when both Priyas attended → marked **ambiguous** and left unassigned. ActionTrack doesn't guess between them.
- No attendee list → the name is matched against everyone seen across all notes, but only if exactly one person matches. Every such match is flagged.
- `Everyone`, `Team`, `Someone` and `TBD` → kept as group or unassigned, flagged.

**Due dates** are resolved against the meeting date:

| Notes say | Meeting date | Due |
|---|---|---|
| by Friday | Tue 1 Sep | Fri 4 Sep |
| by Friday (said on a Friday) | Fri 2 Oct | Fri 9 Oct |
| by tomorrow / EOD / EOD tomorrow | Mon 21 Sep | 22 Sep / 21 Sep / 22 Sep |
| by end of next week | Thu 3 Sep | Fri 11 Sep |
| by 10 Sep / by Oct 3rd | 2026 | year taken from the meeting |
| by next Tuesday, mid-October, next week | any | **not resolved** (ambiguous), raw text kept, flagged |
| by Friday | meeting date unknown | **not resolved**, flagged |

**Carry-over and duplicates.**
- Every action line is keyed by file name and line text, so re-ingesting the same notes changes nothing.
- When a later meeting repeats a task for the same owner (same or near-identical wording), it is linked to the existing item instead of creating a new one:
  - a new due date reschedules it, and the change is kept in the history;
  - a later `[x]` closes it.
- Linking only happens when the owner is certain. "Rahul" from a meeting with both Rahuls is never merged into Rahul Mehta's item.
- `done` from the CLI is final: ingesting later notes never re-opens the item.

**Status.** Status is calculated each time you list, not stored. `overdue` means not done and due before today. `open` means not done and not overdue, including items with no due date. `done` means closed via the CLI or by a later checked box. Use `--today` to see the list as of another date.

## Data and logs

Everything is stored in `~/.actiontrack/`. Set `ACTIONTRACK_HOME` to use a different folder.

| File | Purpose |
|---|---|
| `store.json` | Tracked items. Written atomically (temp file, then rename). Previous version kept as `store.json.bak`. A lock file stops two runs from writing at once. |
| `people.json` | Address book |
| `config.json` | Optional, e.g. `{ "senderName": "Bhagyashri" }` for the email sign-off |
| `credentials.json`, `token.json` | Gmail OAuth |
| `outbox/` | `.eml` drafts saved when Gmail is unavailable, or when you use `--outbox` |
| `actiontrack.log` | Debug log of every run |

## Project layout

```
bin/actiontrack.js     entry point
src/cli.js             commands, options, output, exit codes
src/parser.js          Markdown -> meeting metadata + raw action lines
src/owners.js          owner extraction and resolution
src/dates.js           meeting-date parsing, due-date resolution
src/ingest.js          dedupe, carry-over linking, ingest report
src/store.js           JSON store: atomic writes, locking, backup
src/query.js           status, filters, done/reopen
src/followup.js        email composition (plain text, MIME)
src/gmail.js           Gmail API draft backend + .eml outbox backend
src/config.js          paths, config, address book validation
tests/unit/            dates, parser, owners, store/query, followup/gmail
tests/integration/     ingest of the real sample notes, end-to-end CLI
tests/fixtures/notes/  the 36-file sample folder
```
