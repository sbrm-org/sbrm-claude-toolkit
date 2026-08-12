# Protocol: Executive / Stakeholder Report

## Scoping Questions

Ask these before drafting (or state reasonable defaults if context is clear):

1. **Primary audience?** Board, executive team, funders, regulators, staff?
2. **Decision or action requested?** What should the reader do after reading this?
3. **Data sources?** What data/metrics should be included? Where does it live?
4. **Sensitivity?** Confidential, internal-only, or shareable externally?
5. **Format constraints?** Length limit, template to match, presentation context (meeting packet, standalone)?

**Default assumptions (board audience, decision-oriented, 1-3 pages, internal-only).**

## Required Sections (in order)

1. **Executive Summary** -- Decision/action requested in first sentence. 3-5 bullet summary of key points. This section must stand alone.
2. **Background** -- Context the reader needs. Brief; assume informed audience unless scoping says otherwise.
3. **Current State** -- Data, metrics, status. Cite sources. Use tables for comparisons.
4. **Analysis** -- Interpretation of data. What does it mean? What are the implications?
5. **Options / Recommendations** -- Numbered options with pros/cons, or a single recommendation with rationale. Include confidence level ("High confidence based on..." or "Moderate confidence -- would increase with...").
6. **Risks** -- What could go wrong. Likelihood and impact. Mitigation strategies.
7. **Next Steps** -- Specific actions with owners and deadlines.
8. **Appendices** (if needed) -- Supporting data, detailed tables, methodology notes.

## Stakeholder Framing

| Audience | Lead With | Emphasize | Avoid |
|---|---|---|---|
| Board | Decision/action requested | Fiduciary duty, risk, strategic alignment | Operational minutiae |
| Staff | Impact on their work | Timeline, what changes, support available | Jargon, unexplained acronyms |
| Funders | Outcomes and impact | ROI, metrics, mission alignment | Internal process details |

## Acceptance Tests (Definition of Done)

- [ ] Opens with decision/action requested (not background or context)
- [ ] Risk section present and non-empty
- [ ] Every data claim cites its source (internal report, database, external study)
- [ ] Recommendation includes confidence level AND what would change it
- [ ] Next steps have owners and deadlines (not just "follow up on X")
- [ ] No orphaned acronyms (all defined on first use)
- [ ] Stakeholder framing matches identified audience
- [ ] Financial figures include time period and comparison basis

## Common Pitfalls

- Burying the ask -- putting the decision request on page 2 instead of sentence 1
- Risk section that only lists risks without mitigation strategies or likelihood
- Recommendations without confidence levels (makes everything sound equally certain)
- Data without dates (is this current? Last quarter? Last year?)
- Next steps without owners (everyone assumes someone else will do it)
- Including too much background for an informed audience

## Skeleton

```markdown
## Executive Summary

**Action Requested:** [One sentence: what the reader should decide or do]

- [Key point 1]
- [Key point 2]
- [Key point 3]

## Background

[2-3 paragraphs of context]

## Current State

| Metric | Current | Prior Period | Change |
|---|---|---|---|
| [Metric] | [Value] | [Value] | [+/-] |

*Source: [data source, date range]*

## Analysis

[Interpretation and implications]

## Recommendations

**Recommendation:** [Specific action]
**Confidence:** [High/Moderate/Low] -- based on [evidence]. Would increase with [additional data/analysis].

**Alternatives considered:**
1. [Option] -- [pros/cons]
2. [Option] -- [pros/cons]

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| [Risk] | [H/M/L] | [H/M/L] | [Strategy] |

## Next Steps

- [ ] [Action] -- [Owner] -- [Deadline]
```
