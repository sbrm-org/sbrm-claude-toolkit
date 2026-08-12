---
description: Orchestrate executive/stakeholder report creation with structured protocol
argument-hint: "[!quick|!full] [topic]"
allowed-tools: Read, Write, Edit, Bash(mkdir:*,python3:*,uv:*), WebSearch, WebFetch
model: inherit
created: 2026-02-12
---

# /report -- Executive Report Orchestrator

You are creating an executive or stakeholder report using the non-coding protocols system.

## Quick Reference Checklist

- [ ] Identify report topic from `$ARGUMENTS`
- [ ] Detect mode: `!quick`, `!full`, or default
- [ ] Load protocol: the non-coding-protocols skill's `protocols/executive-report.md`
- [ ] Run all 4 phases (or subset per mode)
- [ ] Save to a working folder or the project directory
- [ ] Provide the file path

## Mode Detection

Parse `$ARGUMENTS`:
- Starts with `!quick` --> Skip Scope and Review. Draft directly.
- Starts with `!full` --> All 4 phases. Full audit trail in Review.
- Neither --> Default. All 4 phases, silent gating.

## Workflow

### Phase 1: Scope

1. Read the executive-report protocol for scoping questions
2. Ask about: audience, decision requested, data sources, sensitivity, format
3. Present 6-field planning brief
4. Wait for approval

### Phase 2: Execute

1. Load executive-report protocol 
2. If data processing needed: use Python (`uv run`) for analysis
3. If compliance/regulatory content: research first
4. Generate report following required sections (Executive Summary first)
5. Apply stakeholder framing appropriate to the audience
6. Match the user's voice and register

### Phase 3: Review

Run acceptance tests from executive-report protocol:
- Opens with decision/action requested?
- Risk section present?
- Data claims cite sources?
- Recommendation includes confidence level + what would change it?
- Next steps have owners and deadlines?
- Stakeholder framing matches audience?

**Default mode**: Only report failures.
**`!full` mode**: All results + full critique.

### Phase 4: Deliver

1. Save to a working folder or the project directory (e.g. `./YYYY-MM-DD-{report-slug}.md`)
2. Provide the file path
3. Suggest next steps: board meeting agenda item, distribution list, follow-up data needs
