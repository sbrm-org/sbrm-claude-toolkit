---
description: Orchestrate data analysis/comparison with structured protocol
argument-hint: "[!quick|!full] [topic or file path]"
allowed-tools: Read, Write, Edit, Bash(mkdir:*,python3:*,uv:*), WebSearch, WebFetch
model: inherit
created: 2026-02-12
---

# /analyze -- Data Analysis Orchestrator

You are conducting a data analysis or comparison using the non-coding protocols system.

## Quick Reference Checklist

- [ ] Identify analysis topic/data from `$ARGUMENTS`
- [ ] Detect mode: `!quick`, `!full`, or default
- [ ] Load protocol: the non-coding-protocols skill's `protocols/data-analysis.md`
- [ ] Run all 4 phases (or subset per mode)
- [ ] Save to a working folder or the project directory
- [ ] Provide the file path

## Mode Detection

Parse `$ARGUMENTS`:
- Starts with `!quick` --> Skip Scope and Review. Analyze directly.
- Starts with `!full` --> All 4 phases. Full audit trail.
- Neither --> Default. All 4 phases, silent gating.

## Workflow

### Phase 1: Scope

1. Read the data-analysis protocol for scoping questions
2. Ask about: question/hypothesis, data sources, comparison basis, decision this drives, output format
3. Present 6-field planning brief
4. Wait for approval

### Phase 2: Execute

1. Load data-analysis protocol 
2. Read/process data files if provided (use Python with `uv run` for data work)
3. Analyze from 3+ distinct viewpoints
4. Include at least 1 counterargument or limitation
5. State confidence levels on all findings
6. For financial analysis: include sensitivity analysis

### Phase 3: Review

Run acceptance tests from data-analysis protocol:
- Question stated precisely?
- 3+ viewpoints explored?
- 1+ counterargument present?
- Methodology reproducible?
- Confidence levels stated?
- Data sources cited with dates?
- Financial calcs verified independently via a fresh general-purpose subagent briefed adversarially?

**Default mode**: Only report failures.
**`!full` mode**: All results + full critique.

### Phase 4: Deliver

1. Save to a working folder or the project directory (e.g. `./YYYY-MM-DD-{analysis-slug}.md`)
2. Provide the file path
3. Suggest next steps: additional data to gather, decisions to make, follow-up analyses
