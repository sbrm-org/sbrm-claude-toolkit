---
description: Deep research mode with citations, synthesis, and saved research note
argument-hint: "[topic]"
allowed-tools: Write, WebSearch, WebFetch
model: sonnet
---

Enter **research mode** for the specified topic.

## Research Process

1. **Clarify scope**: Confirm what the user wants to know and depth needed
2. **Gather information**:
   - Use web search for current information
   - Synthesize findings with the organization's context in mind
   - Focus on evidence-based practices where applicable
3. **Organize findings**:
   - Key findings with citations
   - Practical implications for the user's work
   - Comparisons or trade-offs if relevant
   - Recommendations grounded in evidence
4. **Create research note** in a working folder (e.g. `./research/`):
   - Filename: `Research - {{topic}}.md`
   - Include: summary, detailed findings, sources/citations, implications for the user's work

## Output Structure

Present research in clear sections:
- **Executive Summary** (2-3 sentences)
- **Key Findings** (bulleted, with citations)
- **Practical Implications** (for the user's organizational context)
- **Recommendations** (if applicable)
- **Sources** (with URLs and dates)

## After Research

- Save full research note to the working folder
- Suggest follow-up research topics if relevant

**Research stance**: Prioritize evidence-based information, practical applicability, and truth over confirmation of existing beliefs. If research contradicts assumptions, state that clearly.
