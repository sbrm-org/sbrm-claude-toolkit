# Protocol: Data Analysis / Comparison

## Scoping Questions

Ask these before analyzing (or state reasonable defaults if context is clear):

1. **What question are we answering?** Specific hypothesis or open exploration?
2. **Data sources?** Files, databases, web research, manual input? Where does the data live?
3. **Comparison basis?** Time periods, peer organizations, benchmarks, scenarios?
4. **Decision this drives?** What will you do differently based on the findings?
5. **Output format?** Summary in chat, saved file, spreadsheet, presentation-ready?

**Default assumptions (decision-oriented analysis, saved markdown output, nonprofit operational context).**

## Required Sections (in order)

1. **Question / Hypothesis** -- What we're investigating, stated precisely
2. **Data Sources** -- Where data came from, date ranges, known limitations
3. **Methodology** -- How the analysis was conducted. Plain language, reproducible.
4. **Findings** -- Results organized by theme or significance. Use tables and specific numbers.
5. **Limitations** -- What the data can't tell us. Sample size issues, confounding factors, missing data.
6. **Recommendations** -- What to do based on findings. Include confidence level.

## Analysis Standards

- **Multiple angles**: Examine from 3+ distinct viewpoints or data angles
- **Counterarguments**: Include 1+ counterargument or alternative interpretation
- **Confidence levels**: State confidence on every finding ("High confidence" / "Moderate -- limited by..." / "Low -- directional only")
- **Sensitivity analysis**: For financial analyses, show what happens if key assumptions change by +/- 10-20%
- **Comparisons**: Use consistent units, time periods, and denominators across all comparisons

## Acceptance Tests (Definition of Done)

- [ ] Question/hypothesis stated precisely (not vague "look into X")
- [ ] 3+ distinct viewpoints or data angles explored
- [ ] 1+ counterargument or limitation explicitly stated
- [ ] Methodology described in enough detail to reproduce
- [ ] Confidence level stated on findings and recommendations
- [ ] Data sources cited with date ranges
- [ ] Numbers include units, time periods, and comparison basis
- [ ] Financial calculations verified independently via a fresh general-purpose subagent briefed adversarially

## Common Pitfalls

- Confirmation bias: finding only evidence that supports the expected answer
- Comparing apples to oranges (different time periods, different denominators)
- Presenting correlation as causation without flagging it
- Missing the "so what" -- analysis without actionable recommendations
- Over-precision: reporting 4 decimal places from a 50-person sample
- Ignoring base rates when presenting percentages

## Skeleton

```markdown
## Question

[Precise statement of what we're investigating]

## Data Sources

| Source | Date Range | Records | Known Limitations |
|---|---|---|---|
| [Source] | [Range] | [N] | [Limitation] |

## Methodology

[Plain-language description of analytical approach]

## Findings

### Finding 1: [Title]

[Data and interpretation]

**Confidence:** [Level] -- [basis]

### Finding 2: [Title]

[Data and interpretation]

### Counterpoint

[Alternative interpretation or limitation that qualifies the findings]

## Limitations

- [What this analysis cannot tell us]
- [Assumptions that could change the conclusions]

## Recommendations

**Primary recommendation:** [Action]
**Confidence:** [Level] -- would increase with [additional data]

**Alternative actions:**
1. [Option] -- appropriate if [condition]
```
