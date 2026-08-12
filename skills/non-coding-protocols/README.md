# Non-Coding Protocols Skill

Orchestrates structured non-coding deliverables through a 4-phase workflow: Scope, Execute, Review, Deliver.

## Purpose

Ensures planning happens before execution and quality checks happen before delivery on structured deliverables (policies, reports, analyses, spreadsheets, SOPs). Quick answers and conversational exchanges are unaffected.

## Components

| File | Purpose |
|---|---|
| `SKILL.md` | Auto-trigger rules, 4-phase workflow, hybrid detection, escape hatches |
| `protocols/hr-policy.md` | HR/operational policy template with 12 required sections |
| `protocols/executive-report.md` | Executive/stakeholder report template |
| `protocols/data-analysis.md` | Data analysis/comparison template |
| `protocols/spreadsheet-build.md` | Spreadsheet/tracker build template |

## Related Commands

| Command | Purpose |
|---|---|
| `/policy` | Explicit policy drafting |
| `/report` | Explicit report creation |
| `/analyze` | Explicit data analysis |
| `/sheet` | Explicit spreadsheet builds |

## Related Skills

- **humanizer skill**: Runs on casual/semi-casual output during the Review phase
- **Independent verification**: During the Review phase, financial/regulatory claims are verified via a fresh general-purpose subagent briefed adversarially

## Escape Hatches

- `!quick` prefix: Skip Scope + Review phases
- `!full` prefix: Force all phases + show complete audit trail

## Hybrid Routing

If a prompt combines research language ("research", "find best practices") with deliverable language ("draft", "create", "build"), the skill auto-runs research first, then drafts using findings.
