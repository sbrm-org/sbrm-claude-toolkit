---
name: coding-protocols
description: Discipline for any coding task. Red-green TDD, lightweight planning checkpoint, root-cause debugging, no placeholders, verify before claiming done. Auto-triggers on writing, modifying, or debugging code/scripts.
---

# Coding Protocols
## Overview
The coding-side companion to `non-coding-protocols`. Holds the five rules worth repeating on every coding task: TDD, plan-before-code, root-cause debugging, no-placeholder plans, and verify-before-claiming-done.

Core ideas borrowed (with attribution) from `obra/superpowers`: TDD, verification-before-completion, systematic-debugging, writing-plans skills. Not a wholesale adoption; a slim, solo-developer-scale subset.
## Triggers
**Activates on:**

- Writing new code or scripts (any language)
- Modifying existing code (>2 lines)
- Debugging errors, test failures, unexpected behavior
- Drafting implementation plans for code work
- Building or editing hooks, skill scripts, automation, managed agents

**Does NOT activate on:**

- Editing markdown / docs / READMEs / config YAML
- Trivial 1-2 line fixes (typo, comment, single value change)
- Reading or explaining code without modification
- Questions about how something works (no edit pending)
## Escape Hatches
- **`!quick`** prefix: Skip the planning checkpoint, just code. Still apply TDD if tests exist.
- **`!full`** prefix: Force full discipline (planning + TDD + verification + post-completion check) even for small tasks.
## The Five Rules
### 1. Red-Green TDD (Iron Law)
```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write the test. Run it. Watch it fail. Then write the minimum code to make it pass. If you wrote code before the test: delete it, start over. No keeping it "as reference."

**Exceptions** (ask the user first):

- Throwaway prototypes meant to be discarded
- Generated code (scaffolds, codegen output)
- Config files (no behavior to test)
- One-off shell commands

Tempted to "skip TDD just this once"? That's rationalization. The whole point of red-green is verifying the test catches what it claims to catch. A passing test that never failed proves nothing.
### 2. Plan Before Implementing (lightweight)
For anything beyond a 1-2 line fix: state intent in one sentence + propose approach in 2-3 sentences. Wait for the user's nod. Then code.

Not a HARD-GATE. The user doesn't want a spec doc for a 40-line script. Just a checkpoint to catch misaligned assumptions before they become reworks.

If the task is plan-mode-worthy (multi-file, architecture decisions, new project structure), use plan mode instead and let the user approve the full plan.
### 3. Root-Cause Debugging
```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

When something breaks:

1. Read the error message and stack trace completely. Often contains the answer.
2. Reproduce reliably. If you can't, gather more data instead of guessing.
3. Check recent changes (`git diff`, recent commits, env changes).
4. In multi-component systems, instrument boundaries to find which layer fails before fixing anything.
5. Trace bad values backward to their source. Fix at source, not at symptom.

**The class rule:** When fixing an error, ask whether it's a single instance or a pattern. If it reveals a class of similar issues, fix the class. Audit the full scope on first encounter rather than playing whack-a-mole across follow-up sessions.
### 4. No Placeholders
If you produce an implementation plan, every step has exact file paths + complete code. These are plan failures. Never write them:

- "TODO", "TBD", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" without showing the actual test code
- "Similar to Task N" (repeat the code; the engineer may read tasks out of order)
- Steps that say *what* without showing *how* (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

Same rule applies to code: don't leave `# TODO: handle this case` comments unless the user has been told. Either handle it or surface it explicitly.
### 5. Verify Before Claiming Done
Completion claims need fresh evidence produced in the same response. Coding-specific verification examples:

| Claim | Requires | Not sufficient |
|---|---|---|
| "tests pass" | Fresh test run, quote the pass count | Previous run, "should pass" |
| "build succeeds" | Fresh build, quote exit code | Linter passing, logs look OK |
| "bug fixed" | Run the original failure case, confirm it now passes | Code changed, assumed fixed |
| "regression test works" | Red-green cycle: write → run (pass) → revert fix → run (MUST FAIL) → restore → run (pass) | Test passes once |
| "linter clean" | Linter output: 0 errors | Partial check, extrapolation |

"Linter passed" ≠ "build passes" (linter doesn't compile). "Type check passed" ≠ "tests pass" (types don't catch logic bugs).
## Integration
Pairs with:

- `non-coding-protocols`: sibling skill for non-code work. Both share the !quick / !full escape hatch convention.
- a code-review pass: run on substantial changes for reuse / quality / efficiency review.
- Independent verification: for plans and fact-heavy claims, verify independently via a fresh general-purpose subagent briefed adversarially.
