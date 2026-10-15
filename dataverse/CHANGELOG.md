# Dataverse write path: changelog

One line per release from 1.11.5. Earlier releases are described in their pull requests and squash commits
(`git log -- dataverse hooks`).

- **1.11.11 (unreleased)** **Book dates are written as local midnight.** A gift's book date (`msnfp_bookdate`) is a
  date-only column stored in the person's time zone, so a bare date like "2026-10-12" was stored as midnight UTC,
  which is 5 PM the day before in Pacific time, and the app showed every such gift a day early (batch 2026_863,
  10/13/26: 46 gifts; Power BI then disagreed with the app by a day). The plan now reads each date column's
  behaviour and, for a date-only user-local column, writes local midnight on the day the value names (daylight
  saving included: 07:00Z in summer, 08:00Z in winter), before the closed-year check and before the plan is
  signed. Values already at local midnight, real times of day, and true date-only columns are left alone. Tests:
  `engine/test/resolve.test.js` (6, red first: the conversion incl. both 2026 DST change days, update, create,
  midnight-UTC input, untouched values, a date-only column).
- **1.11.10** (2026-10-14, PR #14)
  **The engine checks the approval itself.** `lib/write.js`'s write connection refuses every write that does not
  carry the approval `ticket.take()` hands back for a ticket the guard minted (signed with this machine's plan key);
  the engine passes it in. Before this only the CLI's apply took a ticket, so a script that loaded the write module
  with its own "confirm" could write. The one write that needs none is a NEW Write Log row (doctor sends on a parked
  one). Tests: `engine/test/write_approval.test.js`, `approval.test.js` (every write of an apply and of a batch
  carries a verified approval).
  **The next guard model runs in shadow.** `guard/shellparse.js` reads a shell line (bash/zsh/Git Bash, PowerShell,
  `cmd /c`) into simple commands; `guard/guard_next.js` judges each by its command word, its arguments resolved as
  paths and its redirects, instead of by which words the line holds (every false positive on record came from
  that). guard.js still decides every call, unchanged; it also asks the next model and records any disagreement
  (`engine/lib/shadow.js`: `events/guard_shadow.jsonl`, plus an event per disagreement; the next model newly
  stopping a call opens an item for the review, at most 5 a day per machine). The review gains a "Guard shadow"
  line. Cut-over is 1.11.11, after a clean shadow week. Replayed: all 22 blocks recorded on Dylan's machine and the
  10/9 GIK cases would pass; every self-test case decides the same but 4 named flips. Tests:
  `engine/test/guard_next.test.js`, `shadow.test.js`; 26 of 26 mutants killed (`guard_review/mutate_next.js`).
  **The guard hook fails closed** when it cannot start, crashes or times out (`"onFailure": "block"`, Claude Code
  2.1.295+). **A repeated block** is counted over the last 24 hours, not the calendar day.
  **Read connections** no longer crash
  the Dataverse CLI. On Kayleen's Mac (10/13, CLI 1.0.81 osx-arm64, the newest) the CLI's `mcp` server died
  (SIGABRT, .NET AccessViolationException) whenever two requests were in flight, and Claude Code sends
  tools/list, prompts/list and resources/list together at every connect, so every connection showed "tools
  fetch failed". The launcher now runs the CLI behind `mcp/proxy.js`: prompts/list, resources/list,
  resources/templates/list and ping are answered there (the toolkit uses no prompts or resources; on Windows
  the CLI only answered them with an error), initialize's answer drops those two capabilities, every other
  request goes to the CLI one at a time (parallel reads run one after another), a cancelled request is
  dropped from the queue or, in flight, given 10 s, and the CLI's non-JSON "warn:" stdout lines go to stderr.
  `/dataverse-setup` now says to use `/mcp` Reconnect after a first sign-in (Claude Code caches a failed
  connection for 15 minutes, across restarts). A failed start is recorded once per app per day even when the
  five launchers start together (an exclusive claim file; one start on Kayleen's Mac had filed 15). Tests:
  `engine/test/blocks.test.js` 4b, and `engine/test/mcp_proxy.test.js` (a stand-in CLI that
  dies on overlap, with a control proving it does), and the launcher test's stand-in now answers `auth list`
  (it could never pass on a Mac before). Live on Windows: the connect burst plus two parallel read_query calls
  against the Donor App, all answered. Verified on Kayleen's Mac 10/14 (CLI 1.0.81, Claude Code 2.1.300): the
  burst and two concurrent reads all answered, up 60 s, exit 0, no crash.
  **Batch resolve.** `resolve <number> [<number> ...] <resolution> "<note>"` closes up to 20 items from one app on
  ONE Claude Code prompt ("Close 3 items: D-1082, D-1083, D-1084"); the guard mints a ticket per number and the
  engine takes them all as it starts, as a batch apply does. Every number is looked up first (one that does not
  exist refuses the set, nothing written); an item already closed is skipped and named; each is re-read open just
  before its write. One number behaves exactly as before. Why: on 10/14 sixteen stale items took sixteen prompts,
  and five run side by side lost three to "approval expired". Tests: `engine/test/commands.test.js` (batch
  resolve x6), `approval.test.js` (the prompt text), guard self-test (6 cases: asks with every key; refuses a
  repeat, two apps, more than 20).
- **1.11.9** (2026-10-12) Version check-ins: the review knows who is behind, and a quietly failed automatic
  update is caught (DESIGN.md §12). On 10/12 nobody had 1.11.8 three days after it shipped and nothing said so:
  Claude Code updates a plugin in the background once per session start, fails quietly, and the running session
  keeps the version it loaded. Each read connection now starts a small check (90 s after start, then hourly; a
  lock and skip rules make it about one an hour per machine) that compares three versions: RUNNING (this
  session), INSTALLED (on disk, what the update moves) and MAIN (the plugin.json on main), and records a
  `version check-in` event only when they CHANGE (Dylan: a first-of-day record would always read behind after a
  release). It also sends anything waiting, so a person who only reads now sends their events too. The review
  replaces "Behind on the toolkit" with a Toolkit block graded against the main it fetches: current, restart
  needed, pending, WARN auto-update not pulling (installed behind main after an hour of a session), WARN not
  updated 3+ days after a release, install record missing, no check-in. A prompt hook tells the person's
  Claude once when the session runs an older toolkit than the one installed (quit and reopen), and once a day
  when the automatic update is stuck (offer to update; on their yes Claude runs the two `claude plugin` lines,
  else gives the person the `!` lines). `doctor` gains a Toolkit line. Knobs in `toolkit.json` (ruled 10/12).
  Tests: `engine/test/checkin.test.js`, `nudge.test.js`, and the review, launcher and health tests.
- **1.11.8** (2026-10-09) `query`: a read-only bulk read for the person's Claude (Dylan: "especially daian
  will need to do reads over hundreds of rows"). `query <app> <table set> --select ... --filter ... [--orderby]
  [--expand] [--max N] [--csv] [--name]` reads every page (5,000 rows a page, up to --max, default 50,000)
  through the same GET-only read connection, adds choice and lookup display text as `<column>@label`, and writes
  JSON or CSV to `~/sbrm-reads/`; it prints only the count, the columns and the path. Refused if that folder is
  inside git or OneDrive (a read can hold Recovery client records); files older than 7 days are deleted on every
  query. A bad query is a refusal with Dataverse's message and, like `check`, not a review item. The skill tells
  Claude to use it, not the read tool, past a few dozen rows. Live test: 6,000 Donor App contacts over two pages,
  all unique. Tests: `engine/test/query.test.js`.
- **1.11.7** (2026-10-09) Guard blocks are recorded and can be reported automatically. Every block is kept
  on the machine (the call as the guard saw it, the rule, the folder, the mode, the toolkit version) and sent
  to Dylan's review as a routine count by rule. The block message gives a block id and the
  `report --blocked <id> "<sentence>"` line, which the person's Claude runs on its own when the call was
  legitimate; the report opens an item with the block attached and Claude's sentence labelled as Claude's.
  A person's own `report` now carries the last day's blocks too. Every event names the toolkit version (read
  from plugin.json; the engine's version constant had not moved since 1.11.1). doctor's own guard probes are
  not recorded. Recorded on their own, with nobody having to notice: one rule blocking a machine three times
  in a day with no report from Claude (opens an item); the guard unable to run (the fallback leaves a line,
  the next engine run opens one item); an app's read connection failing to start (once per app per day);
  approvals Claude Code asked for that never ran (counted). The review lists anyone behind on the toolkit.
  Tests: `engine/test/blocks.test.js`. Also: a job's `intent.fields` may name a lookup by its column
  (`msnfp_appealid`) where the row sets `msnfp_AppealId@odata.bind`, including a lookup with a target
  (`msnfp_CustomerId_contact@odata.bind`); three of the first five intent refusals were only that (D-1026,
  D-1037, D-1050). Any other difference is still refused. Test: `engine/test/contract.test.js`. And an
  approval now lasts ten minutes, not three (ruled 10/9: eight approvals in two days came after three minutes).
- **1.11.6** (2026-10-09) Guard: a home folder set for one run no longer counts as moving the engine's store
  unless it is about Dataverse. In a code file it is refused only when the file names Dataverse (the engine,
  the store, its variables, the plugin, the CRM host) or runs Claude Code itself; a Fly.io entrypoint dropping
  privileges through setpriv and env was refused before (a folder named claude, `/home/claude`, is not a
  Claude run). In a shell it is still refused on any line, and quotes now read as spaces, so it is also caught
  inside `bash -c` / `bash -lc` strings and as a quoted argument to env or sudo, which slipped through before.
  The engine-store variables and persistent environment changes are unchanged. Tests: `engine/test/guard_false_positives.test.js`.
- **1.11.5** (2026-10-09) Guard: two text heuristics now judge what a command does instead of matching words.
  The keystroke/click injection rule matches only a call that sends input (a send-keys or Win32 input call
  with its parenthesis, an input library's action call, an input tool given an action, a hotkey or AU3
  script run); a lookup, an install, a grep and a non-executable file (.md, .txt, .json) are no longer
  read as injection. The home-folder rule blocks only a recursive command whose own target is the home
  folder, a folder above it or a drive root (a Python `except ... as e:` is no longer a drive, nor `.find(`
  the find command). The plugin-files rule counts a redirect only when it writes into the plugin, so a
  sed or one-liner that merely names the plugin path and writes elsewhere passes. A settings write is refused
  for a prompt-answering hook only when it adds or changes one (keeping one the person installed, such as
  iTerm2's status reporter, passes; an Edit changing that hook's command or a \u-escaped key is now caught). Block messages for the
  injection and home rules now name the rule and the matched token.
  Tests: `engine/test/guard_false_positives.test.js`.
