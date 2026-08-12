#!/usr/bin/env python3
"""
Auto-fix syntax errors in markdown files.
Corrects malformed bold/italic, heading formatting, etc.
"""

import re
from pathlib import Path
from typing import List, Tuple

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
        """Fix malformed bold/italic formatting."""
        for i, line in enumerate(self.lines):
            # Skip code blocks and frontmatter
            if line.strip().startswith('```') or line.strip().startswith('---'):
                continue

            # Fix mismatched bold: *text** → **text**
            # Negative lookbehind `(?<!\*)` prevents matching the second `*` of
            # a valid `**word**` opener — without it, `**RED**` is "fixed" to
            # `***RED**`, growing two asterisks per linter run.
            if re.search(r'(?<!\*)\*[a-zA-Z]+\*\*', line):
                original = line
                line = re.sub(r'(?<!\*)\*([a-zA-Z]+)\*\*', r'**\1**', line)
                if line != original:
                    self.lines[i] = line
                    self.changes.append(f"Line {i + 1}: Fixed malformed bold `*text**` → `**text**`")

            # Fix mismatched bold: **text* → **text**
            if re.search(r'\*\*[a-zA-Z]+\*(?!\*)', line):
                original = line
                line = re.sub(r'\*\*([a-zA-Z]+)\*(?!\*)', r'**\1**', line)
                if line != original:
                    self.lines[i] = line
                    self.changes.append(f"Line {i + 1}: Fixed malformed bold `**text*` → `**text**`")

    def _fix_heading_spacing(self):
        """Fix headings missing space after hash marks."""
        for i, line in enumerate(self.lines):
            # Match heading without space: #Heading or ##Heading
            if re.match(r'^#{1,6}[^\s#]', line):
                original = line
                # Insert space after hashes
                fixed = re.sub(r'^(#{1,6})([^\s])', r'\1 \2', line)
                self.lines[i] = fixed
                self.changes.append(f"Line {i + 1}: Added space after heading hash: `{original.strip()}` → `{fixed.strip()}`")

    def _fix_trailing_whitespace(self):
        """Remove trailing whitespace from lines."""
        for i, line in enumerate(self.lines):
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
