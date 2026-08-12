---
description: Orchestrate HR/operational policy creation with structured protocol
argument-hint: "[!quick|!full] [topic]"
allowed-tools: Read, Write, Edit, Bash(mkdir:*), WebSearch, WebFetch
model: inherit
created: 2026-02-12
---

# /policy -- Policy Drafting Orchestrator

You are drafting an HR or operational policy using the non-coding protocols system.

## Quick Reference Checklist

- [ ] Identify policy topic from `$ARGUMENTS`
- [ ] Detect mode: `!quick` (skip scope/review), `!full` (force all phases + full audit), or default
- [ ] Load protocol: the non-coding-protocols skill's `protocols/hr-policy.md`
- [ ] Run all 4 phases (or subset per mode)
- [ ] Save to a working folder or the project directory
- [ ] Provide the file path

## Mode Detection

Parse `$ARGUMENTS`:
- Starts with `!quick` --> Skip Scope and Review phases. Draft directly.
- Starts with `!full` --> Force all 4 phases. Show full audit trail in Review.
- Neither --> Default mode. Run all 4 phases with silent gating (only show Review failures).

## Workflow

### Phase 1: Scope

1. Read the hr-policy protocol for scoping questions
2. Ask 3-5 targeted questions OR state reasonable defaults based on the topic
3. Present the 6-field planning brief:

```
Audience: [who receives this]
Deliverable: HR/Operational Policy
Decision/Goal: [what this enables]
Constraints: [jurisdiction, timeline, format]
Assumptions: [what I'm assuming]
Success criteria: [how the user knows this is done right]
```

4. Wait for the user's approval before proceeding

### Phase 2: Execute

1. Load the hr-policy protocol template
3. If topic involves compliance/regulatory claims: research first (web search for authoritative sources)
4. Generate policy following all 12 required sections from the protocol
5. Include version block at top
6. Match the user's voice and register

### Phase 3: Review

Run acceptance tests from hr-policy protocol:
- All 12 sections present and non-empty?
- Jurisdiction stated?
- "Consult counsel" flags for liability items?
- Version/date block present?
- Implementation checklist with concrete items?
- Regulatory references with statute numbers?
- No unsourced regulatory claims?

**Default mode**: Only report failures as a "Flags" block at the end.
**`!full` mode**: Report all test results + full critique (assumptions, gaps, risks, counterarguments).

### Phase 4: Deliver

1. Save to a working folder or the project directory (e.g. `./YYYY-MM-DD-{policy-slug}.md`)
   - For `!full` mode: consider a dedicated project subfolder if substantial
2. Provide the file path
3. Suggest next steps: legal review, board approval, staff training, etc.
