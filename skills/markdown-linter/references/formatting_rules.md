# Markdown Formatting Rules

This document defines all formatting rules for Obsidian-compatible markdown. Rules are organized by category with examples.

## Blank Line Rules

Blank lines structure content readability and affect Obsidian rendering. Rules are strict.

### When SINGLE blank line is REQUIRED

**After paragraph when followed by list:**
```markdown
Here's what we need to do:

- First item
- Second item
```

**Between consecutive paragraphs:**
```markdown
First paragraph ends here.

Second paragraph starts here.
```

**Before tables:**
```markdown
Here's the data:

|Column1|Column2|
|---|---|
|Value1|Value2|
```

**After tables:**
```markdown
|Column1|Column2|
|---|---|
|Value1|Value2|

Next section starts here.
```

**Before blockquotes:**
```markdown
Here's what the lawyer said:

> Electronic signatures are valid.
```

**After blockquotes:**
```markdown
> The policy must be published.

We should review this carefully.
```

### When NO blank line is allowed

**Heading directly to anything (paragraph, list, subheading, code, quote):**
```markdown
## Overview
This is the first paragraph.
```
```markdown
## Main Section
### Subsection
```
❌ WRONG:
```markdown
## Overview

This is the first paragraph.
```

**Heading directly to list:**
```markdown
## Shopping List
- Milk
- Eggs
- Bread
```
❌ WRONG:
```markdown
## Shopping List

- Milk
```

**Between list items:**
```markdown
- First item
- Second item
- Third item
```
❌ WRONG:
```markdown
- First item

- Second item
```

**Within nested lists (including indentation):**
```markdown
- Parent item
    - Child item
    - Another child
- Another parent
```
❌ WRONG:
```markdown
- Parent item
    - Child item

    - Another child
```

**Between title and subtitle:**
```markdown
# Document Title
Prepared by Jane Doe, November 5, 2025
```
❌ WRONG:
```markdown
# Document Title

Prepared by Jane Doe
```

**Within blockquotes:**
```markdown
> First line of quote.
> Second line of quote.
```
❌ WRONG:
```markdown
> First line of quote.

> Second line of quote.
```

**Within tables:**
```markdown
|Name|Role|
|---|---|
|Jane|COO|
|Brooke|Director|
```
❌ WRONG:
```markdown
|Name|Role|
|---|---|
|Jane|COO|

|Brooke|Director|
```

### Multiple consecutive blank lines are ALWAYS wrong

NEVER allow 2 or more consecutive blank lines. Always collapse to single blank.

❌ WRONG:
```markdown
## Section


Next content here.
```

✓ CORRECT:
```markdown
## Section

Next content here.
```

---

## Syntax Rules

### Bold and Italic Formatting

**Correct bold syntax:** `**text**`
- ❌ Wrong: `*text**` (mismatched)
- ❌ Wrong: `**text*` (mismatched)
- ❌ Wrong: `***text` (unclosed)

**Correct italic syntax:** `*text*`
- ❌ Wrong: `**text` (unclosed)
- ❌ Wrong: `*text` (unclosed)

**Combinations:**
- Bold+italic: `***text***`
- Bold in italic: `*Some **bold** text*`

### Wiki Links

**Correct syntax:** `[[Note Name]]`
- ✓ Spaces allowed: `[[My Note Name]]`
- ✓ With aliases: `[[Reference Name|Display Text]]`

**Incorrect syntax (errors):**
- ❌ `[[Note Name` (missing closing brackets)
- ❌ `[[Note Name]` (missing one bracket)
- ❌ `[Note Name]]` (missing opening bracket)

### Links and Images

**Correct link syntax:** `[text](url)`
- ✓ `[Google](https://google.com)`
- ✓ `[Internal link](path/to/file.md)`

**Incorrect (errors):**
- ❌ `[text](url` (missing closing paren)
- ❌ `[text]url)` (mismatched brackets/parens)
- ❌ `[text]]url)` (extra bracket)

**Images:** Same as links but with leading `!`
- ✓ `![alt text](image.png)`
- ❌ `!alt text](image.png)` (missing opening bracket)

### Headings

**Correct heading syntax:** Space required after hash marks
- ✓ `# Level 1`
- ✓ `## Level 2`
- ✓ `### Level 3`

**Incorrect (errors):**
- ❌ `#No space` (missing space)
- ❌ `#  Too many spaces` (more than one space)

**Heading hierarchy:** Only use `#` for document title
- ✓ Use `## Section`, `### Subsection`, `#### Detail`
- ❌ Don't use `# Section` unless it's the document title

### Code Blocks

**Correct fenced code blocks:**
~~~markdown
```python
def hello():
    print("world")
```
~~~

**Incorrect:**
- ❌ Unclosed: ` ```python` without closing ` ``` `
- ❌ Mismatched: Opening ` ``` ` with closing ` ```` `
- ❌ Missing backticks in fence: ` ```python` with no fence

**Inline code:** Use backticks
- ✓ `this is code`
- ❌ `this is code (missing closing backtick)

### Lists and Bullets

**Correct bullet lists:**
```markdown
- Item 1
- Item 2
- Item 3
```

**Correct numbered lists:**
```markdown
1. First item
2. Second item
3. Third item
```

**Nested lists (4-space indentation required):**
```markdown
- Parent
    - Child 1
    - Child 2
- Another parent
    - Another child
```

**Incorrect nesting:**
- ❌ Inconsistent indentation (1 space, 2 spaces, 4 spaces mixed)
- ❌ Too much indentation (8 spaces instead of 4)
- ❌ Tab indentation (must be 4 spaces, not tabs)

---

## Table Formatting Rules

Tables must follow strict formatting to render correctly in Obsidian.

### Structure Requirements

**Must have:**
1. Header row with pipe delimiters
2. Separator row with dashes
3. Data rows with same number of columns

**Example (correct):**
```markdown
|Name|Role|Department|
|---|---|---|
|Jane|COO|Operations|
|Brooke|Director|Services|
```

### Column Count Rules

**All rows must have matching column count:**

✓ CORRECT (3 columns everywhere):
```markdown
|Col1|Col2|Col3|
|---|---|---|
|A|B|C|
|D|E|F|
```

❌ WRONG (header has 3, row 2 has 4):
```markdown
|Col1|Col2|Col3|
|---|---|---|
|A|B|C|D|
|E|F|G|
```

### Separator Row Rules

**Must contain only dashes and optional colons:**
- ✓ `|---|---|---|` (simple dashes)
- ✓ `|:---|---|---:|` (with alignment colons)
- ❌ `|--- |---|---|` (spaces not allowed)
- ❌ `| --- | --- | --- |` (pipes with spaces)
- ❌ `|content|---|---|` (can't have text)

### Whitespace Rules

**No trailing spaces on lines:**
- ✓ `|Column1|Column2|`
- ❌ `|Column1|Column2| ` (space at end)

**No blank lines within table:**
- ✓ Rows consecutive
- ❌ Blank line between header and separator
- ❌ Blank line between data rows

### Table Examples

**Simple 2-column table:**
```markdown
|Item|Quantity|
|---|---|
|Milk|1|
|Eggs|12|
```

**Table with alignment:**
```markdown
|Left|Center|Right|
|:---|:---:|---:|
|A|B|C|
|D|E|F|
```

**Table with longer content (no wrapping needed):**
```markdown
|Feature|Description|Status|
|---|---|---|
|Authentication|User login system|Complete|
|Dashboard|Analytics overview|In Progress|
|Reporting|Monthly reports|Planned|
```

---

## Style Rules

### Bold Usage

Use bold **sparingly**:
- ✓ For section labels that aren't headings
- ✓ For terms that need eye-catching emphasis
- ✓ For labels in lists

**Example (correct):**
```markdown
**Budget:** $5,000,000 annually
```

**Example (incorrect - too much bold):**
```markdown
**The** **budget** **is** **$5,000,000** **annually**
```

### Heading Hierarchy

**Level 1 (`#`) only for document title:**
- ✓ `# 2025-26 Strategic Plan`
- ✓ `# Bylaws Amendments`

**Use Level 2 (`##`) for major sections:**
- ✓ `## Overview`
- ✓ `## The Problem`
- ✓ `## Implementation`

**Use Level 3 (`###`) for subsections:**
- ✓ `### Amendment 1: Staff Authority`
- ✓ `### Validation Workflow`

**Use Level 4+ sparingly:**
- ✓ `#### Nested detail`
- Avoid going deeper than level 4

### List Indentation

**Nested lists use 4-space indentation:**
```markdown
- Parent item
    - Nested item
    - Another nested
- Another parent
    - Nested under parent 2
        - Double nested (8 spaces)
```

**NOT tabs, NOT 2 spaces, NOT 3 spaces — exactly 4 spaces**

### Wiki Links

Use wiki links `[[Note Name]]` as primary linking method.

**Correct usage:**
```markdown
Learn more in [[Strategic Planning]].
See [[2025-26 Strategic Plan]] for details.
Related: [[Financial Management for Nonprofits]]
```

**Avoid markdown links when wiki links work:**
- ✓ `[[Note Name]]`
- ❌ `[Note Name](path/to/note.md)`

---

## Obsidian-Specific Rules

### Frontmatter

Frontmatter at top of file (YAML between `---` and `---`):

```markdown
---
type: document
created: 2025-11-12T10:30
updated: 2025-11-12T10:30
tags:
  - tag1
  - tag2
---
```

**Rules:**
- Frontmatter must be first content in file
- Use dashes on own lines: `---`
- Proper YAML formatting (colons, hyphens)
- Common fields: `type`, `created`, `updated`, `tags`, `project`

### Code Blocks for Copy-Paste

Use fenced code blocks for content meant to be copied:

~~~markdown
```
Section 6.11. Execution of Instruments and Delegation
The Staff President may execute contracts...
```
~~~

**Why:** Obsidian makes it easy to copy entire code block contents.

### LaTeX for Formulas

Use LaTeX within code fences for mathematical formulas:

~~~markdown
$$\frac{\text{Cash and equivalents}}{\text{Current Liabilities}}$$
~~~

---

## Summary Quick Reference

| Rule | Do This | Don't Do This |
|---|---|---|
| **Blank lines** | Single between sections | Multiple blanks ever |
| **Bold** | Sparingly for emphasis | `*hello**` (mismatched) |
| **Headings** | ## or ### | # for sections |
| **Tables** | Matching columns | Blank lines in tables |
| **Nested lists** | 4-space indent | Tabs or 2-space |
| **Wiki links** | `[[Note Name]]` | `[Note](path)` |
| **Code blocks** | For copy-paste content | Inline code for variables |
