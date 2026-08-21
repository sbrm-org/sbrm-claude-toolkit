---
name: comp-search
description: Run competitive pay research across job boards and nonprofit career pages, then sync qualifying results to the Competitor's Pay SharePoint list
argument-hint: "[--dry-run] [--resume] [--boards indeed,org_website] [--roles 'Case Manager - Homeless Services'] [--skip-archive] [--skip-linkedin-detail]"
allowed-tools: Bash(python3:*), Bash(uv:*), Bash(playwright-cli:*), Bash(sqlite3:*), Bash(caffeinate:*), Bash(mkdir:*), Bash(command:*), Bash(echo:*), Bash(ms365:*), Read, Write, mcp__claude_ai_Indeed__search_jobs, mcp__claude_ai_Indeed__get_job_details
model: inherit
created: 2026-04-14
updated: 2026-08-21
---

> Follow the `competitor-pay` skill for the authoritative procedure. In particular: run the
> preflight, seed the dedup table from SharePoint before any push, write `PayUnit` on every
> row, and read every write back before believing it. This file is the command entry point,
> not the spec.
>
> `delete-sharepoint-list-item` is deliberately NOT in `allowed-tools`. This command only ever
> adds and updates rows. Deletions on a shared HR list go through Tim.

# Competitor Pay Search
Run the monthly competitive pay research for SBRM.
## Instructions
1. Load the skill definition from `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/skills/competitor-pay/SKILL.md`
2. Load the `mcp2cli` skill before the first Microsoft 365 call. It carries the `ms365` subcommand syntax, the JSON parsing rules, and the auth-failure runbook.
3. Follow the phases exactly as described in SKILL.md
4. Parse any arguments passed by the user
5. Report progress after each role completes
6. Generate the run report at the end (`report.py`; see SKILL.md Phase 6c)
## Arguments
- `--resume`: Continue an interrupted run
- `--boards indeed,org_website,linkedin,ziprecruiter,glassdoor,handshake`: Comma-separated list of sources to search (default: all enabled). `org_website` is the career-page sweep via `web-research`, and is the highest-yield source.
- `--roles "Case Manager - Homeless Services,Custodian"`: Comma-separated list of role titles to search (default: all active)
- `--dry-run`: Show what would be searched without making any requests
- `--skip-archive`: Skip the SingleFile archiving step
- `--skip-linkedin-detail`: Skip LinkedIn Playwright detail pages (Jina discovery only)
## Important
- Always run `caffeinate -i -t 7200 &` to prevent Mac sleep during the run. Do **not** use `caffeinate -i -w $$`; the tool shell exits immediately and takes caffeinate with it.
- Never push to SharePoint without first seeding the dedup table (see SKILL.md Phase 0 step 4). If `seed_from_sharepoint.py` is absent, force `--dry-run`.
- **Microsoft 365 goes through the `ms365` CLI wrapper**, never a re-added MCP server. The wrapper exits 0 on auth failure and puts the error in the payload, so check for an `error` key rather than trusting the exit code.
- **Never write the `JobPosting` column.** A live test on 2026-08-17 proved Graph returns `200 OK` and silently discards the value. Links go in `URL`.
- **`SBRM Equivalent` is multi-select.** PATCH the full array with the `Collection(Edm.String)` annotation. A scalar write discards a second label.
- Classify postings into roles by reading them. There is no keyword table, and you should not build one (SKILL.md, "Classifying a posting into a role"). Flag rows the evidence cannot resolve rather than guessing.
- Respect rate limits between requests (see config.json)
- If a Playwright session expires, guide the user through re-login
- Report errors in plain English, not Python tracebacks
- Save checkpoint data so `--resume` works if interrupted
