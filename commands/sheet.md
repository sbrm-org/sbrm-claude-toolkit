---
description: Orchestrate spreadsheet/tracker builds with structured protocol
argument-hint: "[!quick|!full] [topic]"
allowed-tools: Read, Write, Edit, Bash(mkdir:*,python3:*,uv:*)
model: inherit
created: 2026-02-12
---

# /sheet -- Spreadsheet Build Orchestrator

You are building a spreadsheet, tracker, or budget template using the non-coding protocols system. Uses the `document-skills:xlsx` plugin for Excel file creation.

## Quick Reference Checklist

- [ ] Identify spreadsheet purpose from `$ARGUMENTS`
- [ ] Detect mode: `!quick`, `!full`, or default
- [ ] Load protocol: the non-coding-protocols skill's `protocols/spreadsheet-build.md`
- [ ] Run all 4 phases (or subset per mode)
- [ ] Use `document-skills:xlsx` for file creation
- [ ] Save .xlsx to a working folder or the project directory
- [ ] Provide the file path

## Mode Detection

Parse `$ARGUMENTS`:
- Starts with `!quick` --> Skip Scope and Review. Build directly.
- Starts with `!full` --> All 4 phases. Full audit trail.
- Neither --> Default. All 4 phases, silent gating.

## Workflow

### Phase 1: Scope

1. Read the spreadsheet-build protocol for scoping questions
2. Ask about: what it tracks, who uses it, input method, update frequency, output needs
3. Present 6-field planning brief
4. Wait for approval

### Phase 2: Execute

1. Load spreadsheet-build protocol 
2. Define schema first: every column with name, type, constraints, example
3. Design formulas with plain-language explanations
4. Set up validation rules for every input column
5. Build using `document-skills:xlsx` plugin
6. Include Instructions tab and sample data row

### Phase 3: Review

Run acceptance tests from spreadsheet-build protocol:
- Schema documented?
- Validation rules on every input column?
- Instructions tab present?
- Sample data row included?
- Formulas explained in plain language?
- Input cells visually distinct from calculated cells?

**Default mode**: Only report failures.
**`!full` mode**: All results + full critique.

### Phase 4: Deliver

1. Save .xlsx to a working folder or the project directory (e.g. `./YYYY-MM-DD-{sheet-slug}.xlsx`)
2. Provide the file path and any documentation
3. Suggest next steps: test with real data, share with team, set up update schedule
