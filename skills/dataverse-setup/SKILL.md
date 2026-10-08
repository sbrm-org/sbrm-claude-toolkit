---
name: dataverse-setup
description: >
  Set up, repair or check this computer's connection to SBRM's Dataverse apps (Donor App, HGS, Recovery,
  Sober Living) for the SBRM toolkit: Node, the Dataverse CLI at the version the toolkit expects, the
  person's own Microsoft sign-in, removal of older hand-built connections and guards, then the health
  check until it passes. Safe to re-run; it only does what is missing. Triggers on "/dataverse-setup",
  "set up Dataverse", "connect me to the donor app", "is my Dataverse set up right", "the Dataverse
  tools aren't working", "Dataverse health check", "run doctor", "I got a new Mac".
---

# Dataverse setup (SBRM toolkit)

DRAFT, 10/7/26. For the Claude of a staff member on a Mac (Windows notes where they differ). The toolkit
plugin itself is already on this computer: SBRM's managed settings install and update it. This skill
sets up what the plugin cannot ship: the Dataverse CLI, the person's sign-in, and a clean machine.

**The shape of the whole thing:** run the health check, do the fixes it names, run it again. Stop when
it passes. Nothing here grants access to data; the person's Dataverse security role decides what they
can read, and write access is a separate grant from Dylan.

## Before you start

- This runs in **Claude Code in the terminal**. The guard that makes writes safe is a Claude Code hook
  and does not run in the Claude desktop chat or on claude.ai.
- Find this plugin's folder: two levels up from this skill's own base directory (`<base>/../..`), never
  a guessed cache path (a machine can hold several versions, or run the toolkit from a local folder).
  Call it `<toolkit>` below. The health check is
  `node "<toolkit>/dataverse/engine/dataverse-write.js" doctor`.
- Tell the person what this will do, in a few lines: install one command-line tool, have them sign in
  to the donor app (and any other SBRM app they use) with their own Microsoft account, and tidy up any
  older Dataverse connection on this Mac. Ask which SBRM apps they use. Most people: the Donor App only.

## Step 1. Node

`doctor` needs Node to run, so this is the one step that comes before it. Run `node --version`.

- **Present (18 or newer):** move on. All three current staff Macs already have it.
- **Missing:** install it per-user, with no administrator password: install nvm with the one-line
  installer from nvm.sh, open a new terminal, then `nvm install --lts`. Tell the person before running
  the installer: it adds a few lines to their shell profile and nothing else.

## Step 2. The health check, first pass

First record the apps they use: `node "<toolkit>/dataverse/engine/dataverse-write.js" apps <keys separated
by commas>` (keys: donorapp, fedev = Donor App Dev, hgs, recovery, soberliving; most people: `donorapp`,
plus `fedev` for anyone who builds in Donor App Dev). Every app's connection signs in to it at each start,
and on a Mac each one without a saved sign-in opened its own browser sign-in (found 10/8: four at
startup), so the apps they do not use stay switched off. It grants nothing and narrows reads only; `apps
all` undoes it; running setup again changes it. Then run `doctor`: it checks exactly those apps, and that
each has a SAVED sign-in on this machine.
It prints one line per check, `ok` / `FAIL` / `--`, and under every FAIL a `fix:` line
that says exactly what to do. Read it to the person in plain words, not as a list of codes. Then do the
fixes, in the order below, and run `doctor` again after each round.

The checks and what their fixes look like:

**Dataverse CLI.** The toolkit pins one version (`<toolkit>/dataverse/toolkit.json`, `cli_version`), so
every machine's guard parses the same commands. The fix line gives the exact `npm install -g` command.
Run it as the person, never with `sudo`; if npm says permission denied, install Node through nvm
(Step 1) and run the install again. Then **restart Claude Code** so the plugin's connections start on
the new CLI.
*Windows only:* SBRM PCs run ThreatLocker, which approves programs one file at a time, so a newly
installed CLI can be blocked even though it is there. `doctor` says so plainly. The fix is the person's:
ThreatLocker tray icon, Rapid Check-in, and if still blocked, request access for that file.

**Signed in: <app>.** The person signs in; Claude never does. Run the fix line,
`dataverse auth create --environment <url>`, and tell them a browser window will open asking for their
SBRM Microsoft account. If no browser opens (common over remote sessions), add `--deviceCode` and read
them the code and the web address it prints. One sign-in per app they use, each saved once: a "Saved
sign-in: <app>" FAIL means that app answered but has no saved sign-in, and would ask again at every start. An app they do not use is
allowed to show `--` ("no answer, fine if you don't use it"); it is a FAIL only where they are meant to
write. If the sign-in works and the app still does not answer, the fix line says to ask Dylan: they may
have no security role there.

**Write Log / event table.** Reachable once signed in. A FAIL here is Dylan's to fix (the fix line says
so); nothing for you to do but tell him.

**Waiting on this machine.** Anything recorded while the machine could not reach Dataverse. It goes up
on its own once the sign-in works; if it is still there after a passing run, tell Dylan.

**Extra Dataverse connection / hook.** This is the cleanup, and the step that most needs its "why". See
Step 3.

**Guard.** `doctor` feeds the toolkit's guard a pretend write and checks it is blocked, and checks no
settings file has switched hooks off. A FAIL here means stop: do not write to Dataverse, tell Dylan.

## Step 3. Cleaning up older setups (only with the person's OK)

Before the toolkit, some people set up a Dataverse connection and a safety guard by hand. The toolkit
now ships both, so the older copies must go: two connections to the same app confuse Claude about
which one it is using, and an older guard covers less than the new one (one hand-built guard, for example,
blocked only some write commands). `doctor` names each extra piece and its exact fix:

- **An extra connection:** `claude mcp remove <name> --scope <scope>`, and for `local` scope run it
  from the folder the fix line names (usually the home folder). Explain: "this removes the older
  donor-app connection you set up by hand; the toolkit's connection to the same app replaces it, and
  you stay signed in."
- **An extra hook:** remove that one entry from the settings file the fix line names, and change
  nothing else in the file (their other hooks, such as a terminal status line, stay). Explain: "this
  was your older safety guard; the toolkit's guard now does that job and more."

Also, with their OK: permission entries naming the OLD connection (lines like
`mcp__dataverse-donorapp__read_query` under `permissions.allow` in `~/.claude/settings.local.json`) no
longer match anything once the old connection is gone; remove those lines too. The toolkit's tools are
named `mcp__plugin_sbrm-toolkit_dataverse-<app>__<tool>`, so the first read through them may ask the
person to allow it once.

**Then update what Claude REMEMBERS about the old setup** (found 10/8 on the first staff Mac: after the
cleanup, that person's Claude kept reaching for the removed connection because its own notes still named
it). With their OK, look in the person's Claude memory and instruction files: `~/.claude/CLAUDE.md`,
every `~/.claude/projects/*/memory/*.md` and `MEMORY.md`, and a `CLAUDE.md` in the folders they work in.
Find anything naming the old connection (`dataverse-donorapp` without the `plugin_sbrm-toolkit_` prefix,
`mcp__dataverse-`, the old guard's file name) or describing the hand-built setup. Show them each place
and the change, then replace it with one line: "Dataverse goes through the SBRM toolkit: its
`mcp__plugin_sbrm-toolkit_dataverse-<app>` connections for reading, its dataverse skill for changes. The
older hand-built connection and guard were removed (<date>)." Change nothing else in those files.

Then **quit Claude Code completely and reopen it** (hooks and connections load at start) and run
`doctor` again.

Known starting points on 10/6/26, so you recognise them:
- a `dataverse-donorapp` connection at local scope plus `~/.claude/hooks/dataverse-readonly-guard.sh`;
- `~/.claude/hooks/donorapp-readonly-guard.js` with no connection at all;
- nothing at all (no CLI, no sign-in, no connection).

## Step 4. Done when

1. `doctor` prints "Everything checked is working." after the restart (with the apps recorded in Step 2
   it checks exactly those, each with a saved sign-in), and opening Claude Code again brings up no
   browser sign-in.
2. One read in each app the person uses, through the toolkit's connection: for example
   `read_query` for the top 1 row of a table they know (contacts in the Donor App). Show them the row
   so they see it is their data. If an app's connection is up but offers no tools at all, that app has
   not allowed the toolkit's connection yet (an admin setting in that environment): tell Dylan.
3. Tell them where they stand: **reading works now. Writing is a separate permission that Dylan grants
   per person per app**; if they will need it, they message him and he adds them to that app's Write Access list. When they write,
   Claude tells them what will change and every warning, and then Claude Code itself asks them to
   approve the command; nothing is written until they choose Yes there. That prompt only appears in a
   permission mode that asks, so a session in "bypass permissions" cannot write.

## If something goes wrong

Run `doctor`; it records every failing run for Dylan's review on its own. If the person is stuck,
`report "<their words, exactly>"` sends their description with the details attached, and prints a
number (like D-1003) they can mention to Dylan on Teams. Nothing here can notify him; a message from
them is still how he hears about it today.

## Never

- Sign in for the person, or type a password or code on their behalf.
- Remove a connection, a hook or any file without saying what it is and getting their OK.
- Use `sudo`.
- Edit this plugin's files or anything under `~/.sbrm-dataverse/` except `jobs/`.
