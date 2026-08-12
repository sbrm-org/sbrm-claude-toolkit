---
name: non-coding-protocols
description: Orchestrate any substantial non-coding task through a 4-phase workflow with planning briefs, self-review, and humanizer integration. Auto-triggers on anything beyond a quick question.
---

# Non-Coding Protocols

## Overview

Orchestrates any substantial non-coding task through a 4-phase workflow: Scope, Execute, Review, Deliver. The goal is to reduce back-and-forth by forcing Claude to plan before acting, self-review before delivering, and humanize output that other people will read.

## Triggers

**Activates on any non-trivial, non-coding task**, including but not limited to:
- Structured deliverables: policies, reports, analyses, spreadsheets, SOPs, templates
- Written communications: emails, memos, Teams/Slack messages, cover letters, formal letters
- Research + decision tasks: "help me figure out which X to buy", "what are best practices for Y"
- Comparison/evaluation: "compare options for...", "which is better...", "pros and cons of..."
- Planning: event plans, trip itineraries, project plans, rollout checklists
- Advisory conversations: "walk me through how to handle X", "what should I know about Y"
- Hybrid requests: prompt contains BOTH research language AND deliverable/decision language

**The test:** If the task will take multiple rounds of back-and-forth to get right, this skill should be active. If the user would otherwise need to steer through 3+ refinement cycles, the planning brief catches misalignment upfront.

**Does NOT activate on:**
- Questions answerable in a single sentence ("what's the capital of...", "what's 15% of...")
- Coding tasks, technical implementation
- Greetings and small talk ("hey, how's it going")

**When in doubt, activate.** False positives (unnecessary planning brief) waste 10 seconds. False negatives (no planning brief when needed) waste 10 minutes of steering. Even if prior work exists on a topic, the skill still activates — use prior work as input, but still scope and structure the response.

## Escape Hatches

- **`!quick`** prefix: Skip Scope and Review phases. Execute and deliver directly.
- **`!full`** prefix: Force all 4 phases even if request looks simple. Show full audit trail including passing acceptance tests.

## Hybrid Detection

If prompt contains BOTH research indicators ("research", "find best practices", "what are others doing", "look into", "help me figure out", "which should I") AND output indicators ("draft", "create", "build", "make", "write", "put together", "send"):
1. Run research stage first (web search, synthesis, save research note)
2. Use research output as input to the relevant protocol
3. Cite research findings in the deliverable

## Complexity Threshold

The 4-phase protocol scales to the task:
- **Substantial tasks** (policies, reports, multi-step research): Full planning brief, all 4 phases
- **Medium tasks** (emails, comparison shopping, plans): Abbreviated planning brief (3 fields: Goal, Constraints, Audience), lighter review
- **Quick but non-trivial tasks** (short email, simple plan): Mental planning brief (don't show it, just think through it), still self-review before delivering

Quick answers, single-fact lookups, and coding tasks stay fast -- no orchestration overhead.

---

## 4-Phase Workflow

### Phase 1: Scope (Research Lead)

1. Identify deliverable type from prompt
2. Load the matching protocol from this skill's `protocols/` directory
3. Ask 3-5 targeted scoping questions from the protocol (or state reasonable defaults if context is clear)
4. Write the planning brief:

```
Audience: [who receives this]
Deliverable: [type]
Decision/Goal: [what this enables or what decision it drives]
Constraints: [jurisdiction, timeline, length, format requirements]
Assumptions: [what I'm assuming without evidence]
Success criteria: [how the user knows this is done right]
Humanizer: YES/NO — [reason, e.g. "email the user will send as themselves" or "formal HR policy for handbook"]
```

5. Present brief to the user for approval/correction before proceeding

**Rules:**
- Each field is exactly one line. No prose, no paragraphs.
- If any field is unknown, state "TBD -- will ask" or "Assuming X."
- The user should be able to scan and approve in 5 seconds.

### Phase 2: Execute (Analyst)

1. Load the relevant protocol template (if one matches; otherwise adapt closest fit)
2. If hybrid request: complete research stage first, save research note
3. Generate deliverable following protocol's required sections (or freeform for non-template tasks)
4. Apply stakeholder framing appropriate to the audience (when applicable)
5. **Determine humanizer routing** (see Humanizer Decision Rules below)

### Phase 3: Review (Skeptical Reviewer)

Run acceptance tests from the loaded protocol's Definition of Done (for template-based deliverables) or general quality checks (for freeform tasks).

**Default mode (silent gating):**
- Tests run internally
- Only failures are reported as a short "Flags" block at the end
- If all tests pass, nothing is appended -- deliverable is clean

**`!full` mode (full audit trail):**
- All test results shown (pass and fail)
- Full critique: assumptions stated, gaps identified, risks surfaced, counterarguments noted
- Items flagged for independent verification (financial calcs, regulatory claims) — verify via a fresh general-purpose subagent briefed adversarially

**Humanizer pass (MANDATORY when planning brief says Humanizer: YES):**

If the planning brief's Humanizer field is YES, you MUST run these steps before delivering. Do NOT skip this. Do NOT rationalize that "it already sounds natural." Run it every time.

1. Review your draft and identify AI writing patterns: promotional language, rule-of-three, em-dash overuse, persuasion scaffolding, copula avoidance ("serves as"), excessive hedging, sycophantic tone, uniform sentence length, absence of personal grounding or emotion
2. Ask yourself: "What makes this obviously AI-generated?" List 3-5 specific tells in the draft
3. Revise the draft to fix every tell: add personality, vary rhythm, use "I" when appropriate, ground claims in personal experience, let some imperfection in, replace vague attributions with specific ones
4. The delivered output MUST be the humanized version. Show both the AI-smell tells you found AND the final revised version so the user can see what changed

### Phase 4: Deliver (Synthesizer)

1. Save deliverable to a working folder of your choice (quick) or the project directory (substantial)
2. Provide the file path
3. Suggest concrete next steps (legal review, board discussion, data refresh, etc.)
4. If any Review flags exist, list them with recommended actions

---

## Humanizer Decision Rules

Use these rules to fill in the Humanizer field in the planning brief. This decision is made ONCE in Phase 1 and enforced in Phase 3. Do not second-guess it later.

### Humanizer: YES (casual + semi-casual)

Set Humanizer: YES in the planning brief for:

- **Emails** -- to recruiters, colleagues, vendors, friends, anyone
- **Chat messages** -- Teams, Slack, text messages
- **Cover letters** and job application correspondence
- **Casual reports** -- event plans, trip itineraries, informal write-ups
- **Memos to staff** -- informal updates, meeting agendas, FYI communications
- **Social/community writing** -- community emails, parent group messages, volunteer coordination
- **Any output the user will copy-paste and send as themselves**

### Humanizer: NO (formal professional)

Set Humanizer: NO in the planning brief for:

- **HR policy documents** -- employee handbook entries, workplace policies
- **Board documents** -- board reports, resolutions, financial summaries for the board
- **Legal/compliance documents** -- regulatory filings, compliance policies, audit responses
- **Formal request letters** -- letters to government agencies, insurers, attorneys
- **SOPs and procedures** -- formal operational procedures
- **Contracts and agreements** -- employment agreements, vendor contracts, MOUs
- **Grant applications and funder reports** -- formal grant narratives, progress reports
- **Financial documents** -- budgets, financial statements, tax-related documents

### Override

- The user can say "humanize this" on any formal document to force a humanizer pass
- The user can say "skip humanizer" or "don't humanize" on any casual document to skip it
- When in doubt, ask: "This will be read by [audience] -- want me to run the humanizer?"

---

## Protocol Selection

| Deliverable Type | Protocol File | Slash Command |
|---|---|---|
| HR/operational policy, SOP | `hr-policy.md` | `/policy` |
| Executive/stakeholder report | `executive-report.md` | `/report` |
| Data analysis, comparison | `data-analysis.md` | `/analyze` |
| Spreadsheet, tracker, budget | `spreadsheet-build.md` | `/sheet` |

If the deliverable doesn't match any protocol, use the closest fit and adapt. Note the adaptation in the planning brief.

---

## Integration

- **`humanizer` skill**: Auto-runs on casual/semi-casual output during Phase 3 Review. See Humanizer Decision Rules above for routing.
- **`/research`**: Invoked automatically as stage 1 of hybrid requests. Can also be run manually before this skill.
- **Independent verification**: Review phase flags specific items (formulas, calculations, regulatory claims) — verify independently via a fresh general-purpose subagent briefed adversarially.
- **`/write`**: For pure writing tasks (not structured deliverables). This skill does NOT replace `/write`.
