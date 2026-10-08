# Job files (`sbrm-dv-job/1`)

What a Claude session writes before `plan`. A job file is a REQUEST: the engine trusts nothing in it,
reads everything live, and refuses (never repairs) anything not exactly right. Save job files in
`~/.sbrm-dataverse/jobs/`, never in a git folder. Every job has:

- `contract`: `"sbrm-dv-job/1"`
- `kind`: `rows`, `merge`, `schema` or `component`
- `env`: the app's key (`donorapp`, `fedev` = Donor App Dev, `hgs`, `recovery`, `soberliving`)
- `source`: `"claude-session"` (or the script that made it)
- `reason`: one plain sentence on why, one line, at most 500 characters
- `intent`: what you say the job does; the engine checks it against the job and refuses the plan on any
  difference, so the sentence you tell the person and the file always agree

Who may run which kind is the person's level in that app (`whoami <env>`): write for `rows` (and `merge`
with a merge grant), develop for `schema` and `component`, admin for deleting an app part (records are never deleted).

## Records: `kind: "rows"`

```json
{ "contract": "sbrm-dv-job/1", "kind": "rows", "env": "donorapp", "table": "contacts", "mode": "update",
  "source": "claude-session", "reason": "Fix the mailing address from returned mail.",
  "intent": { "verb": "update", "count": 1, "table": "contacts", "fields": ["address1_city", "address1_line1"] },
  "rows": [
    { "name": "Jane Example", "id": "<contact guid>", "body": { "address1_line1": "123 Main St", "address1_city": "Santa Barbara" } }
  ] }
```

- `table` is the entity SET name (plural, lowercase). `mode`: `create` or `update`.
- Each row: `name` (the record's human name), `id` (update), `body` (create and update): plain
  columns by logical name, lookups as `"<NavigationProperty>@odata.bind": "/<set>(<guid>)"` (null clears).
- Optional: `verify` (columns to read back; every written column is read back anyway), `amount_field`
  (+ `intent.amount_total`), per create row `dup_filter` (one OData filter; a match leaves the row out).
- **Records are never deleted, only made inactive** (ruled 10/8): an `update` with `"statecode": 1` and the
  table's inactive `"statuscode"` (read its status options first). The plan headline says "Mark N ...
  inactive"; undo makes them active again. A `delete` mode is refused at `check`.

## Merges: `kind: "merge"` (donor app accounts and contacts)

```json
{ "contract": "sbrm-dv-job/1", "kind": "merge", "env": "donorapp", "table": "accounts",
  "source": "claude-session", "reason": "The intake made a copy of this foundation.",
  "intent": { "verb": "merge", "pairs": 1, "table": "accounts" },
  "pairs": [ { "keep": { "id": "<guid>", "name": "Example Foundation" },
               "duplicate": { "id": "<guid>", "name": "Example Foundation, Inc." },
               "fill_blank": ["telephone1"], "name_override": null } ] }
```

`fill_blank`: columns copied from the duplicate where the kept record is blank. `name_override`: who
confirmed two differently named records are the same, and why. Needs the merge grant (or admin).

## App changes: `kind: "schema"` (develop)

Tables, columns, relationships, alternate keys and choice options, in a named unmanaged SBRM solution.
Describe the OBJECTS; the engine works out the steps, waits for a new table, publishes, reads back.

```json
{ "contract": "sbrm-dv-job/1", "kind": "schema", "env": "fedev",
  "solution": { "uniquename": "SBRMInterviews", "friendlyname": "SBRM Interviews" },
  "source": "claude-session", "reason": "Track interview dates on the new Interviews table.",
  "intent": { "verb": "develop", "solution": "SBRMInterviews", "objects": { "tables": 1, "columns": 1 } },
  "objects": {
    "tables": [ { "schema_name": "sbrm_Interview", "display": "Interview", "plural": "Interviews",
                  "description": "One row per intake interview.",
                  "primary": { "schema_name": "sbrm_Name", "display": "Name" } } ],
    "columns": [ { "table": "sbrm_interview", "type": "date", "schema_name": "sbrm_InterviewDate", "display": "Interview Date" } ]
  } }
```

- Every object has an `action`: `create` (the default), `update` or `delete` (admin). Schema names carry
  the `sbrm_` prefix; `table` / `column` name existing ones by logical name (lowercase).
- **tables**: create `schema_name, display, plural, description, primary {schema_name, display,
  max_length?}, audit?, change_tracking?, quick_create?`; update `table, set {display, plural,
  description, audit, change_tracking, quick_create}`; delete `table`.
- **columns**: create `table, type, schema_name, display, description?, required?` plus by type:
  `text` / `memo` (`max_length`), `whole_number` (`min_value, max_value`), `decimal` / `money` (`min_value,
  max_value, precision`),
  `yes_no` (`default`), `date`, `datetime`, `choice` / `multi_choice` (`options` [labels], or
  `global_choice`), `autonumber` (`format` with `{SEQNUM:n}`). Update `table, column, set {display,
  description, required, max_length}` (length only UP; a type never changes). Delete `table, column`
  (destroys every value in it). Raising `required` on a column with blank rows, or creating a required column on a table that has rows, is
  admin.
- **relationships**: `type: "one_to_many"` (a lookup: `schema_name, display, referenced, referencing,
  required?, show_on_parent?`) or `"many_to_many"` (`schema_name, entity1, entity2, menu1?, menu2?`);
  delete by `schema_name` (admin).
- **keys** (admin): create `table, schema_name, display, columns`; delete `table, key`.
- **options**: `target` is `{table, column}` for a column's own choice or `{global}` for a global choice;
  `create` (`label`, `value?`), `update` (`value`, `label`), `reorder` (`order`: every value), `delete`
  (`value`, admin).
- `intent.objects` counts each kind the job lists. Optional `proven_in`: the Donor App Dev plan id of the
  same change, for an update to something live in the Donor App.
- A re-plan of a finished job plans nothing. Managed objects, Microsoft's `msnfp_` columns, and solutions
  under another publisher are refused.

## App changes: `kind: "component"` (develop)

A view (`savedqueries`), form (`systemforms`), sitemap (`sitemaps`) or Power Automate cloud flow
(`workflows`). Read the live component first:

`node "<toolkit>/dataverse/engine/dataverse-write.js" snapshot <env> <set> <id>`

It prints the `snapshot_hash` and saves the current definition to `~/.sbrm-dataverse/jobs/` to edit.

```json
{ "contract": "sbrm-dv-job/1", "kind": "component", "env": "donorapp",
  "component": { "set": "savedqueries", "id": "<view guid>", "name": "Active Donors" },
  "mode": "update", "definition": { "layoutxml": "<grid name=\"resultset\" object=\"2\" jump=\"fullname\" select=\"1\" icon=\"1\" preview=\"1\"><row name=\"result\" id=\"contactid\"><cell name=\"emailaddress1\" width=\"150\" /><cell name=\"fullname\" width=\"300\" /></row></grid>" },
  "snapshot_hash": "<64 hex from snapshot>", "proven_in": null,
  "source": "claude-session", "reason": "Show the email column first.",
  "intent": { "verb": "update", "component": "view", "name": "Active Donors", "changed": ["columns"] } }
```

- `mode`: `update`, `create` (with `solution` = an unmanaged SBRM solution's unique name; a new view needs
  `returnedtypecode`, `fetchxml` and `layoutxml`, a new form `objecttypecode` and `formxml`, a new flow
  `clientdata`), and for flows only `on`, `off` and `own` (with `owner` = the new owner's systemuser id;
  admin, since a flow acts as its owner); `delete` is admin, and never a flow that is On.
  Every mode except `create` needs the `snapshot_hash` from `snapshot`.
- `definition` holds only what changes: flows `clientdata` (+ `description`), views `fetchxml` /
  `layoutxml`, forms `formxml`, sitemaps `sitemapxml`. Every field a form names must exist on the table.
- `intent.changed` (updates only; leave it out for every other mode) lists every section that changes; the
  engine computes the same list from its own diff and refuses on any difference. Flows: `trigger,
  concurrency, actions, notes, connections, description, other`. Views: `columns, filters, sort,
  description, other`. Forms: `tabs, sections, fields, events, description, other`. Sitemaps: `areas,
  groups, subareas, other`. A refusal names the sections it found.
- Admin, not develop: a flow step that reaches beyond its connection (an HTTP step, a child flow, a table
  named at run time, a step on someone else's connection), anything in a flow's "other" section, a
  changed trigger or connection on a live flow, a script or web content in a view or form, handing a
  flow to a new owner. A flow that holds a secret in plain text is refused: move it to a Secret
  environment variable first.
- A flow plan prints who the flow RUNS AS (its connections' owner): say it to the person. Adding or
  swapping a connection, or changing the trigger of a flow that is On, is admin. Turning a flow On fails
  unless the person owns its connections; the engine says who must do it.

## What the plan prints first

`Before you approve:` lines, when there are any: **Large change** (over 50 rows, pairs or objects),
**Can't be fully undone** (merges, deletes, a live flow's steps, turning a flow On), **Lasting** (a new
table, column, view, form or flow stays until an admin deletes it), **Not tried in Donor App Dev first**
(a change to something live in the Donor App without `proven_in`). Mention each in a few words before
the apply; Claude Code's prompt shows them again. If the change grows between plan and apply, apply refuses.
