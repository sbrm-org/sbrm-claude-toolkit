---
name: dataverse
description: >
  Change records in SBRM's Dataverse apps (Donor App, HGS apps, Recovery app, Sober Living app) through
  the shared write path: Claude prepares the change as a job file, the engine plans it, and the person
  approves it in a pop-up before anything is written. Also covers what to do when something goes wrong
  (report it to Dylan in the person's own words) and checking that the setup works (the health check).
  Triggers on "update the donor app", "change this contact", "fix the record", "add a gift",
  "write to Dataverse", "mark inactive", "undo that change", "revert", "the Dataverse tools aren't
  working", "is my Dataverse set up right", "report a problem with the donor app tools".
---

# Dataverse writes (SBRM shared write path)

Reads still go through the read-only Dataverse connections; this
skill is only for CHANGES.

## The engine

`node "<toolkit>/dataverse/engine/dataverse-write.js" <command>`, where `<toolkit>` is this plugin's
folder (on a Mac, under `~/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/<version>/`).
Verify the path on first use and say it in full whenever you hand the person a command.

## Making a change

1. **Read first.** Use the read connection to find the exact records and their current values. Never
   build a write from memory or from what the person thinks the record says.
2. **Write the job file** (`sbrm-dv-job/1`, the contract is in the toolkit's `dataverse` folder):
   env, table, create or update, one row per record by its real name and id, the body, a one-sentence
   `reason` in plain words, and an `intent` that states exactly what you are changing. Save it in
   `~/.sbrm-dataverse/jobs/`, never in a git folder (Recovery job files there are refused).
3. **Tell the person in one sentence what you will change**, with the count and the field ("I'll fix
   the mailing address on 4 contacts"). The engine checks your `intent` against the rows and refuses
   the plan if they disagree, so the sentence you say must match the file.
4. **Run `plan <job.json>`** and show the person its summary as printed. If rows were left out, say
   which and why.
5. **Hand the person the apply line** to run themselves, in full: `! node "<full path>" apply <plan-id>`.
   You never run apply. A pop-up opens on their screen; only their Approve writes.
6. **After the apply, read the output back to them**: what was written, anything that was not, and
   that it is in the Write Log.

Batch related changes into ONE job, so the person sees one pop-up, not ten. Their row limit is on
their row in that app's Dataverse Write Access list (`whoami <app>` shows it); over it, split the job or
ask Dylan.

## Undoing a change

`revert <plan-id>` plans the undo of an applied plan; it is approved like any other write. A record
someone has edited since is left out on purpose (undoing would wipe their edit). If they really want
the old value back, that is an ordinary new job.

## When something goes wrong

**A refusal is usually the gate doing its job** (the record is inactive, nothing to change, a record
moved since the plan, the job file was wrong). Explain it in plain words and fix the job if it was
yours. Don't offer a report for those.

**Offer a report when:** a write ended "applied with problems", the person thinks a refusal was wrong,
the result isn't what they expected, or the tools fail. Ask one question: *"Want me to report this so
Dylan sees it? Anything to add in your own words?"* Then run:

`report "<their words, exactly as they said them>" --plan <plan-id if there is one>`

Their words go in VERBATIM: never your summary or a cleaned-up version (your restatement is the thing
that can be wrong). The engine attaches the recent runs, the plan and the versions itself. Read back
what it prints: the number (like D-1003) they can quote to Dylan, or that it was saved on the machine.
Nothing here can notify Dylan. If it's urgent, tell them to message him and mention the number.

**When the tools themselves fail** (the CLI isn't found, sign-in expired, an app doesn't answer):
say plainly that nothing was changed, that it was recorded on this machine and reaches Dylan the next
time the machine connects, and that if they need it today they should message him directly. Never
work around a failure by writing some other way.

**After the tools work again, run `doctor`** so what was waiting gets sent and the record of the
failure reaches Dylan.

## The health check

`doctor` checks this machine: the CLI, sign-in to each app, the person's access, the log tables,
anything waiting to be sent, and that the toolkit's connections are the only Dataverse connections on
the machine. Run it when the person asks whether their Dataverse setup works, after a tools failure is
fixed, and at the end of setup. Read the result back in plain words. If it reports an extra Dataverse
connection or hook, don't remove it yourself: tell the person, and suggest `/dataverse-setup`, which
cleans up with their OK.

## Never

- Run `apply`, or approve a pop-up, or try to answer it for the person.
- Write to Dataverse any other way (the read connections, the CLI's own write commands, a script).
- Edit anything in `~/.sbrm-dataverse/` or in this plugin's folder.
- Resolve or close a reported item (only Dylan does).
