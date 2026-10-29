# Dataverse write path: changelog

One line per release from 1.11.5. Earlier releases are described in their pull requests and squash commits
(`git log -- dataverse hooks`).

- **1.11.26** (2026-10-29) **Inline code (python -c, node -e, a heredoc into python) is read the way the code builds
  its paths, and a write the guard cannot trace ASKS instead of blocking (H-1086, H-1102; inline-code review, ruled
  10/29/26).** The reader now follows a name bound once (`p = '<path>'`, `const a = ..., p = ...`), the home and temp
  folders (`os.path.expanduser('~')`, `os.homedir()`, `Path.home()`, `os.environ['TEMP']`), the path and os modules
  under another name (`p = require('path')`, `import os.path as osp`), and a join whose every part is known
  (`os.path.join`, `path.join`, `Path / 'x'`, `a + b`, an f-string or template), joined as the language joins it (an
  absolute later part wins). Text joined after a known folder (`f"{D}/{k}.txt"`) is judged by that folder; a
  `path.join` with an unknown part is not. A list's `.remove`, a dict's `.copy` and a string's `.replace` are text work,
  not file calls, unless called on a file module or a pathlib object. Opening a file in the store's settings folder,
  even to read, is the signing key whether the path is a literal or joined. **Dylan's ruling ("ask"):** a write whose
  target the guard cannot trace, in code that names the store or the plugin, now gets Claude Code's prompt saying the
  guard could not tell where it writes (before: blocked, C2); a literal or resolved write into a protected place still
  blocks, and an ask never hides a later block. C2 is unchanged for shell lines. **Accepted residual:** a path built
  at run time to get past the guard passes; the reader catches honest mistakes, not evasion. Replays: the 32 review
  cases (every false-positive shape allows, every literal threat blocks, 11 threat shapes that passed now block);
  H-1086's recorded call allows; `replay_shadow.js --allowed` 227 rows, 0 newly stopped. Checks: engine suite 882,
  guard self-test 247, `mutate_1_11_26.js`.
- **1.11.25** (2026-10-28) **A form change that landed is no longer reported "not written" over one label (H-1016).**
  Live 10/18 (plan 20261018-092942-6cd38bd9, HGS guest form): the form saved and published with its new field, but the
  new cell's label read back as the field's display name ("Monthly Income", sent "Income (Monthly)"), and the whole
  formxml compare logged "0 written, 1 not written". Now, when the read-back formxml differs from what was sent ONLY
  in label texts and the save landed (the read-back is not the form as it was before), the outcome is "written" and a
  note names each label that came back different ("Income (Monthly)" came back "Monthly Income"). A plan that changed
  only labels and read back unchanged, or any other difference, is still a read-back mismatch
  (`lib/component.js` `labelOnlyDifference`). Why Dataverse changed that label is not known (untested: it may serve a
  cell's label from the field's stored display name). Checks: component tests 68, `mutate_1_11_25.js` 5 of 5.
- **1.11.24** (2026-10-28) **Three guard false positives fixed, one older hole closed, and the shadow lines say which
  model decided.** (1) **H-1081** (a Todoist close blocked as "the Dataverse CLI with the unknown option -"): the old
  whole-text CLI rule still ran before the parse, read "Memory System (" in the quoted note as a shell-out call, then
  scanned the note for the CLI word. The CLI is now judged per parsed command: a script run on data (`python
  todoist_api.py ...`) and a pure printer or searcher (echo, printf, grep, rg, Write-Output, Select-String) hand their
  words to no shell, so those are data; a shell handed a string, inline code, `$( )`, a heredoc into a shell, awk, sed
  and git keep the old read, and a line the parser cannot read keeps the whole-text rule (`guard_next.js` `cliRuns`).
  (2) **H-1093 / H-1095** (a `sed -i '18s/a/b/'` on a skill file blocked as a prompt hook): the skill-file sed check
  now reads a numeric line address, N or N,M, before an s///; a pattern, negated, stepped or `$` address still fails
  closed (`sedSubsOnly`). (3) **D-1388** (a name-only find of home blocked once it carried `-not -path`): the find
  expression is now read as logic. It passes when every name it can print has passed a `-name`/`-iname` test that
  cannot match the key's file name, so an ANDed exclusion (`-not -path`, `! -name`, `-prune` with an explicit `-print`)
  passes. The same read closes an older hole: an `-o` branch with no name test (`-iname "*.md" -o -type f`) passed and
  listed everything; it is now a home sweep. Any action but `-print`/`-print0`, an unknown word or an unbalanced
  parenthesis fails closed (`findListsNamesOnly`). (4) **Shadow wording**: since the 1.11.14 cut-over the NEXT model
  decides and the old one watches, but a shadow event still said "Old (decided)" and the review's line read backwards.
  The detail now reads "Next (decided)" / "Old (watching only)", the headline adds "(ran; only the old model would
  have stopped it)" or "(stopped; the old model would have let it run)", and the review line reads "N ran that the old
  model would have stopped, M stopped that the old model would have allowed". The "[old x / next y]" prefix the review
  counts by is unchanged (`lib/shadow.js`, `lib/review.js`). Checks: suite 878 (877 + 1 skip), self-test 247, mutation
  pass 18 of 18, the saved H-1081/H-1093/D-1388 calls allow on staging, and 210 of 210 recorded calls the deciding
  model allowed still allow.
- **1.11.23** (2026-10-25) **A new view no longer reads back as a "mismatch"; a new table's first column gets a short
  retry; the guard's no-node fallback holds without `grep` and sees through escaped names.** (1) **View create**
  (live 10/23, plan 20261023-165142-37da2ab6): saving a NEW view, Dataverse adds `savedqueryid="<its id>"` to the root
  `<fetch>`, so a correct view came back "applied with problems: read-back mismatch (fetchxml)". The read-back now drops
  that one attribute when it names THIS view (any other id still differs); the restore-point hash is unchanged, so
  plans made on 1.11.20 still match (`lib/component.js` `readBackField`). (2) **First column after a new table** (live
  10/23, plan 20261023-163957-2ef0f3aa): the new table answered a read, yet its first column POST failed "An unexpected
  error occurred."; a re-plan finished it. For a create (a column, key or lookup) on a table the SAME apply created, that
  error is now retried, 10 s apart up to 6 times; before each send a strong re-read must CONFIRM it is absent ("not
  found"): if it is there it is recorded as landed, and if the re-read fails or finds it there but different, nothing
  is sent again and the step says to make a new plan. A retry that times out gets the usual 2-minute timeout check,
  and the last retry is re-read too. Anywhere else the error still fails the step (`lib/schema.js` `createdHere`,
  `landedOrAbsent`). (3) **JOBS.md** says what a view's `other` section holds (the `jump` column,
  `select`, `icon`, `preview`, the row's name/id). (4) **The guard's no-node fallback** (review findings F1 + F2 of
  1.11.20, both older than it): its Dataverse match ran through `grep`, so a machine with neither node nor grep allowed
  every call; and it matched the raw JSON, so a tool name spelled with `\u` escapes slipped past. It now matches with
  bash builtins, on the input as sent and with `\u00XX` decoded; classification still reads the raw input, and a tool
  name that is MCP only once decoded is ALSO held to the MCP rule, so it can only block more than before.
- **1.11.22** (2026-10-25) **perfect-wiki skill retired.** PerfectWiki was cancelled 10/14/26; BookStack (the bookstack skill) is the wiki. The old skill still answered "the wiki" and could route a request to a dead service. No Dataverse change.

- **1.11.21** (2026-10-25) **Skills say what actually landed.** The dataverse skill now quotes the engine's outcome line and every `!!` row as printed, and stops further applies in that session until a `!!` is reported (Dylan's ruling). documenso checks stored recipients against the request's source before distribute and holds the send on a mismatch; sbrm-notion reads a write back without the connector's cached fetch and, for a correction, searches for the old value; bookstack re-reads a page after create/update and names anything the filter stripped. Skill text only; engine unchanged. From the Skill Read-Back Audit (Dylan's workspace).

- **1.11.20** (2026-10-25) **The guard hook costs about half as much on every tool call.** The guard runs before every
  Bash, PowerShell, Write, Edit, Read, Grep and MCP call. Its launcher (`guard/run.sh`) started helper processes
  (`cat`, `dirname`, two `$(...)` subshells to find node, a pipe), each ~50-100 ms on Windows, so it took 400-650 ms
  around a guard that decides in ~100 ms. The happy path is now bash builtins + node only: the input is read with
  `read`, the folder taken from the script's own path, node found with `hash`, and the input handed over as a
  here-string. Measured on Windows: ~400 ms -> ~200 ms per call. The guard itself, its decisions and the no-node
  fallback are unchanged (macOS's bash 3.2 has no `BASH_CMDS`, so it keeps the old node search). Evidence: 401 real
  tool calls from 30 days of transcripts (200 naming Dataverse or the toolkit) gave the same exit code, output and
  message through the old and new launcher; two new launcher tests (with PATH cut to node's folder a raw write still
  blocks, where the old launcher let it through; a 300 KB Write arrives whole).
- **1.11.19** (2026-10-23) **A Write Log entry over 1 MB lands; an expired approval says when its ticket was made;
  two guard false positives fixed.** (1) **The Write Log row is capped** (D-1174, 10/17: an import's 1,314,762-character
  entry was refused by Dataverse's 1,048,576 limit, parked, and retried unchanged forever). Over 1,000,000 characters the
  row drops the per-row lines and keeps in its JSON only what undo reads (each row's name, id, outcome and note, with the
  changes for an update or the after-image for a create), so undo still works from it; still over, each NEW value over
  2,000 characters is kept as its SHA-256 (undo writes back only old values, and the hash still shows a later change);
  when even that does not fit, the entry is **split across Write Log rows** (ruled 10/23, Dylan: "Split into rows"):
  the row for the plan id holds the heading and part 1, rows `<plan id>-p2` to `-pN` the rest (outcome `log part`, no
  counts, so the review does not count them as writes), parts written before the first row so undo never meets a half
  entry, and undo joins them, refusing with the part named if one is missing or from another plan. Past 20 parts
  (about 18 MB) it keeps ids and outcomes and undo points at the writer's local log, which always keeps everything;
  past that, the counts alone, always under the limit. The
  plan's own fields (reason, headline, name) are clipped in every step, so they never push out what undo needs. A
  row parked by an earlier version is trimmed the same way when it is retried, so the 10/17 row lands at the next Donor
  App apply or health check (`lib/log.js` `fitForRow`, `lib/revert.js`). (2) **"Approval expired" carries the ticket's
  times** (three cases 10/22-10/23 refused seconds after the ask; the engine deletes the ticket, so nothing was left to
  read): the refusal now says when the ticket was made, when it was checked and how far apart, never the signature
  (`lib/ticket.js`, `dataverse-write.js`). (3) **Guard false positives** (`guard/guard_next.js`): F-1076, a chained string
  `.replace("|", "/").replace(...)` in inline Python was read as renaming the drive root (the receiver rule took the
  ")" closing the first call's arguments, or a call's own "(", for one wrapping a literal; a wrapped literal,
  Path("/").replace, is still judged), and, found by the review, a Path rename or replace now has its DESTINATION
  judged too (only the source was, so a rename INTO the store passed this check; a receiver is a path only inside
  `Path(...)`, a bare or parenthesized string literal is text, and a `.replace(` argument counts when the receiver is
  `Path(...)`, `os` or `shutil`, or an unknown object in pathlib code), and a path passed BY KEYWORD
  (`os.replace(src, dst=...)`, `Path(x).replace(target=...)`, `shutil.move(dst=...)`, `open(file=..., mode="w")`,
  `os.makedirs(name=...)`) is judged like a positional one, by role, so a copy's source is read, not written, and an
  `open`'s write mode is read from the call itself, not a 300-character window, a mode held in a variable counts as a
  possible write, and a raw-string mode (`r'r'`) is a literal (keyword paths and variable modes were not judged before
  this release either); **also found by the review, a real hole since
  1.11.14**: the deciding guard folded every variable name to lowercase, but Bash's names are case-sensitive, so
  `A=/safe; ... > "$a<a path into the store>"` was judged as /safe while Bash wrote into the store. POSIX names are now
  exact (assignments, reads and the built-in HOME, TMP, PWD names); PowerShell and cmd stay case-blind; and an `unset`
  variable is unknown again, never its earlier value (`A=/safe; unset A; ... > "$A<store path>"` passed). D-1273, a redirect under
  CLAUDE_JOB_DIR, the job folder Claude Code gives a background session, was an unknown target on a line naming the
  plugin: that one name, spelled exactly, now resolves from the hook's own environment unless the line sets it (any
  other variable stays unknown). Tests in `revert.test.js`, `ticket.test.js`, `approval.test.js`, `guard_next.test.js`;
  the fake now enforces Dataverse's entry limit. Reviewed blind by Codex (C1, a round per fix). Suite 854 (853 + 1
  skip), self-test 247, mutation pass 50 of 50 (`mutate_1_11_19.js` in the project folder).
- **1.11.18** (2026-10-23) **A record write is no longer called failed on an answer it did not check.** (1) **A
  timed-out write is re-read** (D-1240, Daian 10/21: a gift's update hit the CLI's 120 s client timeout and was logged
  not written, but the change was on the record). The engine now never sends a timed-out request again; it re-reads
  the row's planned columns every 10 s for up to 2 minutes: all at the plan's values = written, with a note in the log;
  otherwise failed, saying it may still land and to read the record before running it again (or, when the last re-read
  could not be made, that whether it landed is not known). A write that WENT THROUGH but whose read-back timed out is
  judged by its re-read (a mismatch stays a mismatch), and one never read back is `read-back failed`, not failed (the
  log's and the console's totals say how many went through unverified). The two minutes are wall time too: after the wait that crosses them comes one final re-read, then no more. A
  create whose id came back keeps it whatever fails after; a timed-out create with no id fails with "check before
  running it again" (a second create would make a duplicate). (2) **A
  moved version stamp is re-checked** (Daian 10/13 and 10/15: a donor's address update refused as
  "the record changed between the check and the write" right after her gift moved the giving totals, with no audited
  change). On that refusal the row is re-checked as apply's first step does: if the planned columns still equal the
  plan's before-image it is written ONCE more with the fresh stamp, with a note; if they moved, the refusal stands and
  now says what moved. Record rows only (`lib/apply.js` `writeOne`); app changes, settings and merges are unchanged. The
  timeout test moved to `lib/cli.js` `isTimeout`, shared with the schema engine. Tests in `apply.test.js` (the fake's
  new `afterWrite` hook throws after a write lands). Reviewed blind by a second model family (Codex, 10/23, a round per
  fix); its eight findings on the new code are fixed above. Suite 836 (835 + 1 skip), self-test 247, mutation pass 17
  of 17 (`mutate_1_11_18.js` in the project folder).
- **1.11.17** (2026-10-23) **The persistent environment-variable rule, completed after an independent audit.** The
  deny list behind the rule (a session may store a lasting environment variable only under a harmless literal name)
  was the author's reasoning only. A non-Claude reviewer (Codex) audited it 10/22 for coverage; every one of its 22
  claims was then replayed through the real verdicts, and all 22 were allowed by 1.11.16. Fixed: (1) **names** that make
  a later Python, Git, zsh, OpenSSL, Perl or Ruby run load code or read config from elsewhere are now on the list
  (the Python module-path and start-up names, every Git variable, the askpass helper, the zsh start-up folder, the
  OpenSSL config). Dylan 10/22: code-loading names only, so a lasting text-encoding setting for Python stays allowed.
  (2) **Spellings**: the PowerShell short aliases for setting and creating an item on the environment drive, that drive
  written as its provider path, a backtick inside the command name, and spaces or quotes round the .NET method were
  all missed, because the check read the raw line, not the parsed command; the command's real target variable is now
  judged (`persistedName` in `guard/guard_next.js`). (3) **Start-up files**: a read-only declaration and an item
  created on the environment drive inside a start-up file are now read, and fish's per-snippet folder counts as a
  start-up file. `guard/guard.js` (`ENV_DENY`, the .NET form) and `guard/guard_next.js`; 25 block and 9 pass cases in
  `guard_next.test.js`, the audit kept with its replay script in the project's `guard_review/env_probe_2026-10-22`.
  Suite 822 (821 + 1 skip), self-test 247, mutation pass 16 of 16. Known, unchanged: writing the variable straight into
  the user's Environment registry key, and system-wide start-up files (both need rights a session does not have).
- **1.11.16** (2026-10-21) **A token request is no longer read as a Dataverse write.** Writing a read-only Dataverse
  client and an Entra token helper was refused as "a raw writing HTTP call at Dataverse" (R-1080, R-1082): their only
  POST is the client-credentials token request, whose URL sits in a constant (`LOGIN = "https://login.microsoftonline.com/..."`,
  then `.post(LOGIN.format(...))`). The rule read a write's target only from a URL written on its line, so it fell
  back to "a Dataverse address anywhere in the text + a write anywhere". Now each write line is judged on its own: its
  target from a URL on the line, else from the URL its named constant is assigned in the same text; a line aimed at
  another service does not count, and a line whose target still cannot be read keeps the fallback. That also closes a
  hole: before, any write aimed elsewhere switched the fallback off for the whole text, so a Graph POST let a Dataverse
  PATCH through a run-time variable pass; it now blocks. `guard/guard.js` (`targetsDataverse`, `WRITE_TARGET_ID`,
  `assignedUrls`), shared by both models; tests in `guard_next.test.js` (the two refused files must pass; a constant
  holding a Dataverse URL, a run-time PATCH beside the token POST, and the closed hole must block). Suite 789 (788 +
  1 skip), self-test 247, mutation pass 33 of 33.
- **1.11.15** (2026-10-21) **The browser is no longer frozen by another session's approval.** While an approval
  waited anywhere on the machine, every screen tool was blocked in every session, the Chrome tool included, and for up
  to ten minutes after a No (the ticket's life). 1.11.14 let screenshots and zoom through; the same morning a wait and
  clicks in Paychex and Azure tabs were still stopped by another session's prompt (R-1043, R-1044, R-1047, R-1048).
  Ruled 10/21 (Dylan: "we need to fix that chrome block because its really annoying"): the Chrome tool drives browser
  tabs only and cannot reach the terminal where Claude Code asks, so while an approval waits it is free, except a call
  that names Claude's own site (claude.ai, claude.com), where a Remote Control or claude.ai/code approval could be
  shown. Desktop mouse and keyboard tools still block while an approval waits. Residual, written down: a click carries
  only a tab number, so a tab already open on Claude's site is not seen. `guard/guard_next.js` (`browserTool`,
  `namesClaudeSite`); test in `guard_next.test.js` (every browser action passes while waiting; Claude's site blocks by
  navigate, a new tab, page script or typed text; a look-alike domain passes; desktop tools block).
- **1.11.14** (2026-10-21) **The guard cut-over: the redesigned guard now decides, and a record's owner can be
  set.** (1) `guard/guard.js`'s hook entry now asks `guard/guard_next.js` (the parsed-shell model, in shadow since
  1.11.10) for every decision; the old verdict watches for two weeks and every disagreement is recorded the other way
  round (`old` = the watcher, `next` = the decision made), so a regression shows in the morning review before anyone
  reports it. A crash in the next model fails closed. Its asks (adding a plugin, fork 5) reach Claude Code as a
  question with no approval ticket. Rollback is a release restoring the 1.11.13 entry lines. The self-test still runs
  the old verdict as the parity reference. (2) Four fixes the shadow found before the cut-over, each a call the old
  guard allowed and the next model would have stopped: a string literal in code counts as a CLI call only when it is
  command-shaped, the CLI word then a verb the CLI has (auth, org/env, api, erp, data, skill, mcp, install) or a flag
  (H-1028, a docstring opening with the product name; a label naming an app, 10/21); a string's `.replace(old, new)`
  is not a file move (D-1175, read as moving the drive root; method calls stay with the receiver rule, so
  `os.replace` into the store still blocks); a `sed -i` on a skill file passes when its script is nothing but plain
  `s///` commands that name no hook, permission or request, re-insert nothing (`&`, `\1`) and decode no escape
  (S-1005; any other sed, `-e`, `r`, `y`, an `e` or `w` flag, still fails closed); and while an approval waits, the
  browser tool may take a screenshot or zoom (F-1009, F-1011: a page screenshot was stopped because an apply was
  waiting in another session), while a click, key, typing, scrolling or any other screen tool still blocks. D-1184 (a
  names-only listing of the store's settings folder) stays blocked by ruling (Dylan 10/21: "Script it, rule
  stands"); the post-suite store check that needed it is now `run_suite.js` in the dev folder. (3) **An Owner lookup
  can be set** (R-1035, 10/20: every owner assignment was refused, both ways). `ownerid` is one navigation property
  onto the abstract owner table, which cannot be read or pointed at; the plan now takes `/systemusers(<id>)` or
  `/teams(<id>)`, checks the target exists in that table, and refuses a disabled user at plan time
  (`lib/resolve.js`, `lib/meta.js` `OWNER_SETS`). Revert finds which table the old owner is in (`ownerSetOf`), since
  the before image keeps only the id. Live read-only plans on Recovery 10/21 (nothing applied): a client's Case
  Manager to the SBRM Recovery team planned clean; a disabled user was refused with the new reason. Tests:
  `guard_next.test.js` +21 (the shadow's new stops verbatim, each beside the real thing its rule exists for),
  `shadow.test.js` (the hook decides with the next model, asks, the approval layer, a crash in the watcher),
  `resolve.test.js` +2 and `revert.test.js` +1 on an Owner column added to the fake; `nudge.test.js` now spawns Git
  Bash on Windows (a bare `bash` from PowerShell is the WSL stub). Suite 783 (782 + 1 skip), self-test 247; the
  mutation pass `guard_review/mutate_1_11_14.js` kills 27 of 27, and the 1.11.10 pass still 26 of 26; replay of every
  block recorded on Dylan's machine: 51 allow, the 3 real blocks still blocked.
- **1.11.13** (2026-10-19) **A new job kind, `role`: give or take a person's security role** (Dylan 10/17/26, "can
  we add role changes to toolkit?"). Admin only. Each row names ONE person by work email, ONE role by name, and add or
  remove; up to 25 rows a job. The plan picks the role's copy in the person's own business unit (every role has one
  per unit and a person can hold only theirs), reads their direct roles and the teams they are in (owner and Entra
  teams; access teams never give roles), and for every removal says either "Access continues through the team X"
  or "This ends their access", which is a new warning kind, **Ends access** (`lib/severity.js` `ends`; more of it at
  apply than at plan refuses the apply, like any warning that grew). Rulings 10/19/26: System Administrator and
  System Customizer are never given here (an admin gives them by hand) and only SBRM's own (unmanaged) roles are
  given; any role may be taken away except System Administrator from the last enabled person who holds it (app
  users do not count). Always refused: your own roles, and adding a role to a disabled account (taking one from a
  disabled account is tidy-up and allowed). A row that cannot go is left out with its reason. Apply re-reads every
  person, role copy and grant, then makes one association call per row (`lib/write.js` `grantRole` / `revokeRole`,
  a fixed `$ref` path on two GUIDs), each read back; revert is the opposite change while nothing has moved.
  Claude Code's prompt names each person, the role, and add or remove. A records job on `systemusers`, `roles` or
  `teams` now names the new kind. Why: the 10/17 direct-grants review found role grants changeable only in the
  Power Platform admin center, outside the Write Log. Tests: `engine/test/role.test.js` (22, red first) on
  `fake_role.js` (shapes read live from HGS and Recovery 10/19), `cli_app.test.js` (3), `write.test.js` (1); suite
  755 (754 + 1 skip); the mutation pass `guard_review/mutate_role.js` kills 33 of 33. Live read-only plans on HGS
  and Recovery 10/19 (nothing applied): the Men's unit copy picked for a Recovery user; a direct grant with no team
  behind it flagged Ends access; a Microsoft role and the planner's own row refused.
- **1.11.12** (2026-10-18, PR #16) **A text tool's `-d` no longer reads as a curl body flag.** When a request's URL sat in a
  variable, the HTTP rule blocked if a Dataverse host and any write-shaped flag appeared anywhere in the shell text,
  and the combined curl-flag spelling (`-sd`) also matched `uniq -d`, `cut -d` and `date -d` (D-1152, D-1154, Daian
  10/15: GETs of `file_download`'s signed URLs, then a duplicate check with `uniq -D`; old and next guard both
  blocked). Shell text only: a segment whose command is a plain text or file tool (uniq, cut, sort, date, grep, ls,
  ...) is set aside before the check, unless it holds `$(`, backticks, `<(`, `-exec` or `<<`. Tools that run commands
  or carry text into the next one (awk, sed, find, xargs, echo, cat, printf, tee, base64) are not set aside, the host
  is still looked for in the whole text, and code files being written keep the strict check. Tests:
  `engine/test/guard_false_positives.test.js` (4 must-pass, red first; 9 must-block), which guard_next.test.js
  reuses; a mutation pass (`guard_review/mutate_texttools.js`) kills 4 of 5 mutants (the survivor, code files kept
  strict, is defense in depth with no realistic input that differs).
  **The dataverse skill now says one apply at a time** (step 5). Two applies started together queue two prompts
  and the later approval expires: Dylan's five side-by-side resolves 10/14 lost three, and Daian's two applies
  started 1 ms apart 10/15 both expired (D-1160, D-1161; she re-ran each alone and both applied). The rule lived
  only in Dylan's project notes, out of reach of a staff member's Claude. Skill text only, no engine change.
  **A closed-year gift may have its pledge link fixed** (Dylan 10/16/26). Pledges are not booked in QBO, so which
  record carries a pledge link changes no books. A closed-year gift or soft credit may have ONLY a lookup listed in
  envs.json's new `closed_year_links` (donorapp + fedev: `msnfp_DonorCommitmentId`, the pledge) set or cleared;
  anything else in the same row is still refused, and the plan shows a "only its pledge link changes" note. Apply
  honours it only from the signed plan, so a plan made before this release gets no exception. Case: PLDG-00002067,
  whose FY25 payment TRN-00291885 is linked on the gift, not on the soft credit the pledge counts. Tests:
  `engine/test/closedyear.test.js` and `closedyear_engine.test.js` (5, red first). Same rule in
  `Donor App Reference\audited_fy.py` (`pledge_link_fix`).
  **A new job kind, `setting`: change an app setting's value** (an environment variable; Dylan 10/18/26, "Lets build
  that into the toolkit"). Admin only. Named by the setting's schema name, the value given as text exactly as the
  setting stores it. The plan reads the setting and its one current value, checks the value fits the type (a Yes/No
  setting takes "yes" or "no", as every one in SBRM's apps stores it; a Number a number; JSON valid JSON), names every
  cloud flow that reads the setting, and names the solutions its value sits in, since importing one of them again can
  set it back. It warns "Can't be fully undone" when a flow that is on reads it. Apply re-reads the setting and its
  value, writes the one value with its version tag, and reads it back; revert sets the old value back only while the
  setting still holds what the plan wrote. Refused: Secret and Data source settings, a setting with no value of its
  own (its default applies; a first value is still made in the maker portal), a managed value, the value it already
  has. Claude Code's prompt names the setting and both values. Why: HGS's `sbrm_SharePointDocumentsEnable` was set
  to "no" by a 12/4/2024 solution import, the guest "Create Documents folder" button quietly did nothing for about 22
  months, and turning it back on had no way through the toolkit (a records job on the value table is refused).
  Tests: `engine/test/setting.test.js` (19, red first), `cli_app.test.js` (2: the whole path through the CLI, and a
  develop-level refusal), on `fake_setting.js` (shapes read live from HGS 10/18); the mutation pass
  `guard_review/mutate_setting.js` kills 19 of 19 mutants. A records job on the setting tables now names the new kind.
- **1.11.11** (2026-10-14, PR #15) **Book dates are written as local midnight.** A gift's book date (`msnfp_bookdate`) is a
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
