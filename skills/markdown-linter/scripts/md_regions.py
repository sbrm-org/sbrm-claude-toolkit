#!/usr/bin/env python3
"""
Shared structural scanner for the markdown linter.

Single source of truth for "which lines must never be rewritten": fenced code
blocks (CommonMark nesting rules, so a 4-backtick fence can legally contain
3-backtick fences) and YAML frontmatter.

Every auto-fixer consults this before touching a line. Before this existed each
fixer tracked fences with its own ad-hoc toggle (or not at all), which is how
`---` inside ```yaml blocks got deleted and how `#!/usr/bin/env bash` inside
```bash blocks became `# !/usr/bin/env bash`.
"""

import re
from typing import List, Set

# Optional blockquote/callout prefix and any indentation (a fence nested under a
# 4-space-indented bullet is still a fence; the Obsidian convention indents sub-bullets
# 4 spaces, so the CommonMark 0-3 space rule would leave those fences exposed),
# then 3+ backticks or tildes, then an optional info string.
_FENCE_RE = re.compile(r'^(\s*(?:>\s?)*)(`{3,}|~{3,})(.*)$')


def fence_spans(lines: List[str]):
    """Yield (start_idx, end_idx) inclusive for each fenced code block.

    CommonMark: a fence closes only on the same character, a run at least as
    long as the opener, and nothing but whitespace after it. An unclosed fence
    runs to end of file.
    """
    i = 0
    n = len(lines)
    while i < n:
        m = _FENCE_RE.match(lines[i])
        if not m:
            i += 1
            continue
        char, length = m.group(2)[0], len(m.group(2))
        start = i
        j = i + 1
        while j < n:
            cm = _FENCE_RE.match(lines[j])
            if cm:
                cchar, clen, cinfo = cm.group(2)[0], len(cm.group(2)), cm.group(3).strip()
                if cchar == char and clen >= length and not cinfo:
                    break
            j += 1
        end = j if j < n else n - 1
        yield (start, end)
        i = end + 1


def frontmatter_span(lines: List[str]):
    """Return (start, end) inclusive for YAML frontmatter, or None."""
    # A UTF-8 BOM survives str.strip(), which used to hide frontmatter from
    # this scanner entirely - the closing --- was then deleted as a horizontal
    # rule and the YAML merged into the body.
    if not lines or lines[0].lstrip('\ufeff').strip() != '---':
        return None
    for i in range(1, len(lines)):
        if lines[i].strip() == '---':
            return (0, i)
    return None


def protected_lines(lines: List[str]) -> Set[int]:
    """Indices of lines inside code fences or frontmatter (delimiters included)."""
    protected: Set[int] = set()
    for start, end in fence_spans(lines):
        protected.update(range(start, end + 1))
    fm = frontmatter_span(lines)
    if fm:
        protected.update(range(fm[0], fm[1] + 1))
    return protected


def prose_indices(lines: List[str]):
    """Yield (index, line) for lines outside code fences and frontmatter."""
    protected = protected_lines(lines)
    for i, line in enumerate(lines):
        if i not in protected:
            yield i, line
