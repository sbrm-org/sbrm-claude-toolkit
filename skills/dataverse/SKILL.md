---
name: dataverse
description: >
  Change SBRM's Dataverse apps (Donor App, Donor App Dev, HGS apps, Recovery app, Sober Living app)
  through the shared write path: records (add, update, merge, delete) AND the apps themselves (tables,
  columns, choices, views, forms, sitemaps, Power Automate flows). Claude prepares the change as a job
  file, the engine plans it and works out how serious it is, Claude tells the person, and the person
  approves it in a pop-up before anything is written. Also covers what to do when something goes wrong
  (report it to Dylan in the person's own words) and checking that the setup works (the health check).
  Triggers on "update the donor app", "change this contact", "fix the record", "add a gift",
  "write to Dataverse", "mark inactive", "delete these records", "add a column", "new table", "change
  the view", "edit the form", "fix the flow", "turn the flow off", "undo that change", "revert", "the
  Dataverse tools aren't working", "is my Dataverse set up right", "report a problem with the donor app tools".
---

# Dataverse changes (SBRM shared write path)

Reads still go through the read-only Dataverse connections; this
skill is only for CHANGES.

## Who may do what

Each person has a level in each app, on that app's Dataverse Write Access list (`whoami <app>` shows it):

| Level | Can |
|---|---|
| read | look only (anyone without a row) |
| write | change records; merge only with a separate "may merge" yes |
| develop | everything in write, plus change the app: tables, columns, choices, views, forms, sitemaps, flows |
| admin | everything in develop, plus deletes of any kind, alternate keys, making a column required on a table that has rows, flow steps that reach beyond their connection (HTTP, child flows, a run-time table, someone else's connection, a changed trigger on a live flow), script or web content in views and forms, handing a flow to a new owner, the toolkit's own lists, and closing reported items |

There is no limit on how much one change may touch. Instead the engine flags a big or serious change
(below), and the person decides knowing it. The level is the toolkit's; the person's own Dataverse role
must also allow the change (the health check says when it does not). Want more access? Ask Dylan.

## The engine

`node "<toolkit>/dataverse/engine/dataverse-write.js" <command>`, where `<toolkit>` is this plugin's
folder: two levels up from this skill's own base directory (`<base>/../..`). Go by the base directory, not
a guessed cache path: a machine can hold several toolkit versions, or run one from a local folder.
Verify the path on first use and say it in full whenever you hand the person a command.

## Making a change

1. **Read first.** Use the read connection to find the exact records (or the live view, form, flow,
   table) and their current values. Never build a change from memory or from what the person thinks it says.
2. **Write the job file** (`sbrm-dv-job/1`; read `<toolkit>/dataverse/JOBS.md` for every kind's exact
   shape before writing one). Records: `kind: "rows"`, env, table, create / update / delete, one row per record by its real
   name and id, the body, a one-sentence `reason` in plain words, and an `intent` that states exactly what
   you are changing. App changes: `kind: "schema"` (tables, columns, relationships, keys, choices) or
   `kind: "component"` (a view, form, sitemap or flow), see below. Save it in `~/.sbrm-dataverse/jobs/`,
   never in a git folder (Recovery job files there are refused).
3. **Run `plan <job.json>`.** Planning only reads; nothing changes. If it refuses, or rows were left
   out, tell the person which and why and stop there. The engine checks your `intent` against the job
   and refuses the plan if they disagree.
4. **Tell the person what will change and how serious it is, then ask.** One sentence for the change,
   with the count ("This fixes the mailing address on 4 contacts."). Then, if the plan printed a
   "Before you approve" block, say EVERY line of it in plain words: a large change ("this touches 340
   contacts"), something that can't be fully undone and why, something lasting (a new column stays until
   an admin deletes it), or a change to something live that was not tried in Donor App Dev first. Never
   soften, summarize away or skip a line; the person approves knowing all of it. Then: "Go ahead?"
5. **When they say yes, run `apply <plan-id>` yourself, IN THE BACKGROUND** (the shell tool's run in
   background option), so a long change (a big merge, a new table) is never cut off by the command time
   limit part-way; you are told when it finishes. Tell them first: "A window will pop up on your screen
   listing the change. Click Approve to write it, or Cancel." For a delete add: "To approve, type the name
   it shows into the box." Only their click writes. The window closes itself as Cancel after 9 minutes.
   While it is open, use no tool that drives the screen, mouse or keyboard (the guard refuses them). Never
   try to click it, answer it, or write some other way if they cancel. If apply refuses because the change
   grew or moved since the plan, plan it again and go back to step 4.
6. **After the apply, read the output back to them**: what was written, anything that was not, and
   that it is in the Write Log.

Batch related changes into ONE job, so the person sees one pop-up, not ten. Never ask the person to
run or paste a command.

## Changing the app (develop)

- **Donor App Dev first for anything live.** A change to something people use in the Donor App (an
  existing flow, form, view, or a column's settings) should be tried in Donor App Dev first. If it was,
  put that plan id in the job as `proven_in`; if not, the plan says "Not tried in Donor App Dev first"
  and you tell the person. Adding something new (a table, a column, a view, a flow created Off) needs no
  dev run: nothing live moves.
- **Tables, columns, choices** (`kind: "schema"`): name the unmanaged SBRM solution the change belongs
  in; a new feature gets its own, a one-off tweak goes in the app's ad-hoc solution. Describe the objects
  you want; the engine works out the steps, waits for a new table to be ready, and publishes. A re-plan
  of a finished job plans nothing.
- **Views, forms, sitemaps, flows** (`kind: "component"`): run `snapshot <env> <set> <id>` first; it
  saves the live definition to edit and prints its hash, which goes in the job. If anyone changes the
  component after your read, the plan refuses and you read again.
  For a flow, the plan says who it RUNS AS: tell the person. Adding or swapping a flow's connection, or
  changing the trigger of a flow that is On, is an admin's.
- A column's type cannot be changed (that is delete and recreate). Managed components (Microsoft's own
  `msnfp_` tables, forms and views) are not changed; add your own beside them.

## Deleting (admin)

Admins may delete records and app objects (a column, a table, a view, a flow). A delete cannot be
undone by the toolkit: the plan says so, you say so, and the pop-up asks for the record's or object's
name (or "delete N" for several) to be typed before Approve works. Deleting a column or table destroys
every value in it. Nobody deletes the Write Log or event rows.

## Undoing a change

`revert <plan-id>` plans the undo of an applied plan; it is approved like any other write. "Undo that" is
the request, not the yes: tell the person what the undo will restore (and anything left out), ask "go
ahead?", and only then run `apply`. A record
someone has edited since is left out on purpose (undoing would wipe their edit). If they really want
the old value back, that is an ordinary new job. App changes undo the same way (a changed view, form,
flow or setting goes back to how it was); something NEW stays (only an admin delete removes it), and a
delete cannot be undone.

## When something goes wrong

**A refusal is usually the gate doing its job** (the record is inactive, nothing to change, a record
moved since the plan, the job file was wrong). Explain it in plain words and fix the job if it was
yours. Don't offer a report for those.

**Offer a report when:** a write ended "applied with problems", the person thinks a refusal was wrong,
the result isn't what they expected, or the tools fail. Ask one question: *"Want me to report this so
Dylan sees it? Anything to add in your own words?"* Then run:

`report "<their words, exactly as they said them>" --plan <plan-id if there is one>`

If the person asked for the report themselves and said what is wrong in the same message, that IS
their words: file it without asking again. Their words go in VERBATIM: never your summary or a cleaned-up version (your restatement is the thing
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

`doctor` checks this machine: the CLI, sign-in to each app, the person's access, whether their
Dataverse role can actually customize an app where they hold develop or admin, the log tables,
anything waiting to be sent, and that the toolkit's connections are the only Dataverse connections on
the machine. Run it when the person asks whether their Dataverse setup works, after a tools failure is
fixed, and at the end of setup, as `doctor --apps <the apps they use>` when you know them (an app that
does not answer is a failure only where they use it). Read the result back in plain words. If it reports an extra Dataverse
connection or hook, don't remove it yourself: tell the person, and suggest `/dataverse-setup`, which
cleans up with their OK.

## Never

- Run `apply` before the person has said yes in chat to the change AND its warnings, or approve, click,
  type into or answer the pop-up for them.
- Leave out, soften or reword away a "Before you approve" line.
- Ask the person to run or paste a command.
- Write to Dataverse any other way (the read connections, the CLI's own write commands, the maker
  tools of a Dataverse connection, a script).
- Edit anything in `~/.sbrm-dataverse/` (except job files in `jobs/`) or in this plugin's folder.
- Resolve or close a reported item (only a toolkit admin does).
