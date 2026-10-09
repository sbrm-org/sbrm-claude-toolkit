# Dataverse write path: changelog

One line per release from 1.11.5. Earlier releases are described in their pull requests and squash commits
(`git log -- dataverse hooks`).

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
