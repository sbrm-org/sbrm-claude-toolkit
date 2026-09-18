#!/usr/bin/env python3
"""
Auto-fix syntax errors in markdown files.
Corrects malformed bold/italic, heading formatting, etc.
"""

import re
from pathlib import Path
from typing import List, Tuple

from md_regions import protected_lines

# A run of N backticks closed by a run of exactly N, so `` `<x>` `` is one span.
_CODE_SPAN_RE = re.compile(r'(`+)(.*?)(?<!`)\1(?!`)')


def _sub_outside_code_spans(pattern, repl, line):
    """re.sub applied only to the parts of a line outside inline code spans."""
    out = []
    pos = 0
    for m in _CODE_SPAN_RE.finditer(line):
        out.append(re.sub(pattern, repl, line[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(re.sub(pattern, repl, line[pos:]))
    return ''.join(out)


class SyntaxFixer:
    """Fixes syntax errors in markdown."""

    def __init__(self, filepath: str):
        self.filepath = Path(filepath)
        self.original_lines = self.filepath.read_text(encoding='utf-8').split('\n')
        self.lines = self.original_lines.copy()
        self.changes = []

    def fix(self) -> Tuple[List[str], List[str]]:
        """Fix syntax errors and return fixed lines and change list."""
        self._fix_bold_formatting()
        self._fix_heading_spacing()
        self._fix_trailing_whitespace()

        return self.lines, self.changes

    def _fix_bold_formatting(self):
        """Fix malformed bold/italic formatting (prose only).

        Inline code spans are left alone. A doc that talks about markdown
        writes its counter-examples in backticks (`` `*text**` ``); rewriting
        those destroys the example, and the asterisks never rendered as bold
        in the first place.
        """
        protected = protected_lines(self.lines)
        for i, line in enumerate(self.lines):
            # Never rewrite code fences or frontmatter
            if i in protected:
                continue

            for pattern, repl, label in (
                # Negative lookbehind `(?<!\*)` prevents matching the second `*`
                # of a valid `**word**` opener - without it, `**RED**` is
                # "fixed" to `***RED**`, growing two asterisks per linter run.
                (r'(?<!\*)\*([a-zA-Z]+)\*\*', r'**\1**', '`*text**` -> `**text**`'),
                (r'\*\*([a-zA-Z]+)\*(?!\*)', r'**\1**', '`**text*` -> `**text**`'),
            ):
                original = self.lines[i]
                fixed = _sub_outside_code_spans(pattern, repl, original)
                if fixed != original:
                    self.lines[i] = fixed
                    self.changes.append(
                        f"Line {i + 1}: Fixed malformed bold {label}")

    def _fix_heading_spacing(self):
        """Fix headings missing space after hash marks (prose only).

        The pattern matches the validator's check exactly: a hash run followed
        by a letter or digit. Anything else after the hash (`#!`, `#{`, `#-`)
        is not a heading attempt — matching those turned shebangs and CSS
        selectors inside code blocks into `# !/usr/bin/env bash`.
        """
        protected = protected_lines(self.lines)
        for i, line in enumerate(self.lines):
            if i in protected:
                continue
            # Match heading without space: #Heading or ##Heading
            if re.match(r'^#{1,6}[A-Za-z0-9]', line):
                original = line
                # Insert space after hashes
                fixed = re.sub(r'^(#{1,6})([A-Za-z0-9])', r'\1 \2', line)
                self.lines[i] = fixed
                self.changes.append(f"Line {i + 1}: Added space after heading hash: `{original.strip()}` → `{fixed.strip()}`")

    def _fix_trailing_whitespace(self):
        """Remove trailing whitespace from prose lines.

        Skipped inside code fences, where trailing spaces can be significant
        (diff fixtures, whitespace-sensitive languages, test data).
        """
        protected = protected_lines(self.lines)
        for i, line in enumerate(self.lines):
            if i in protected:
                continue
            if line != line.rstrip():
                self.lines[i] = line.rstrip()
                self.changes.append(f"Line {i + 1}: Removed trailing whitespace")

    def save(self, output_filepath: str = None):
        """Save fixed content to file."""
        if output_filepath is None:
            output_filepath = self.filepath

        content = '\n'.join(self.lines)
        Path(output_filepath).write_text(content, encoding='utf-8')


def main():
    """Main entry point."""
    import sys

    if len(sys.argv) < 2:
        print("Usage: python3 fix_syntax.py <filepath> [output_filepath]")
        sys.exit(1)

    filepath = sys.argv[1]
    output_filepath = sys.argv[2] if len(sys.argv) > 2 else None

    if not Path(filepath).exists():
        print(f"Error: File not found: {filepath}")
        sys.exit(1)

    fixer = SyntaxFixer(filepath)
    fixed_lines, changes = fixer.fix()

    if changes:
        print(f"Fixed {len(changes)} syntax issues:")
        for change in changes:
            print(f"  ✓ {change}")
        fixer.save(output_filepath)
        print(f"\nSaved to: {output_filepath or filepath}")
    else:
        print("No syntax issues found.")


if __name__ == '__main__':
    main()
