---
title: SBRM Claude Toolkit
short-title: SBRM Claude Toolkit README
description: Distributable Claude Code plugin of skills and commands for SBRM staff
updated: 2026-08-12
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
| web-research | Layered web search and fetching beyond the built-in tools: Tavily API (paid, if key set) plus free fallbacks (DuckDuckGo search, Jina Reader fetch) |

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

## Install (Claude Code)

1. Add the marketplace (replace `sbrm-org` with the actual org/user once published):

   ```
   /plugin marketplace add sbrm-org/sbrm-claude-toolkit
   ```

2. Install the plugin:

   ```
   /plugin install sbrm-toolkit@sbrm-claude-toolkit
   ```

Skills load automatically when relevant; commands are available as `/prompt`, `/write`, etc.

## Using skills on claude.ai (no Claude Code needed)

The `claude-ai-zips/` folder contains upload-ready zips of the skills most useful in plain claude.ai chat: `humanizer`, `nonprofit-ops-coach`, `non-coding-protocols`, `sbrm-notion`, and `anthropic-docs`.

To install one: on claude.ai go to **Settings > Capabilities > Skills** and upload the zip. The skill then activates automatically in your chats when relevant.

## Notes

- All content has been sanitized for distribution: no internal paths, credentials, or personal infrastructure references.
- Maintained by Tim Molloy. Report issues or suggestions directly.
