#!/usr/bin/env python3
"""
Markdown validator for Obsidian-compatible formatting standards.
Checks for syntax errors and style violations.
"""

import re
import os
import sys
from pathlib import Path
from typing import List, Tuple, Dict

from md_regions import protected_lines, fence_spans

DEFAULT_SKIP_FRAGMENTS = ('/.obsidian/', '/.claude/', '/node_modules/')


def _fragments_from_env(name, default=()):
    """Colon-separated path fragments from the env, casefolded.

    An unset variable falls back to `default`; an explicitly empty one means
    "no fragments", so the defaults can be switched off.
    """
    raw = os.environ.get(name)
    if raw is None:
        return tuple(f.casefold() for f in default)
    return tuple(part.strip().casefold() for part in raw.split(':') if part.strip())


def _prefixes_from_env(name):
    """Colon-separated path prefixes from the env, normalized for comparison.

    The gates compare against `Path(filepath).resolve()`, so a configured
    prefix has to go through the same normalization or it never matches: `~`
    expanded, symlinks resolved (on macOS /tmp is a symlink to /private/tmp),
    casefolded, and given a trailing separator so `/notes` cannot also enable
    `/notes-archive`.
    """
    raw = os.environ.get(name)
    if not raw:
        return ()
    out = []
    for part in raw.split(':'):
        part = part.strip()
        if not part:
            continue
        resolved = str(Path(part).expanduser().resolve()).casefold()
        if not resolved.endswith(os.sep):
            resolved += os.sep
        out.append(resolved)
    return tuple(out)


class MarkdownValidator:
    """Validates markdown against the bundled formatting rules."""

    def __init__(self, filepath: str):
        self.filepath = Path(filepath)
        self.lines = self.filepath.read_text(encoding='utf-8').split('\n')
        self.errors: List[Dict] = []
        self.warnings: List[Dict] = []
        # Lines inside code fences or frontmatter: never a style violation.
        self.protected = protected_lines(self.lines)
        # Frontmatter is protected from rewriting but still reported on: a
        # title: or description: value is prose Obsidian renders.
        self.fence_only = set()
        for start, end in fence_spans(self.lines):
            self.fence_only.update(range(start, end + 1))
        self.em_dash_exempt = em_dash_exempt(self.filepath)

    def validate(self) -> Dict:
        """Run all validations and return results."""
        self._check_blank_lines()
        self._check_syntax()
        self._check_tables()
        self._check_style()
        self._check_fence_nesting()

        return {
            'errors': self.errors,
            'warnings': self.warnings,
            'total_errors': len(self.errors),
            'total_warnings': len(self.warnings)
        }

    def _check_blank_lines(self):
        """Validate blank line rules."""
        in_table = False

        for i in range(len(self.lines)):
            line = self.lines[i]

            # Skip code fences and frontmatter
            if i in self.protected:
                in_table = False
                continue

            # Track tables
            if line.strip().startswith('|') and '---' in line:
                in_table = True
            elif line.strip().startswith('|') and '---' not in line:
                in_table = True
            elif not line.strip().startswith('|') and in_table:
                in_table = False

            # Check for blank lines within tables
            if in_table and not line.strip() and i > 0 and i < len(self.lines) - 1:
                if (self.lines[i-1].strip().startswith('|') or
                    self.lines[i+1].strip().startswith('|')):
                    self.errors.append({
                        'line': i + 1,
                        'type': 'spacing',
                        'message': 'Blank line found within table',
                        'suggestion': 'Remove blank line - keep table rows consecutive'
                    })

            # Check for blank line after heading. A table is the exception:
            # it needs a single blank line before it, so `## H` + blank +
            # `|...|` is correct and the fixer deliberately leaves it.
            if re.match(r'^#{1,6}\s+', line.strip()):
                next_content = next(
                    (l for l in self.lines[i + 1:] if l.strip()), '')
                if (i + 1 < len(self.lines) and not self.lines[i + 1].strip()
                        and not next_content.strip().startswith('|')):
                    self.errors.append({
                        'line': i + 1,
                        'type': 'spacing',
                        'message': 'Blank line after heading - headings should have no blank line after them',
                        'suggestion': 'Remove the blank line between the heading and the next content'
                    })

            # Check for multiple consecutive blank lines
            if not line.strip():
                if i > 0 and not self.lines[i-1].strip():
                    if i > 1 and not self.lines[i-2].strip():
                        # This is third+ consecutive blank
                        self.errors.append({
                            'line': i + 1,
                            'type': 'spacing',
                            'message': f'Multiple consecutive blank lines (found {self._count_consecutive_blanks(i)} blanks)',
                            'suggestion': 'Collapse to single blank line'
                        })

    def _count_consecutive_blanks(self, line_idx: int) -> int:
        """Count consecutive blank lines."""
        count = 1
        i = line_idx - 1
        while i >= 0 and not self.lines[i].strip():
            count += 1
            i -= 1
        return count

    def _check_syntax(self):
        """Validate markdown syntax errors."""
        for i, line in enumerate(self.lines):
            # Skip code fences and frontmatter
            if i in self.protected:
                continue

            # Literal brackets inside `code spans` are not broken links
            line = re.sub(r'`[^`\n]*`', '', line)

            # Check for broken wiki links
            if re.search(r'\[\[[^\]]+$', line) and ']]' not in line:
                self.errors.append({
                    'line': i + 1,
                    'type': 'syntax',
                    'message': 'Broken wiki link - missing closing brackets',
                    'suggestion': 'Wiki links must end with ]]'
                })

            # Check for broken regular links (missing closing paren)
            if re.search(r'\[[^\]]+\]\([^)]*$', line):
                self.errors.append({
                    'line': i + 1,
                    'type': 'syntax',
                    'message': 'Broken link - missing closing parenthesis',
                    'suggestion': 'Links must be formatted as [text](url)'
                })

            # Check for headings without space (e.g., #Heading or ##No-Space)
            # Only flag if there's no space AND it's actually a heading attempt
            if re.match(r'^#{1,6}[A-Za-z0-9]', line):
                fixed = re.sub(r'^(#{1,6})([A-Za-z0-9])', r'\1 \2', line)
                self.errors.append({
                    'line': i + 1,
                    'type': 'syntax',
                    'message': 'Heading missing space after hash',
                    'suggestion': f'Change to: {fixed}'
                })

    def _check_tables(self):
        """Validate table formatting."""
        i = 0
        while i < len(self.lines):
            line = self.lines[i]

            # Detect table start (header row)
            if i in self.protected:
                i += 1
                continue
            if line.strip().startswith('|') and i + 1 < len(self.lines):
                next_line = self.lines[i + 1]
                # Check if next line is separator (all cells are dashes)
                if next_line.strip().startswith('|') and '-' in next_line:
                    # Count columns from header
                    header_parts = line.split('|')[1:-1]  # Remove empty first/last
                    expected_cols = len(header_parts)

                    # Validate separator row
                    sep_parts = [p.strip() for p in next_line.split('|')[1:-1]]
                    if sep_parts and not all(re.match(r'^-+$|^:-+$|^-+:$|^:-+:$', p) for p in sep_parts):
                        self.errors.append({
                            'line': i + 2,
                            'type': 'table',
                            'message': 'Invalid separator row format',
                            'suggestion': 'Use only dashes and colons: |---|---|'
                        })

                    # Check all data rows following the separator
                    j = i + 2
                    while j < len(self.lines) and self.lines[j].strip().startswith('|'):
                        data_parts = self.lines[j].split('|')[1:-1]
                        if len(data_parts) != expected_cols:
                            self.errors.append({
                                'line': j + 1,
                                'type': 'table',
                                'message': f'Column count mismatch - expected {expected_cols}, found {len(data_parts)}',
                                'suggestion': 'Ensure all rows have the same number of columns'
                            })

                        # Check for trailing whitespace
                        if self.lines[j].rstrip() != self.lines[j]:
                            self.warnings.append({
                                'line': j + 1,
                                'type': 'style',
                                'message': 'Trailing whitespace',
                                'suggestion': 'Remove trailing spaces'
                            })
                        j += 1

                    i = j
                    continue

            i += 1

    def _check_style(self):
        """Validate style preferences."""
        # Track frontmatter boundaries (must start at line 0)
        frontmatter_delimiter_lines = []

        if self.lines and self.lines[0].strip() == '---':
            frontmatter_delimiter_lines.append(0)
            for i in range(1, len(self.lines)):
                if self.lines[i].strip() == '---':
                    frontmatter_delimiter_lines.append(i)
                    break

        # Em-dash check. House style objects to em-dashes inside sentences,
        # headings and titles, not to the spaced separator used in list items
        # and table cells ("- 9:00am — SBA to LAX", "- 2026-09-18 — note").
        # So: a spaced em-dash on a list item or table row is fine; anywhere
        # else, and any unspaced em-dash, is flagged.
        for i, line in enumerate(self.lines):
            if self.em_dash_exempt:
                break
            if i in self.fence_only:
                continue
            # Blank out code spans with same-length filler so the reported
            # column still matches the real line.
            scrubbed = re.sub(r'`[^`\n]*`', lambda m: ' ' * len(m.group(0)), line)
            if '—' not in scrubbed:
                continue

            stripped = scrubbed.strip()
            is_list = bool(re.match(r'^([-*+]|\d+\.)\s+', stripped))
            is_table = stripped.startswith('|')
            is_heading = bool(re.match(r'^#{1,6}\s+', stripped))

            for m in re.finditer('—', scrubbed):
                col = m.start() + 1
                spaced = (m.start() > 0 and scrubbed[m.start() - 1] == ' '
                          and m.end() < len(scrubbed) and scrubbed[m.end()] == ' ')
                if spaced and (is_list or is_table) and not is_heading:
                    continue  # formatting separator, allowed
                if spaced:
                    why = 'in prose - house style prohibits em-dashes in sentences, headings and titles'
                else:
                    why = 'unspaced - house style prohibits em-dashes inside words and sentences'
                self.errors.append({
                    'line': i + 1,
                    'type': 'style',
                    'message': f'Em-dash (—) at column {col} {why}',
                    'suggestion': ('Replace with comma, period, colon, parens, or " / ". '
                                   'A spaced em-dash is allowed as a separator in list '
                                   'items and table cells.')
                })

        # Check for level 1 headings outside of title position
        h1_count = 0
        h1_positions = []

        for i, line in enumerate(self.lines):
            if i in self.protected:
                continue
            if line.startswith('# ') and not line.startswith('## '):
                h1_count += 1
                h1_positions.append(i + 1)

        if h1_count > 1:
            for pos in h1_positions[1:]:  # Skip first one
                self.warnings.append({
                    'line': pos,
                    'type': 'style',
                    'message': 'Multiple level 1 headings - typically only document title should be level 1',
                    'suggestion': 'Use ## or ### instead'
                })

        # Check for horizontal rules (error - do not use)
        # Skip frontmatter delimiters
        for i, line in enumerate(self.lines):
            if re.match(r'^(-{3,}|\*{3,}|_{3,})$', line.strip()):
                # Skip frontmatter delimiters and anything inside a code fence
                if i in frontmatter_delimiter_lines or i in self.protected:
                    continue

                self.errors.append({
                    'line': i + 1,
                    'type': 'style',
                    'message': 'Horizontal rule found - do not use horizontal rules',
                    'suggestion': 'Remove the horizontal rule; use headings for visual separation'
                })

        # Check for wordy headings
        for i, line in enumerate(self.lines):
            if i in self.protected:
                continue
            if re.match(r'^#{1,6}\s+', line):
                heading_text = re.sub(r'^#{1,6}\s+', '', line).strip()

                # Check for explanatory content in parentheses
                if '(' in heading_text and ')' in heading_text:
                    # Extract heading without parenthetical
                    main_heading = re.sub(r'\s*\([^)]+\)\s*', '', heading_text).strip()
                    paren_content = re.search(r'\(([^)]+)\)', heading_text)
                    if paren_content:
                        context_note = paren_content.group(1)
                        self.warnings.append({
                            'line': i + 1,
                            'type': 'style',
                            'message': 'Heading contains explanatory text in parentheses - keep headings concise',
                            'suggestion': f'Use short heading "{main_heading}" with context note "({context_note})" on next line'
                        })

                # Check for overly long headings (>60 chars)
                elif len(heading_text) > 60:
                    self.warnings.append({
                        'line': i + 1,
                        'type': 'style',
                        'message': f'Heading is too long ({len(heading_text)} chars) - keep headings concise',
                        'suggestion': 'Consider shortening or moving context to a line below the heading'
                    })

    def _check_fence_nesting(self):
        """Detect unclosed/mis-nested code fences.

        Catches the common error of using 3-backtick outer fences around content
        that itself contains 3-backtick fences — outer closes prematurely and
        the file ends with an unclosed fence (or rendering goes wrong).
        Per CommonMark, nested fences require the outer to be longer (4+ ticks)
        or use a different char (~~~).
        """
        fences = []
        for i, line in enumerate(self.lines):
            # CommonMark: fences indented 4+ spaces are not fences (indented code block)
            m = re.match(r'^(\s{0,3})(`{3,}|~{3,})(.*)$', line)
            if not m:
                continue
            marker, info = m.group(2), m.group(3).strip()
            fences.append({
                'line': i + 1,
                'char': marker[0],
                'length': len(marker),
                'has_info': bool(info),
            })

        # Walk fence sequence as state machine
        in_block = False
        open_info = None  # dict from fences when block opened

        for f in fences:
            if not in_block:
                in_block = True
                open_info = f
            else:
                # Closing fence: same char, length >= open length, no info string
                if (f['char'] == open_info['char']
                        and f['length'] >= open_info['length']
                        and not f['has_info']):
                    in_block = False
                    open_info = None
                # else: literal text inside the open block — no state change

        if in_block and open_info:
            ticks = open_info['char'] * (open_info['length'] + 1)
            self.errors.append({
                'line': open_info['line'],
                'type': 'syntax',
                'message': (
                    f"Unclosed code fence opened here "
                    f"({open_info['length']} {open_info['char']}s, never matched by a closing fence)"
                ),
                'suggestion': (
                    f"If this fence is meant to wrap content that itself contains code fences, "
                    f"bump the outer fence to {ticks} (or switch to ~~~). "
                    f"Otherwise, add a matching closing fence."
                )
            })

    def report(self) -> str:
        """Generate human-readable report."""
        output = []

        if self.errors:
            output.append("ERRORS:")
            for err in self.errors:
                output.append(f"  ❌ Line {err['line']}: {err['message']}")
                output.append(f"     → {err['suggestion']}")

        if self.warnings:
            if self.errors:
                output.append("")
            output.append("WARNINGS:")
            for warn in self.warnings:
                output.append(f"  ⚠️  Line {warn['line']}: {warn['message']}")
                output.append(f"     → {warn['suggestion']}")

        if not self.errors and not self.warnings:
            output.append("✓ No issues found!")
        else:
            output.append("")
            output.append(f"Summary: {len(self.errors)} errors, {len(self.warnings)} warnings")

        return '\n'.join(output)


def skip_fragments() -> tuple:
    """Path fragments marking files whose conventions are not prose rules.

    MARKDOWN_LINTER_SKIP replaces the defaults outright when set.
    """
    return _fragments_from_env('MARKDOWN_LINTER_SKIP', DEFAULT_SKIP_FRAGMENTS)


def should_skip(filepath: str) -> bool:
    """True if this file's conventions are not Obsidian prose rules.

    Case-insensitive: macOS paths are case-insensitive but Path.resolve() does
    not normalize case, so a differently-cased folder would otherwise slip past
    the skip list and get auto-fixed.
    """
    resolved = str(Path(filepath).resolve()).casefold()
    return any(frag in resolved for frag in skip_fragments())


def fix_allowed(filepath: str) -> bool:
    """True if auto-fix may rewrite this file.

    With no MARKDOWN_LINTER_FIX_PATHS configured there is no restriction.
    """
    prefixes = _prefixes_from_env('MARKDOWN_LINTER_FIX_PATHS')
    if not prefixes:
        return True
    resolved = str(Path(filepath).resolve()).casefold()
    if not resolved.endswith(os.sep):
        resolved += os.sep
    return any(resolved.startswith(prefix) for prefix in prefixes)


def em_dash_exempt(filepath) -> bool:
    """True if em-dashes are intentional prose style in this file's directory."""
    prefixes = _prefixes_from_env('MARKDOWN_LINTER_EM_DASH_OK')
    if not prefixes:
        return False
    resolved = str(Path(filepath).resolve()).casefold()
    if not resolved.endswith(os.sep):
        resolved += os.sep
    return any(resolved.startswith(prefix) for prefix in prefixes)


def _run_autofix(filepath: str) -> List[str]:
    """Run deterministic auto-fixers on the file in place, return change list.

    Imports are local so the validator stays usable as a library. fix_tables.py
    is intentionally excluded — its column-alignment truncates cells when row
    length doesn't match, which can silently lose content.
    """
    from fix_spacing import SpacingFixer
    from fix_syntax import SyntaxFixer

    all_changes: List[str] = []

    # Run to a fixed point (capped): one fixer's output can create work for the
    # other (e.g. `#NoSpace` becomes a heading, which then needs its trailing
    # blank removed). Without this, a second invocation keeps changing the file.
    for _ in range(3):
        round_changes: List[str] = []

        spacing = SpacingFixer(filepath)
        _, spacing_changes = spacing.fix()
        if spacing_changes:
            spacing.save()
            round_changes.extend(spacing_changes)

        # SyntaxFixer reads from disk, so it picks up the spacing-fixed content
        syntax = SyntaxFixer(filepath)
        _, syntax_changes = syntax.fix()
        if syntax_changes:
            syntax.save()
            round_changes.extend(syntax_changes)

        if not round_changes:
            break
        all_changes.extend(round_changes)

    return all_changes


def main():
    """Main entry point.

    Default: auto-fix deterministic issues, then validate residual.
    --check / --no-fix: validate only, do not modify the file.
    """
    args = sys.argv[1:]
    check_only = False
    if '--check' in args:
        check_only = True
        args.remove('--check')
    if '--no-fix' in args:
        check_only = True
        args.remove('--no-fix')
    if '--force' in args:
        args.remove('--force')

    if not args:
        print("Usage: python3 validate_markdown.py [--check] <filepath>")
        print("  Default: auto-fix deterministic issues, then report residual")
        print("  --check / --no-fix: validate only, do not modify the file")
        sys.exit(1)

    filepath = args[0]

    # Never lint files whose conventions are not prose rules (config folders,
    # vendored dependencies, plus anything in MARKDOWN_LINTER_SKIP).
    if should_skip(filepath):
        # Say so rather than exiting silently: a silent exit reads as "clean".
        print(f"NOTE: {Path(filepath).name} is on the linter skip list "
              f"({', '.join(skip_fragments())}) - nothing checked.",
              file=sys.stderr)
        sys.exit(0)

    if not Path(filepath).is_file():
        print(f"Error: not a file: {filepath}")
        sys.exit(1)

    force = False
    if '--force' in sys.argv[1:]:
        force = True

    if not check_only and not force:
        if not fix_allowed(filepath):
            check_only = True
            print(f"NOTE: {Path(filepath).name} is outside "
                  "MARKDOWN_LINTER_FIX_PATHS - reporting only, no auto-fix "
                  "(pass --force to override).\n")

    fixed_changes: List[str] = []
    if not check_only:
        fixed_changes = _run_autofix(filepath)

    validator = MarkdownValidator(filepath)
    results = validator.validate()

    if fixed_changes:
        print(f"AUTO-FIXED {len(fixed_changes)} issue(s):")
        for change in fixed_changes:
            print(f"  ✓ {change}")
        if results['errors'] or results['warnings']:
            print()

    print(validator.report())

    if results['total_errors'] > 0:
        sys.exit(1)
    sys.exit(0)


if __name__ == '__main__':
    main()
