#!/usr/bin/env python3
"""
Auto-fix spacing issues in markdown files.
Removes excessive blank lines and applies blank line rules.
"""

import re
from pathlib import Path
from typing import List, Tuple

class SpacingFixer:
    """Fixes blank line issues in markdown."""

    def __init__(self, filepath: str):
        self.filepath = Path(filepath)
        self.original_lines = self.filepath.read_text(encoding='utf-8').split('\n')
        self.lines = self.original_lines.copy()
        self.changes = []

    def fix(self) -> Tuple[List[str], List[str]]:
        """Fix spacing issues and return fixed lines and change list.

        Order matters: removing horizontal rules can leave doubled blank
        lines behind, so collapse blanks after HR removal (not before).
        """
        self._remove_horizontal_rules()
        self._remove_multiple_blank_lines()
        self._fix_blank_lines_in_tables()
        self._apply_spacing_rules()

        return self.lines, self.changes

    def _is_heading(self, line: str) -> bool:
        """Check if line is a markdown heading."""
        return bool(re.match(r'^#{1,6}\s+', line.strip()))

    def _is_list_item(self, line: str) -> bool:
        """Check if line is a list item (numbered or bulleted)."""
        stripped = line.strip()
        # Bulleted list
        if re.match(r'^[-*+]\s+', stripped):
            return True
        # Numbered list
        if re.match(r'^\d+\.\s+', stripped):
            return True
        return False

    def _is_indented_list_item(self, line: str) -> bool:
        """Check if line is an indented/nested list item."""
        # Has leading spaces and then list marker
        return bool(re.match(r'^\s+[-*+\d]', line))

    def _is_horizontal_rule(self, line: str) -> bool:
        """Check if line is a horizontal rule."""
        stripped = line.strip()
        return bool(re.match(r'^(-{3,}|\*{3,}|_{3,})$', stripped))

    def _is_code_fence(self, line: str) -> bool:
        """Check if line is a code fence (``` or ~~~)."""
        stripped = line.strip()
        return stripped.startswith('```') or stripped.startswith('~~~')

    def _is_quote(self, line: str) -> bool:
        """Check if line is a blockquote."""
        return line.strip().startswith('>')

    def _is_frontmatter_delimiter(self, line: str) -> bool:
        """Check if line is frontmatter delimiter (---)."""
        return line.strip() == '---'

    def _is_table_row(self, line: str) -> bool:
        """Check if line is a table row (header, separator, or data)."""
        return line.strip().startswith('|')

    def _is_paragraph(self, line: str) -> bool:
        """Check if line is a paragraph (has content but isn't special syntax)."""
        stripped = line.strip()
        if not stripped:
            return False
        if self._is_heading(line):
            return False
        if self._is_list_item(line):
            return False
        if self._is_horizontal_rule(line):
            return False
        if self._is_code_fence(line):
            return False
        if self._is_quote(line):
            return False
        if self._is_frontmatter_delimiter(line):
            return False
        if self._is_table_row(line):
            return False
        return True

    def _remove_horizontal_rules(self):
        """Remove horizontal rules that aren't frontmatter delimiters."""
        # Identify frontmatter lines (must start at line 0)
        frontmatter_lines = set()
        if self.lines and self._is_frontmatter_delimiter(self.lines[0]):
            frontmatter_lines.add(0)
            for j in range(1, len(self.lines)):
                if self._is_frontmatter_delimiter(self.lines[j]):
                    frontmatter_lines.add(j)
                    break

        i = 0
        while i < len(self.lines):
            if i in frontmatter_lines:
                i += 1
                continue

            # Skip content inside frontmatter
            if frontmatter_lines and min(frontmatter_lines) < i < max(frontmatter_lines):
                i += 1
                continue

            # Remove horizontal rules outside frontmatter
            if self._is_horizontal_rule(self.lines[i]):
                self.changes.append(f"Line {i + 1}: Removed horizontal rule")
                self.lines.pop(i)
                continue

            i += 1

    def _remove_multiple_blank_lines(self):
        """Collapse multiple consecutive blank lines to single blank."""
        i = 0
        while i < len(self.lines):
            line = self.lines[i]

            # Check if this and next lines are blank
            if not line.strip() and i + 1 < len(self.lines):
                blank_count = 1
                j = i + 1

                # Count consecutive blank lines
                while j < len(self.lines) and not self.lines[j].strip():
                    blank_count += 1
                    j += 1

                # If more than one blank, remove extras
                if blank_count > 1:
                    # Keep first blank, remove rest
                    for _ in range(blank_count - 1):
                        self.lines.pop(i + 1)
                    self.changes.append(f"Line {i + 1}: Collapsed {blank_count} blank lines to 1")

            i += 1

    def _fix_blank_lines_in_tables(self):
        """Remove blank lines that appear within tables."""
        i = 0
        in_table = False

        while i < len(self.lines):
            line = self.lines[i]

            # Detect table rows
            if line.strip().startswith('|'):
                in_table = True

            # Check for blank line within table
            if in_table and not line.strip():
                # Look ahead to see if next non-blank is table continuation
                j = i + 1
                while j < len(self.lines) and not self.lines[j].strip():
                    j += 1

                if j < len(self.lines) and self.lines[j].strip().startswith('|'):
                    # This blank is within a table, remove it
                    self.lines.pop(i)
                    self.changes.append(f"Line {i + 1}: Removed blank line within table")
                    continue
                else:
                    in_table = False

            i += 1

    def _apply_spacing_rules(self):
        """Apply comprehensive spacing rules based on line type transitions."""
        i = 0
        in_code_block = False
        in_frontmatter = False
        frontmatter_count = 0

        while i < len(self.lines) - 1:
            current = self.lines[i]
            next_line = self.lines[i + 1] if i + 1 < len(self.lines) else ""
            next_next = self.lines[i + 2] if i + 2 < len(self.lines) else ""

            # Track frontmatter sections (skip spacing rules inside)
            if self._is_frontmatter_delimiter(current):
                frontmatter_count += 1
                if frontmatter_count % 2 == 1:
                    in_frontmatter = True
                else:
                    in_frontmatter = False
                i += 1
                continue

            if in_frontmatter:
                i += 1
                continue

            # Track code blocks (skip spacing rules inside)
            if self._is_code_fence(current):
                in_code_block = not in_code_block
                i += 1
                continue

            if in_code_block:
                i += 1
                continue

            # Now apply spacing rules based on transitions
            is_blank_between = not next_line.strip()

            # Rule: Heading → anything should have NO blank
            if self._is_heading(current) and is_blank_between:
                if self._is_heading(next_next) or self._is_paragraph(next_next) or \
                   self._is_list_item(next_next) or self._is_quote(next_next) or \
                   self._is_code_fence(next_next) or self._is_horizontal_rule(next_next):
                    self.lines.pop(i + 1)
                    self.changes.append(f"Line {i + 1}: Removed blank after heading")
                    continue

            # Rule: Paragraph → List should have YES blank
            if self._is_paragraph(current) and not is_blank_between and self._is_list_item(next_line):
                self.lines.insert(i + 1, "")
                self.changes.append(f"Line {i + 1}: Added blank between paragraph and list")
                i += 1
                continue

            # Rule: Paragraph → Paragraph must have blank between
            if self._is_paragraph(current) and not is_blank_between and self._is_paragraph(next_line):
                self.lines.insert(i + 1, "")
                self.changes.append(f"Line {i + 1}: Added blank between paragraphs")
                i += 1
                continue

            # Rule: List item → List item should have NO blank (same level)
            if self._is_list_item(current) and is_blank_between and self._is_list_item(next_next):
                # Check if they're at similar indentation levels
                curr_indent = len(current) - len(current.lstrip())
                next_indent = len(next_next) - len(next_next.lstrip())
                if abs(curr_indent - next_indent) <= 4:  # Allow small indent differences
                    self.lines.pop(i + 1)
                    self.changes.append(f"Line {i + 1}: Removed blank between list items")
                    continue

            # Rule: List/Paragraph → Heading should have NO blank
            if (self._is_list_item(current) or self._is_paragraph(current)) and \
               is_blank_between and self._is_heading(next_next):
                self.lines.pop(i + 1)
                self.changes.append(f"Line {i + 1}: Removed blank before heading")
                continue

            # Rule: Horizontal rule → Heading should have NO blank
            if self._is_horizontal_rule(current) and is_blank_between and self._is_heading(next_next):
                self.lines.pop(i + 1)
                self.changes.append(f"Line {i + 1}: Removed blank between horizontal rule and heading")
                continue

            i += 1

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
        print("Usage: python3 fix_spacing.py <filepath> [output_filepath]")
        sys.exit(1)

    filepath = sys.argv[1]
    output_filepath = sys.argv[2] if len(sys.argv) > 2 else None

    if not Path(filepath).exists():
        print(f"Error: File not found: {filepath}")
        sys.exit(1)

    fixer = SpacingFixer(filepath)
    fixed_lines, changes = fixer.fix()

    if changes:
        print(f"Fixed {len(changes)} spacing issues:")
        for change in changes:
            print(f"  ✓ {change}")
        fixer.save(output_filepath)
        print(f"\nSaved to: {output_filepath or filepath}")
    else:
        print("No spacing issues found.")


if __name__ == '__main__':
    main()
