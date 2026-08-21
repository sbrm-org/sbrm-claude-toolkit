---
name: comp-setup
description: One-time setup for the competitor-pay skill (dependencies, database, Microsoft 365 auth, browser logins)
argument-hint: "[--update]"
allowed-tools: Bash(claude:*), Bash(python3:*), Bash(uv:*), Bash(npm:*), Bash(npx:*), Bash(brew:*), Bash(which:*), Bash(command:*), Bash(node:*), Bash(sqlite3:*), Bash(playwright-cli:*), Bash(curl:*), Bash(mkdir:*), Bash(echo:*), Bash(ms365:*), Read, Write, mcp__claude_ai_Indeed__search_jobs
model: inherit
created: 2026-04-14
updated: 2026-08-21
---

# Competitor Pay Setup
Walk the user through setting up the competitor-pay skill. Assume zero technical knowledge, go one step at a time, and wait for confirmation before moving on.
## Steps
### 1. Check dependencies
```bash
which python3         # Python 3.10+
which node            # Node.js
which uv              # Python package runner
which claude          # Claude Code CLI
which playwright-cli  # Browser automation (needed for LinkedIn, ZipRecruiter, Glassdoor)
command -v ms365      # Microsoft 365 CLI wrapper
```

For anything missing, explain what it is in plain language and give the install command. `single-file` is NOT needed; archiving is disabled.
### 2. Create the data directory and initialize the database
The database must live **outside** the skill directory. When the skill is installed as a plugin, that directory is replaced wholesale on every update, and the database holds `sharepoint_item_id`, the only thing preventing duplicate rows being pushed to SharePoint.

```bash
SKILL_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
CP_DATA="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}"
mkdir -p "$CP_DATA/data" "$CP_DATA/logs"
python3 "$SKILL_DIR/scripts/init_db.py" --db "$CP_DATA/data/comp_research.db"
python3 "$SKILL_DIR/scripts/init_db.py" --load-roles "$SKILL_DIR/roles/roles.json" \
    --db "$CP_DATA/data/comp_research.db"
```

### 3. Verify the roles loaded
```bash
CP_DATA="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}"
sqlite3 "$CP_DATA/data/comp_research.db" "SELECT count(*) FROM roles WHERE active = 1"
```

**This must return 16.** Then check the total as well, because `load_roles` deactivates all roles before loading, so a carried-over database still reports 16 *active* while holding stale extras:

```bash
CP_DATA="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}"
sqlite3 "$CP_DATA/data/comp_research.db" "SELECT count(*) FROM roles"
```

This must also return 16. A larger total means roles from an older install are still present; stop and escalate to Tim.

**A database built before 2026-08-17 will show 16 active roles that are still the old set.** Check for the three that changed: `Program Tech` must be gone, and `Case Manager Unlicensed - Treatment Services` must be present. If the old set is still there, the `--load-roles` step above did not run.

```bash
CP_DATA="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}"
sqlite3 "$CP_DATA/data/comp_research.db" \
  "SELECT title FROM roles WHERE title IN ('Program Tech','Case Manager Unlicensed - Treatment Services')"
```

Then show the full list and ask whether any roles are missing:

```bash
CP_DATA="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}"
sqlite3 "$CP_DATA/data/comp_research.db" \
  "SELECT id, title, department FROM roles WHERE active = 1 ORDER BY department, title"
```

Note that `Market Reference - No SBRM Equivalent` is deliberately **not** among the 16. It is a writable choice on the SharePoint column for postings with no SBRM equivalent, not a role this tool searches for. It lives under `sbrm_equivalent_extra_choices` in `roles.json`.
### 4. Connect Microsoft 365
Use the `ms365` CLI wrapper. Load the `mcp2cli` skill first for the subcommand syntax and auth runbook.

```bash
ms365 verify-login
```

If that fails, run `ms365 login`. It prints a device code; have the user open `https://login.microsoft.com/device`, enter the code, and sign in with the SBRM account that has access to the HR site. Then re-run `ms365 verify-login` to confirm.

**Do not re-add the `@softeria/ms-365-mcp-server` MCP server on a machine that has the wrapper.** The resident MCP servers were removed deliberately to reclaim idle RAM. Only fall back to the MCP server on a machine where the wrapper genuinely is not installed.

Verify the site resolves, then confirm the list itself returns roughly 202 items:

```bash
SKILL_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
SITE=$(python3 "$SKILL_DIR/scripts/sharepoint_target.py" site_id)
LIST=$(python3 "$SKILL_DIR/scripts/sharepoint_target.py" list_id)
ms365 get-sharepoint-site --site-id "$SITE" --account sbrmappadmin@sbrm.org
ms365 list-sharepoint-site-list-items --site-id "$SITE" --list-id "$LIST" \
    --expand '["fields"]' --fetch-all-pages --top 100 \
    --account sbrmappadmin@sbrm.org | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('value',[])),'items')"
```

The CLI takes kebab-case `--site-id` / `--list-id`; `config.json` stores the same values under snake_case; the MCP tools want camelCase. Using the wrong spelling fails schema validation.

**If those commands fail saying no site_id is configured**, the install has no local target file yet. This repo is public, so the committed `config.json` ships placeholders. Create `~/.competitor-pay/config.local.json` with the real values, which Tim can supply:

```json
{"sharepoint": {"site_id": "...", "list_id": "..."}}
```

**If the list returns 0 items, stop.** Either auth or the list ID is wrong, and running a search on top of that would create duplicates. Note the wrapper exits 0 on auth failure and returns `{"error": ...}`, so an empty result is not proof the list is empty.
### 5. Check the Indeed connector
Call `mcp__claude_ai_Indeed__search_jobs` with `search="case manager"`, `location="Santa Barbara, CA"`, `country_code="US"`.

**Expect only 2 or 3 results, and expect zero on narrower queries.** This connector is a thin curated feed, not full Indeed search. A small result count is correct behavior, not a broken install. Only escalate if no Indeed tool exists at all.
### 6. Check web-research
Confirm the `web-research` skill is available. It ships with the SBRM toolkit and handles career-page fetching, which is the highest-yield source. Do **not** use the `web-access` skill; it depends on Tim's private network and will not work here.
### 7. Set up browser sessions
These must use an **SBRM role account, never the user's personal profile.** Automated collection behind a login breaches these sites' terms, and that exposure belongs to an account the org controls.

**Two of these need a shared SBRM account that may not exist yet.** Glassdoor is `login_required: true` in `config.json`, and LinkedIn's salary detail pass needs an authenticated Playwright session. Without both accounts, those two boards return little or no salary data. If the user does not have credentials for a shared SBRM Glassdoor and LinkedIn account, that is a prerequisite to raise with Tim, not something to work around with a personal login.

LinkedIn:

1. `playwright-cli -s=linkedin --headed --persistent open "https://www.linkedin.com/login"`
2. Tell the user a browser window will open and they should log in, entering a verification code if asked.
3. Wait for confirmation, then verify with `playwright-cli -s=linkedin snapshot` and look for profile indicators.

Glassdoor: same flow against `https://www.glassdoor.com/profile/login_input.htm`.

Handshake: ask first; it is disabled by default and mostly carries student roles.

ZipRecruiter needs no login.
### 8. Confirm both sync preconditions before anything runs live
Two independent gates, and sync requires **both**:

1. **The duplicate guard.** Does `scripts/seed_from_sharepoint.py` exist inside the skill directory (`${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay`)? Without it a sync pushes duplicates of postings already among the 202 rows.
2. **The required columns.** Check the list has `PayUnit` and `Credential`, and that `SBRM Equivalent` is still multi-select with fill-in text off:

   ```bash
   SKILL_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
   SITE=$(python3 "$SKILL_DIR/scripts/sharepoint_target.py" site_id)
   LIST=$(python3 "$SKILL_DIR/scripts/sharepoint_target.py" list_id)
   ms365 list-sharepoint-list-columns --site-id "$SITE" --list-id "$LIST" \
       --account sbrmappadmin@sbrm.org --fetch-all-pages
   ```

   Every write makes `PayUnit` mandatory, so until it exists each write errors.

If **either** fails, tell the user plainly: collection and reporting still work, but SharePoint sync stays off and every run needs `--dry-run` until Tim clears it.
### 9. Done
Tell the user:

- Setup is complete. Start with `/comp-search --dry-run` to see what a run would do.
- A full run takes 45 to 90 minutes. Leave the Terminal window open.
- Browser windows opening mid-run is normal.
- The first two or three real runs are calibration. Finding postings matched to the wrong role is expected, and worth reporting to Tim rather than fixing silently.
## Updating
If the user runs `/comp-setup --update`:

1. Update the plugin through `/plugin update`, not `git pull`. The skill ships as part of the SBRM toolkit marketplace plugin, so the skill directory is managed for them.
2. Reload the roles, which is safe to repeat because the loader matches on title and updates in place:

   ```bash
   SKILL_DIR="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay"
   CP_DATA="${COMPETITOR_PAY_HOME:-$HOME/.competitor-pay}"
   python3 "$SKILL_DIR/scripts/init_db.py" --load-roles "$SKILL_DIR/roles/roles.json" \
       --db "$CP_DATA/data/comp_research.db"
   ```

   `SKILL_DIR` is re-derived here on purpose. Each Bash call runs in a fresh shell, so a variable

   set back in step 2 is empty by the time this block runs.

3. Re-verify the role count is still 16, re-run the `Program Tech` check from step 3, and re-check dependencies.

**Schema upgrades are automatic, but they are the only thing that is.** `init_db.py` carries versioned migrations (`SCHEMA_VERSION`, currently 3) and applies any it needs when run against an older database. It does **not** reload roles, so a plugin update that changes `roles.json` still needs step 2 above. A change the migrations do not cover is a code change, not something this command performs.
