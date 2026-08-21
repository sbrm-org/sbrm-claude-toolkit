---
name: competitor-pay
description: Competitive pay research for SBRM salary benchmarking, and a general Santa Barbara nonprofit compensation database. Searches job boards and nonprofit career pages for local postings, extracts pay ranges, matches them to SBRM's 16 tracked roles or records them as market reference, and syncs qualifying results to the "Competitor's Pay" SharePoint list on the HR site. Triggers on "competitor pay", "comp search", "salary benchmarking", "market pay", "what are other orgs paying", "pay comparison", "wage survey", "floor pay research", "nonprofit director pay", "/comp-search", "/comp-setup".
metadata:
  version: 0.3.0
  supersedes: 0.2.0 (2026-04-20)
  updated: 2026-08-21
---

# Competitor Pay Research
Benchmarks market pay for Santa Barbara Rescue Mission's 16 tracked roles. Collects postings from six sources, scores them for role fit, and pushes the good matches to a SharePoint list HR uses to set floor pay each fiscal year.

**This tool has two jobs now, and the second one is new in 0.3.0.** It began as a pure *role-matching* tool: a posting either mapped to one of SBRM's own jobs or it did not belong. As of 2026-08-17 it also serves as a **general Santa Barbara nonprofit compensation database**, tracking director-level and development pay whether or not SBRM staffs a matching title. Those rows are kept under `Market Reference - No SBRM Equivalent` and are found by `market_reference_keywords` on the career-page sweep. A database of what local nonprofit leadership actually gets paid is useful on its own.

**Who uses the output.** SBRM's HR Associate, setting floor pay for a fiscal year that starts October 1. Every row you write is evidence someone will sort, average, and make a pay decision from. That is the standard for "is this good enough to write" throughout.
## Before doing anything: preflight
Run these checks first. Three severities, and they behave differently:

- **ERROR** stops the run. Report it in plain English and do not continue.
- **NOTICE** disables SharePoint sync but allows collection and reporting.
- **WARN** drops a source from this run.

Degrading is allowed; degrading *silently* is not. Any NOTICE or WARN must be repeated in the final report, so a partial run never reads as a complete one.

**Shell state does not persist between tool calls.** Every Bash call gets a fresh shell, so a variable set in one block is empty in the next. Rather than sharing a state file, **every Bash block in this skill re-derives its two paths on its own first two lines.** They are pure functions of the environment, so they cannot drift or go stale:

```bash
CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
CP_DB="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}/data/comp_research.db"
```

Copy those two lines verbatim into the top of **every block that touches the skill directory or the database**. A block that omits them runs `python3 /scripts/init_db.py --db /data/comp_research.db` against the filesystem root. (The preflight block below derives `CP_DATA` instead, since it creates the directories; the `caffeinate` block needs neither.)

The capability flags (`can_push`, `org_website`) are **not** shell variables. Preflight prints them, and you carry them as decisions for the rest of the run.

```bash
CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
CP_DATA="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}"

# 1. Skill directory present
[ -d "$CP_DIR" ] || { echo "ERROR: competitor-pay not found at $CP_DIR"; exit 1; }

# 2. Data directory, deliberately OUTSIDE the skill directory. When installed as a
#    plugin, the skill dir is replaced wholesale on auto-update, and the database
#    holds sharepoint_item_id, the only thing preventing a mass duplicate push.
mkdir -p "$CP_DATA/data" "$CP_DATA/logs"

# 3. Required files
for f in config.json roles/roles.json scripts/init_db.py; do
  [ -f "$CP_DIR/$f" ] || { echo "ERROR: missing $CP_DIR/$f"; exit 1; }
done

# 4. Required tools
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not on PATH"; exit 1; }
command -v playwright-cli >/dev/null 2>&1 || echo "WARN: playwright-cli missing. LinkedIn detail, ZipRecruiter, Glassdoor, and Handshake will be skipped."

# 5. Capability gates. Read these off and carry them for the rest of the run.
[ -f "$CP_DIR/scripts/seed_from_sharepoint.py" ] \
  && echo "can_push=YES (seeder present)" \
  || echo "NOTICE: can_push=NO. scripts/seed_from_sharepoint.py is missing, so SharePoint sync is off this run. Collection and reporting still work; a push would duplicate rows already in the list."

[ -f "$CP_DIR/scripts/search_org_website.py" ] \
  && echo "org_website=YES" \
  || echo "WARN: org_website=NO. scripts/search_org_website.py is missing, so the career-page sweep (Phase 2), the highest-yield source, is skipped this run."

echo "Preflight complete. Every later block must re-derive CP_DIR and CP_DB on its own first two lines."
```

**6. Microsoft 365 access.** Two ways in. Which one you have depends on the machine, and **the CLI wrapper is the preferred path where it exists**:

- **`ms365` CLI wrapper (preferred).** An on-demand wrapper over the same Graph API, at `~/.local/bin/ms365`. Check with `command -v ms365`. Verify auth with `ms365 verify-login`; on failure run `ms365 login`, which prints a device code the user enters at `https://login.microsoft.com/device`. **Argument spellings are not uniform across subcommands, and getting one wrong fails at argument parsing before Graph is ever called.** Prefer the `--stdin` form below, which sidesteps the problem entirely. Subcommand syntax, JSON parsing and the auth-failure runbook live in the `mcp2cli` skill; load it before the first call.
- **MCP server (fallback).** `@softeria/ms-365-mcp-server` under `mcpServers` in settings, exposing `mcp__ms365__*` tools. Verify with `mcp__ms365__verify-login`. Only relevant on a machine without the wrapper.

**Do not re-add the MCP server on a machine that has the wrapper.** The resident servers were removed deliberately to reclaim ~2 GB of idle RAM; re-adding one defeats that.

Every Graph call below is written in **CLI form**. The MCP equivalent is the same tool name with the `mcp__ms365__` prefix and camelCase parameters.

**7. Confirm the target list resolves** before collecting anything, so a bad site or list ID fails in 10 seconds rather than 90 minutes:

```bash
CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
SITE=$(python3 "$CP_DIR/scripts/sharepoint_target.py" site_id)
echo "{\"siteId\": \"$SITE\"}" | ms365 get-sharepoint-site --stdin
```

**Pass every argument on stdin. This is the reliable form, verified against the live list 2026-08-21.**

```bash
echo '{"siteId": "...", "listId": "...", "listItemId": "42", "body": {"fields": {...}}}' \
  | ms365 <subcommand> --stdin
```

`--stdin` supplies *all* arguments, so any `--site-id` / `--list-id` flags alongside it are ignored, and stdin keys use the MCP tools' **camelCase** names (`siteId`, `listId`, `listItemId`, `columnDefinitionId`).

Flag-based calls are a trap. Spellings differ per subcommand (`--list-item-id` on items, `--column-definition-id` on columns) and several subcommands reject `--account` outright, which makes argparse fail the whole call. That failure looks like a crash, not a bad write, so it is safe but it will stop a run dead. **Do not pass `--account` to the column or item subcommands.** Confirm the default account instead:

```bash
ms365 list-accounts    # sbrmappadmin@sbrm.org must be isDefault
```

**Always resolve the IDs through `scripts/sharepoint_target.py`, never by reading `config.json` directly.** This repository is public, so the committed `config.json` carries `REPLACE_ME` placeholders. The real values live in `$COMPETITOR_PAY_HOME/config.local.json` (default `~/.competitor-pay/`), which sits outside the skill directory and is therefore never committed and never lost to a plugin update. Resolution order is CLI flag, then `CP_SITE_ID` / `CP_LIST_ID`, then that local file, then `config.json`. A missing ID fails with instructions rather than sending `REPLACE_ME` to Graph.

**The wrapper exits 0 on auth failure and puts the error in the payload.** `{"error": "Failed to acquire token..."}` comes back with a zero exit status. Any code reading this output must check for an `error` key, not just the exit code. Treating an auth failure as data is how "the list is empty" becomes a mass duplicate push.

**8. Confirm the required columns exist.**

```bash
CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
SITE=$(python3 "$CP_DIR/scripts/sharepoint_target.py" site_id)
LIST=$(python3 "$CP_DIR/scripts/sharepoint_target.py" list_id)
echo "{\"siteId\": \"$SITE\", \"listId\": \"$LIST\"}" \
  | ms365 list-sharepoint-list-columns --stdin
```

Check for `PayUnit` and `Credential`, and confirm `SBRM Equivalent` is still **multi**-select with `allowTextEntry` off.

**Graph does not report a `multipleValues` flag on choice columns.** Read `choice.displayAs` instead: `checkBoxes` means multi-select, `dropDownMenu` means single. Looking for a flag that is never present makes every multi-select column read as single, which would argue for scalar writes and silently destroy the second label on the rows that carry two. If `PayUnit` or `Credential` is missing, **treat it as a NOTICE, carry `can_push=NO` for the rest of the run, and skip Phase 6b**, because the push spec below makes `PayUnit` mandatory and every write would error. Collection and reporting still work.

Report which boards are available before starting, so the user knows up front what coverage this run will have.
## File locations
Code lives under `$CP_DIR` and is disposable. **Data lives outside it and is not.**

- Database: `${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}/data/comp_research.db` (`$CP_DB` in the blocks below)
- Logs: `${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}/logs/comp_search.log`
- Roles: `$CP_DIR/roles/roles.json` (16 canonical roles, each with `description_summary` and `exclude_keywords`, plus `sbrm_equivalent_extra_choices` for the one non-role choice value)
- Config: `$CP_DIR/config.json`

Never write the database inside `$CP_DIR`. A plugin update replaces that directory, and losing `sharepoint_item_id` is what causes a mass duplicate push.
## Sources
Six, of which one is new in 0.3.0.

| Source | Method | Auth | Reliability |
|---|---|---|---|
| Indeed | Claude connector `mcp__claude_ai_Indeed__search_jobs` | none | Parses cleanly, but returns very few results. Not sufficient alone. |
| Career pages | `web-research` skill | none | Most reliable source. The orgs you benchmark against post directly. |
| LinkedIn | Jina Reader for discovery, playwright-cli for detail | login | Fragile. Verify output before trusting. |
| ZipRecruiter | playwright-cli | none | Fragile. |
| Glassdoor | playwright-cli | login | Fragile. |
| Handshake | playwright-cli | login | Off by default. Mostly student roles. |

**Use the `web-research` skill for all non-connector fetching.** It is the SBRM-approved web layer: Tavily when `TAVILY_API_KEY` is set, then DuckDuckGo and Jina Reader as keyless fallbacks. Do **not** use the `web-access` skill; it depends on Tim's private Tailscale network and will not work here.

**Browser logins must use an SBRM role account, never a personal profile.** Automated collection behind a login breaches these sites' user agreements. That exposure belongs to an account the org controls.
## The vocabulary: roles, credential, pay unit
Three controlled columns carry the meaning in this list. Getting them right is most of the job.
### `SBRM Equivalent`: 16 roles plus one escape hatch
Multi-select, fill-in text **off**. A row may legitimately carry two labels. The writable values are the 16 canonical titles in `roles.json` plus `Market Reference - No SBRM Equivalent`.

Three of those 16 were settled on 2026-08-17 and are easy to get wrong from memory:

| Value | What changed |
|---|---|
| `Case Manager Unlicensed - Treatment Services` | The former `RTS no license` label, renamed. It is a real long-standing SBRM role, not drift: the unlicensed tier of treatment case management. Its licensed counterpart is `Case Manager - Treatment Services`. |
| `Residential Coordinator` | Absorbed the retired `Program Tech` role **and** the `Tech` label. Now covers both the men's program and the women's program (Bethel House). Never write `Program Tech` or `Tech`. |
| `Market Reference - No SBRM Equivalent` | A choice value, **not** a role. It is not in the `roles` array and is never searched from `roles.json`. |

### `Credential`: the licensure axis
`Licensed / Certified`, `Not required`, `N/A`. Licensure is the single largest pay driver in residential treatment hiring, and the role label alone cannot express it on the ~166 rows outside the two treatment-services roles. `N/A` means *no signal*, not *no licence*. Never let it outrank a real signal on a row carrying two labels.
### `PayUnit`: what the number means
`Hourly`, `Annual`, `Weekly`, `Bi-weekly`, `Monthly`, `Not listed`. Required on every write. Map `salary_type` through `pay_unit_map` in `config.json`.

`Bi-weekly` must never collapse into `Weekly`. The extractor treats them as x26 versus x52, so the collapse reads a $2,000 biweekly posting as $104k a year instead of $52k.
## Classifying a posting into a role
**Read the posting and decide. There is no rule table, and you should not build one.**

This is a deliberate design decision (Tim, 2026-08-17), which replaced a drafted keyword-and-employer scheme. Both halves of that scheme were wrong:

- **The employer half carried no signal.** Most Santa Barbara nonprofits now run both program types and staff case managers on each side, so knowing a posting came from Good Samaritan or PATH tells you nothing about treatment versus homeless services.
- **The keyword half solved the wrong problem.** Sorting a posting into treatment versus homeless services is a judgment call on the evidence in front of you. Encoding it as a keyword table just produces a worse version of that judgment, with a residual pile bolted on where the table runs out.

So: read the `Title`, the `Organization`, the description snippet, and the posting itself. Classify on what is actually there.

**Say so when the evidence is not there.** A bare title with no description and a dead link gives you nothing, and no amount of judgment invents the missing fact. Flag those; do not guess. A flagged row is a small, honest cost. A guessed row is a wrong number in the evidence base HR sets floor pay from.

**The canonical false match is `Rn Case Manager`**, a hospital nursing role at hospital pay, which the list already contains, mislabeled. Reading it is what makes it obvious. Clinical roles inflate a direct-care benchmark quietly rather than obviously, which is exactly why they are worth catching.

**Postings with no SBRM equivalent still belong here.** Director-level, development, and clinical-supervisor roles get `Market Reference - No SBRM Equivalent` and are kept. Filtering `SBRM Equivalent != Market Reference - No SBRM Equivalent` gives back the pure role-matched view for floor-pay work.
## `/comp-search`
### Phase 0: preflight and seed
1. Run the preflight block above.
2. Keep the Mac awake. Runs take 45 to 90 minutes.

   ```bash
   caffeinate -i -t 7200 &
   ```

   The `-t 7200` gives a two-hour ceiling that expires on its own, which matters because the PID will not survive to a later block either. Do **not** use `caffeinate -i -w $$`: each tool call gets its own short-lived shell, so `$$` exits immediately and caffeinate dies with it.

3. Initialize the database:

   ```bash
   CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
   CP_DB="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}/data/comp_research.db"
   python3 "$CP_DIR/scripts/init_db.py" --db "$CP_DB"
   ```
4. **Seed the dedup table from SharePoint.** Mandatory before any push. If you are carrying `can_push=NO`, skip this step, force `--dry-run` for the whole run, and say so plainly in the final report: `SharePoint sync was DISABLED this run (no seeder). N postings collected, 0 pushed.`

   The skill dedupes on `sharepoint_item_id IS NULL` in the local database. On a machine whose database does not yet know about the 202 rows already in the list, every posting looks new and gets pushed again. Pull the existing items and populate `sharepoint_item_id`. Match on **both link columns**: `Job Posting` (150 of 202 rows, human-entered) and `URL` (2 rows, which is where this skill's own writes land per `url_field`). Matching only `Job Posting` would miss the rows the automation itself created, so a rebuilt database would re-push exactly those. Fall back to title plus employer when neither link matches.

   `seed_from_sharepoint.py` fetches the list itself, so the normal path is one command:

   ```bash
   CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
   CP_DB="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}/data/comp_research.db"
   python3 "$CP_DIR/scripts/seed_from_sharepoint.py" --db "$CP_DB"
   ```

   To seed from a payload you already have, fetch it first and pass `--from-file`. Note `--expand '["fields"]'` is a JSON array, not a bare string, and paginate until exhausted:

   ```bash
   CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
   CP_DB="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}/data/comp_research.db"
   CP_DATA="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}"
   SITE=$(python3 "$CP_DIR/scripts/sharepoint_target.py" site_id)
   LIST=$(python3 "$CP_DIR/scripts/sharepoint_target.py" list_id)
   ms365 list-sharepoint-site-list-items --site-id "$SITE" --list-id "$LIST" \
       --expand '["fields"]' --fetch-all-pages --top 100 > "$CP_DATA/data/items.json"
   python3 "$CP_DIR/scripts/seed_from_sharepoint.py" --db "$CP_DB" \
       --from-file "$CP_DATA/data/items.json"
   ```

   **On a machine running the MCP server instead of the wrapper, `--from-file` is the only path.** The script shells out to `ms365`, so its self-fetching mode dies with `command not found`. That is not a reason to carry `can_push=NO`: call `mcp__ms365__list-sharepoint-site-list-items` yourself, write the payload to `$CP_DATA/data/items.json`, and pass it in. The script accepts the Graph response as-is, either `{"value": [...]}` or a bare array.

   Report the seed count: `Seeded N existing SharePoint items; M matched to local postings.`

   **If the seed returns zero items, stop the run.** Either auth or the list ID is wrong, and pushing on top of that would duplicate the entire list. As of 2026-08-14 the list holds 202 items, so a healthy seed reports at least that many.

5. Open a run: `INSERT INTO search_runs (run_date, triggered_by, status) VALUES (date('now'), 'manual', 'running')`
6. Parse flags: `--resume`, `--boards`, `--roles`, `--dry-run`, `--skip-archive`, `--skip-linkedin-detail`
### Phase 1: Indeed connector
For each active role, for each keyword in `search_keywords`:

1. Call `mcp__claude_ai_Indeed__search_jobs` with the keyword, `location: "Santa Barbara, CA"`, `country_code: "US"`.
2. Pipe the response into the parser:

   ```bash
   CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
   CP_DB="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}/data/comp_research.db"
   echo '<response>' | python3 "$CP_DIR/scripts/search_indeed.py" \
       --store --role-id <N> --run-id <N> --db "$CP_DB"
   ```
3. Wait 2 seconds between calls.

Expect thin results. Two or three hits per keyword is normal, zero is common. That is the connector, not a failure. Do not retry or widen the location to compensate; note the count and move on.
### Phase 2: career pages via web-research
This phase is new in 0.3.0 and is now the primary discovery path.

The orgs worth checking are the ones already in the list. The top recurring employers are Good Samaritan, CADA, Salvation Army, Path, New Beginnings, City Net, Community Solutions, Pinnacle Treatment Centers, Passages, Mercy House, and St. Vincent's.

For each org, search its careers page for the tracked roles and extract postings with pay, using `web-research`'s search and fetch scripts.

`scripts/search_org_website.py` parses and stores; it does no fetching of its own. You do the searching with `web-research` and pipe what you found into it, exactly like the board scrapers. It accepts either JSON or the same `**Field:**` block format, and tolerates the label variations career pages actually use (`Compensation`, `Pay range`, `Position`, `View job URL`).

The full target-org list and the `market_reference_keywords` that surface director-level and development roles live in `config.json` under `boards.org_website`. Sweep each org for the tracked roles **and** those keywords. The source key is `org_website` (underscore), matching `config.json` and the `--boards` flag.

```bash
CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
CP_DB="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}/data/comp_research.db"
echo '{"results": [{"title": "...", "employer": "...", "salary": "...", "location": "...", "url": "..."}]}' \
  | python3 "$CP_DIR/scripts/search_org_website.py" --store --org "<org name>" \
      --role-id <N> --run-id <N> --db "$CP_DB"
```

`--org` is what lands in `search_log`, so `--resume` skips orgs already swept. Use `--parse-only` to see what a payload parses to before storing it.

**A market-reference posting still needs a `--role-id`**, because the flag is required even though the column is nullable. Pass the role whose sweep surfaced it. That value only records provenance; the row's `SBRM Equivalent` is decided at push time in Phase 6b, and for these rows it is `Market Reference - No SBRM Equivalent`.

Rate limit: 3 seconds between fetches. Respect `robots.txt`.
### Phase 3: LinkedIn
**3a, discovery via Jina.** 3 seconds between calls.

```bash
CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
CP_DB="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}/data/comp_research.db"
python3 "$CP_DIR/scripts/search_linkedin.py" --discover --keyword "<kw>" \
    --role-id <N> --run-id <N> --db "$CP_DB"
```

**3b, detail via playwright-cli.** Skip if `--skip-linkedin-detail`.

1. Check session: `playwright-cli -s=linkedin --headed --persistent open "https://www.linkedin.com/feed/"`
2. If redirected to login, pause and have the user sign in with the SBRM role account, then confirm.
3. Fetch the top 10 most relevant detail pages per role. 7 to 10 second randomized delays.

**Verify before trusting.** These parsers infer employer and location positionally, as "the line after the title". Before storing a batch, print the first 3 parsed records and confirm employer and location look like real values rather than "Easily Apply" or "Save job". If they are wrong, stop the board and report it rather than storing garbage.
### Phase 4: ZipRecruiter, Glassdoor, Handshake
Same pattern as 3b. Same verification requirement. Honor the rate limits in `config.json`.
### Phase 5: archive
Off by default (`archive_enabled: false`) and depends on the `single-file` CLI, which is not installed. Skip.
### Phase 6: score, sync, report
**6a. Relevance scoring, batched per role.**

1. Load the role's `exclude_keywords`. Postings matching them auto-score 0.2 (`Almost Bad`) with no model call.
2. Review the remaining batch together, titles plus snippets plus employers, and assign:
   - **Good, 0.85**: title matches, duties comparable to the SBRM role
   - **Close, 0.55**: related role, different scope or setting
   - **Almost Bad, 0.2**: same title, clearly a different job
3. `UPDATE job_postings SET relevance_score = ? WHERE id = ?`

The canonical bad match to watch for: an RN Case Manager at a hospital. The list already contains one, mislabeled, at $90,000 to $105,000 against a median hourly low of $25.00 across the 45 hourly rows among the 46 carrying the `Case Manager` label ($24.50 for the 43 labelled solely that), so roughly double once annualized. The pattern is real, and note that it is double rather than triple: clinical roles inflate the benchmark quietly rather than obviously.

**6b. SharePoint sync.**

Push postings from this run with `relevance_score >= 0.4` and `sharepoint_item_id IS NULL`. Skip anything whose `location_map` value is null (remote, out of state, unknown stay in SQLite only).

Write with `ms365 create-sharepoint-list-item`. The fields go **inside** `body.fields`, not at the top level, and the body is easiest to pass on stdin so quoting does not mangle the JSON:

```bash
CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
SITE=$(python3 "$CP_DIR/scripts/sharepoint_target.py" site_id)
LIST=$(python3 "$CP_DIR/scripts/sharepoint_target.py" list_id)
ms365 create-sharepoint-list-item --stdin <<JSON
{"siteId": "$SITE", "listId": "$LIST",
 "body": {"fields": { ... the field map below ... }}}
JSON
```

On a machine running the MCP server instead, the same call is `mcp__ms365__create-sharepoint-list-item` with camelCase `siteId`, `listId`, `body`.

The field map:

```json
{
  "Title": "<posting title>",
  "Low_x002f_Only": <original_rate_low>,
  "High": <original_rate_high>,
  "PayUnit": "<Hourly|Annual|Weekly|Bi-weekly|Monthly|Not listed>",
  "Organization": "<employer>",
  "SBRMEquivalent@odata.type": "Collection(Edm.String)",
  "SBRMEquivalent": ["<canonical role title>"],
  "Credential": "<Licensed / Certified|Not required|N/A>",
  "Notes": "<description_snippet>\n\nEducation: <education_req>",
  "URL": "<source_url>",
  "Source": "<Indeed|LinkedIn|Glassdoor|ZipRecruiter|Handshake|Org-Website>",
  "For_x002d_ProfitorNon_x002d_Prof": "<For Profit|Non-Profit>",
  "Location@odata.type": "Collection(Edm.String)",
  "Location": ["<SB County|Ventura County|Other CA>"],
  "MatchStatus": "<Good|Close>"
}
```

Rules that are easy to get wrong:

- **Send the original rate, not the annualized one.** $17/hr goes in as `17`, never `35360`. `PayUnit` carries the unit. This is deliberate.
- **`PayUnit` is required on every write.** Map `salary_type` through `pay_unit_map` in `config.json`. A posting with no parseable pay writes `"Not listed"`; never write an empty `PayUnit`, and never let `biweekly` collapse to `Weekly` (they differ by a factor of two).
- **Write links to `URL`. Never touch `JobPosting`. This is settled, not open.** A live write test on 2026-08-17 tried four request shapes against the `JobPosting` hyperlink column. `POST` returned `400` and `500`; both `PATCH` shapes returned **`200 OK` with a full success payload and left the field null**. The same item accepted `Title` and `URL` in one `POST`, so the failure is specific to that column. `JobPosting` stays HR's hand-entry column with its 150 rows. Write whichever field `config.json`'s `url_field` names, which is `URL`.
- **Never trust a Graph status code. Read the field back.** The point above is the general rule, not a one-column quirk: Graph will report success and discard the value. Any write that matters is followed by a read of the same item and a compare of what actually landed.
- Multi-select fields need the `@odata.type: "Collection(Edm.String)"` annotation. This applies to `SBRMEquivalent` and `Location`. **On an update, PATCH the full array**, never a bare string: 16 rows on the live list carry two labels, and a scalar write silently discards the second.
- `SBRMEquivalent` must come from the writable vocabulary in `roles.json`: the **16 canonical titles**, plus the one non-role choice `Market Reference - No SBRM Equivalent`. Never invent a label. Fill-in text is what produced 37 variants for 16 roles in the first place.
- Match status: score >= 0.7 is `Good`, >= 0.4 is `Close`.
- Store the returned ID: `UPDATE job_postings SET sharepoint_item_id = ? WHERE id = ?`

**6c. Report.**

1. Generate the report:

   ```bash
   CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
   CP_DB="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}/data/comp_research.db"
   python3 "$CP_DIR/scripts/report.py" --run-id <N> --db "$CP_DB"
   ```
2. Show the report, then the sync stats: `Pushed X postings (Y Good, Z Close, W skipped as Almost Bad)`
3. `UPDATE search_runs SET status = 'completed', completed_at = datetime('now') WHERE id = <N>`
## Before you deliver the run: verification pass
Re-read this section and check the run against it. Report any line that fails.

- [ ] The SharePoint seed ran and reported at least 202 items, or is N/A because `can_push=NO`.
- [ ] Every pushed row has a `PayUnit`, including `"Not listed"` where pay was unparseable, and no `biweekly` was written as `Weekly`.
- [ ] Every pushed `SBRMEquivalent` is one of the 16 canonical titles or `Market Reference - No SBRM Equivalent`. No `Program Tech`, no `Tech`, no `RTS no license`.
- [ ] Every pushed row was **read back** and its fields compared against what was sent. A `200` is not evidence.
- [ ] Nothing was written to `JobPosting`.
- [ ] Rows the evidence could not resolve were flagged for a human, not guessed into a role.
- [ ] No pushed row has a pay figure that looks like a retirement plan (values near 401000 or 403000 mean the `401k` parsing bug bit).
- [ ] For each browser board, the first 3 parsed records had a plausible employer and location.
- [ ] Boards that were skipped were named in the report, not silently dropped.
- [ ] The run's new-row count is plausible. A first run pushing 100+ rows almost certainly means the seed failed and you are duplicating the list.
## Resume
With `--resume`: find the newest run with status `running` or `interrupted`, read `search_log` for completed (role, board, keyword) combinations, and skip them.
## Calibration
Role matching has still not been validated at scale. Treat the first 2 to 3 runs as calibration and report findings each time:

- Scored `Good` but clearly wrong → add terms to `exclude_keywords`
- Good matches being filtered out → the exclude list is too aggressive
- Landing on the wrong SBRM role → refine `search_keywords` or `description_summary`

Generic titles are the weak spot: Manager, Associate, Custodian, Night Security.

After editing `roles.json`:

```bash
CP_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
CP_DB="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}/data/comp_research.db"
python3 "$CP_DIR/scripts/init_db.py" --load-roles "$CP_DIR/roles/roles.json" --db "$CP_DB"
```
 The loader matches on title and updates in place, so repeated loads are safe.
## Error handling
- A board that fails entirely: log it, name it in the report, continue with the others.
- A Playwright session that expires mid-run: checkpoint, then guide the user through re-login.
- Python errors: catch and report in plain English. Technical detail goes to `logs/comp_search.log`.
- A run counts as successful if at least 2 boards returned results and at least one had pay data.

Never substitute a degraded result for what was asked. If coverage was partial, say so explicitly.
