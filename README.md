---
title: SBRM Claude Toolkit
short-title: SBRM Claude Toolkit README
description: Distributable Claude Code plugin of skills and commands for SBRM staff
updated: 2026-08-21
status: active
---

# SBRM Claude Toolkit
A Claude Code plugin for Santa Barbara Rescue Mission staff. It bundles the skills and slash commands we use for writing, analysis, reporting, and AI-quality discipline, sanitized for general use.
## What's included
### Skills
| Skill | What it does |
|---|---|
| humanizer | Removes signs of AI-generated writing (67 documented patterns) so text reads as natural and human-written |
| nonprofit-ops-coach | Evidence-based operations guidance for anyone on the operations team in a nonprofit shelter + residential treatment context ($5M budget, ~200 daily census): board briefs, cash forecasts, rubrics, policies |
| markdown-linter | Validates and auto-fixes markdown formatting (spacing, tables, headings, syntax); includes runnable scripts |
| coding-protocols | Coding discipline: red-green TDD, plan-before-code, root-cause debugging, no placeholders, verify before claiming done |
| anthropic-docs | Finds the right page in Anthropic's official documentation: plans, seats, billing, usage limits, Projects, org administration and SSO (Help Center), data training and retention (Privacy Center), legal/status/pricing, plus the Claude API and Claude Code developer docs |
| non-coding-protocols | 4-phase workflow (Scope, Execute, Review, Deliver) for substantial non-coding tasks, with planning briefs and self-review |
| sbrm-notion | Map and conventions for the SBRM Notion workspace: what lives in each database, naming/status conventions, and safe-editing rules for the Notion connector |
| documenso | Using SBRM's self-hosted e-signature service at sign.sbrmapps.com: getting access, creating your own API key, and driving documents through the API (upload a PDF, place fields, send for signing, download the signed file and certificate) |
| web-research | Layered web search and fetching beyond the built-in tools: Tavily API (paid, if key set) plus free fallbacks (DuckDuckGo search, Jina Reader fetch) |
| competitor-pay | Competitive pay research for HR: sweeps local nonprofit career pages and job boards for postings with pay, matches them to SBRM's 16 tracked roles, and syncs the good ones to the "Competitor's Pay" SharePoint list HR uses to set floor pay. Needs extra setup (see below) |

### Commands
| Command | What it does |
|---|---|
| /prompt | Turns a rough idea into a well-crafted prompt |
| /interview | Extracts specifics, stories, and numbers through targeted questions before drafting |
| /analyze | Structured analysis document |
| /report | Structured report document |
| /sheet | Builds a spreadsheet deliverable (uses the xlsx skill when available, falls back to Python/CSV) |
| /policy | Drafts an organizational policy |
| /write | Multi-angle drafting: three materially different drafts, then synthesis |
| /new-slash-command | Creates a new Claude Code slash command |
| /comp-setup | One-time setup for the competitor-pay skill: dependencies, database, Microsoft 365 sign-in, browser sessions |
| /comp-search | Runs the competitive pay research and syncs qualifying results to SharePoint |

## Install (Claude Code)
1. Add the marketplace:

   ```
   /plugin marketplace add sbrm-org/sbrm-claude-toolkit
   ```

2. Install the plugin:

   ```
   /plugin install sbrm-toolkit@sbrm-claude-toolkit
   ```

Skills load automatically when relevant; commands are available as `/prompt`, `/write`, etc.
## Extra setup: competitor-pay
Everything else in this plugin works the moment it is installed. `competitor-pay` does not, because it writes to a Microsoft 365 SharePoint list and this repository is public, so the list's address is not committed here.

After installing the plugin, run `/comp-setup` in Claude Code and follow it. It walks through the whole thing one step at a time and assumes no technical background. Two items it cannot get for you:

- **The list address.** Ask Tim for the `site_id` and `list_id`, then save them as `~/.competitor-pay/config.local.json`:

  ```json
  {"sharepoint": {"site_id": "...", "list_id": "..."}}
  ```

  Nothing else in the skill reads the address directly, so this one file is the whole configuration.

- **Microsoft 365 access.** `/comp-setup` step 4 handles the sign-in. On a machine without the `ms365` command it falls back to the Microsoft 365 MCP server, which Claude Code can add for you.

Run `/comp-search --dry-run` first. A real run takes 45 to 90 minutes and opens browser windows as it goes, which is normal.
## Using skills on claude.ai (no Claude Code needed)
The `claude-ai-zips/` folder contains upload-ready zips of the skills most useful in plain claude.ai chat: `humanizer`, `nonprofit-ops-coach`, `non-coding-protocols`, `sbrm-notion`, and `anthropic-docs`.

To install one: on claude.ai go to **Settings > Capabilities > Skills** and upload the zip. The skill then activates automatically in your chats when relevant.
## Notes
- All content has been sanitized for distribution: no internal paths, credentials, or personal infrastructure references.
- Maintained by Tim Molloy. Report issues or suggestions directly.
