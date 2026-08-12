---
name: markdown-linter
description: "This skill validates and auto-fixes markdown files according to Obsidian formatting standards. Use this when validating markdown syntax, checking formatting compliance (blank lines, tables, headings), fixing spacing issues, or ensuring markdown files meet Obsidian Bases compatibility requirements."
---

# Markdown Linter
## Overview
This skill validates markdown files against comprehensive formatting rules and auto-fixes common issues. It catches both syntax errors (malformed bold, broken links, invalid headings) and style violations (excessive blank lines, table formatting, heading hierarchy).

The skill operates in two modes: **validate** (report issues without changes) and **fix** (auto-correct deterministic issues). It's designed specifically for Obsidian-compatible markdown with support for wiki links, frontmatter, tables, and code blocks.
## Workflow
The default invocation auto-fixes deterministic issues, then validates and reports anything residual:

```
python3 scripts/validate_markdown.py <filepath>
```

This runs `fix_spacing.py` (blank lines, horizontal rules, table blanks) and `fix_syntax.py` (heading-hash spacing, trailing whitespace, malformed bold) in place, then validates the fixed file and reports issues that need human judgment (wordy headings, broken links, table column mismatches, unclosed code fences, multiple H1s).

`fix_tables.py` is **not** run automatically — its column-alignment can silently truncate cells. Run it manually if needed.

For read-only validation (no file modification), pass `--check` or `--no-fix`:

```
python3 scripts/validate_markdown.py --check <filepath>
```

Exit codes: `0` if no errors remain (warnings are OK), `1` if residual errors require manual fixing.

**Example output:**
```
AUTO-FIXED 4 issue(s):
  ✓ Line 5: Removed horizontal rule
  ✓ Line 8: Collapsed 2 blank lines to 1
  ✓ Line 1: Removed blank after heading
  ✓ Line 67: Added space after heading hash: `##Heading` → `## Heading`

WARNINGS:
  ⚠️  Line 12: Heading contains explanatory text in parentheses

Summary: 0 errors, 1 warnings
```

## Key Formatting Rules
Reference `references/formatting_rules.md` for complete documentation. Quick rules summary:

**Blank Line Requirements:**

- ✗ NO blank after heading → anything (paragraph, list, subheading, code, quote)
- ✓ Single blank after paragraph → list
- ✓ Single blank between paragraphs
- ✓ Single blank before/after tables
- ✓ Single blank before/after blockquotes
- ✗ NO blank lines within tables or blockquotes
- ✗ NEVER multiple consecutive blank lines
- ✗ NO horizontal rules (auto-removed by fix_spacing.py)

**Syntax Rules:**

- Wiki links: `[[Note Name]]` (valid syntax)
- Broken wiki links: `[[Note Name` (missing bracket - error)
- Bold: `**text**` (not `**text**` or `**text**`)
- Code blocks: Matching backticks, must be closed
- Code fence nesting: outer fence must be longer than any inner fence (3 backticks containing a `` ```bash `` block leaves the file with an unclosed fence — bump outer to 4 backticks or switch to `~~~`)
- Headings: `# Heading` (space required after hash)

**Table Rules:**

- Pipe syntax with exact column matching across all rows
- Separator row: only dashes and colons (`|---|---|`)
- No trailing whitespace
- No blank lines inside tables

**Style Preferences:**

- Level 1 headings only for document title
- 4-space indentation for nested list items
- Wiki links `[[Note]]` as primary linking method
- Bold sparingly (titles, eye-catching items only)

**Frontmatter:** This linter only checks body formatting; YAML frontmatter is left untouched.
## Resources
This skill includes bundled resources for complete rule documentation and validation:
### references/formatting_rules.md
Comprehensive guide to all formatting rules organized by category:

- Blank line rules with examples
- Syntax errors and corrections
- Table formatting specifications
- Heading hierarchy rules
- Obsidian-specific conventions (wiki links, frontmatter)

Load this reference when needing detailed rule explanations or when unsure about a specific formatting requirement.
### scripts/validate_markdown.py
Main validation engine that checks markdown files against all rules. Returns structured output with:

- Issue location (line number)
- Issue type (syntax, spacing, style)
- Specific error message
- Suggested correction

Can be executed directly or called within Claude's workflow.
### scripts/fix_*.py
Auto-fix utilities for specific issue categories:

- `fix_spacing.py` - Handle blank line issues
- `fix_tables.py` - Correct table formatting
- `fix_syntax.py` - Fix syntax errors

These are deterministic operations that can be applied without manual review for most cases.
