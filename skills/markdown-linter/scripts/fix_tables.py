#!/usr/bin/env python3
"""
Auto-fix table formatting issues in markdown files.
Aligns columns, fixes separators, removes trailing whitespace.
"""

import re
from pathlib import Path
from typing import List, Tuple

class TableFixer:
    """Fixes table formatting in markdown."""

    def __init__(self, filepath: str):
        self.filepath = Path(filepath)
        self.original_lines = self.filepath.read_text(encoding='utf-8').split('\n')
        self.lines = self.original_lines.copy()
        self.changes = []

    def fix(self) -> Tuple[List[str], List[str]]:
        """Fix table formatting issues and return fixed lines and change list."""
        self._remove_trailing_whitespace_in_tables()
        self._fix_separator_rows()
        self._align_table_columns()

        return self.lines, self.changes

    def _remove_trailing_whitespace_in_tables(self):
        """Remove trailing whitespace from table rows."""
        for i, line in enumerate(self.lines):
            if line.strip().startswith('|') and line != line.rstrip():
                self.lines[i] = line.rstrip()
                self.changes.append(f"Line {i + 1}: Removed trailing whitespace")

    def _fix_separator_rows(self):
        """Fix malformed separator rows in tables."""
        i = 0
        while i < len(self.lines):
            line = self.lines[i]

            # Check if this line looks like a separator row
            if line.strip().startswith('|'):
                # Check if next line might be content that follows a separator
                if i + 1 < len(self.lines):
                    next_line = self.lines[i + 1]

                    # If previous line is a table row, this might be a separator
                    if i > 0 and self.lines[i - 1].strip().startswith('|'):
                        # Check if current line should be a separator
                        parts = [p.strip() for p in line.split('|')[1:-1]]

                        # If we have dashes and pipes, might be separator
                        if all(re.match(r'^-+$|^:-+$|^-+:$|^:-+:$|^:?-+:?$', p) for p in parts if p):
                            # This is a valid separator, ensure proper format
                            col_count = len(parts)
                            if col_count > 0:
                                # Rebuild separator with proper format
                                new_sep = '|' + '|'.join(['---'] * col_count) + '|'
                                if self.lines[i] != new_sep:
                                    self.lines[i] = new_sep
                                    self.changes.append(f"Line {i + 1}: Fixed separator row format")

            i += 1

    def _align_table_columns(self):
        """Align table columns by padding cells."""
        i = 0
        while i < len(self.lines):
            line = self.lines[i]

            # Check if this is a table header
            if line.strip().startswith('|') and i + 1 < len(self.lines):
                next_line = self.lines[i + 1]

                # Check if next line is a separator
                if next_line.strip().startswith('|') and '-' in next_line:
                    # This is a table! Collect all rows
                    table_start = i
                    table_rows = [line]
                    table_rows.append(next_line)  # separator
                    i += 2

                    # Collect data rows
                    while i < len(self.lines) and self.lines[i].strip().startswith('|'):
                        table_rows.append(self.lines[i])
                        i += 1

                    # Check column consistency
                    header = [c.strip() for c in table_rows[0].split('|')[1:-1]]
                    expected_cols = len(header)

                    # Validate and fix data rows
                    fixed_rows = [table_rows[0], table_rows[1]]  # Keep header and separator
                    for row_idx, row in enumerate(table_rows[2:], start=2):
                        cells = [c.strip() for c in row.split('|')[1:-1]]

                        # Pad or trim cells to match column count
                        if len(cells) != expected_cols:
                            if len(cells) < expected_cols:
                                cells.extend([''] * (expected_cols - len(cells)))
                            else:
                                cells = cells[:expected_cols]

                            new_row = '|' + '|'.join(cells) + '|'
                            fixed_rows.append(new_row)
                            self.changes.append(f"Line {table_start + row_idx + 1}: Fixed column count ({len(cells)} columns)")
                        else:
                            fixed_rows.append(row)

                    # Replace table rows in self.lines
                    for idx, fixed_row in enumerate(fixed_rows):
                        self.lines[table_start + idx] = fixed_row

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
        print("Usage: python3 fix_tables.py <filepath> [output_filepath]")
        sys.exit(1)

    filepath = sys.argv[1]
    output_filepath = sys.argv[2] if len(sys.argv) > 2 else None

    if not Path(filepath).exists():
        print(f"Error: File not found: {filepath}")
        sys.exit(1)

    fixer = TableFixer(filepath)
    fixed_lines, changes = fixer.fix()

    if changes:
        print(f"Fixed {len(changes)} table formatting issues:")
        for change in changes:
            print(f"  ✓ {change}")
        fixer.save(output_filepath)
        print(f"\nSaved to: {output_filepath or filepath}")
    else:
        print("No table formatting issues found.")


if __name__ == '__main__':
    main()
