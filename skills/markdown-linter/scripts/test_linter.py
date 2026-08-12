#!/usr/bin/env python3
"""Tests for markdown linter fix_spacing and validate_markdown."""

import subprocess
import tempfile
import os
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VALIDATE_SCRIPT = os.path.join(SCRIPT_DIR, 'validate_markdown.py')

# Add script directory to path
sys.path.insert(0, SCRIPT_DIR)

from fix_spacing import SpacingFixer
from fix_syntax import SyntaxFixer
from validate_markdown import MarkdownValidator


def _run_cli(content: str, *flags) -> tuple:
    """Write content to temp file, run validate_markdown.py CLI, return (returncode, stdout, final_content)."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False, encoding='utf-8') as f:
        f.write(content)
        path = f.name
    try:
        result = subprocess.run(
            ['python3', VALIDATE_SCRIPT, *flags, path],
            capture_output=True, text=True
        )
        with open(path, encoding='utf-8') as f:
            final = f.read()
        return result.returncode, result.stdout, final
    finally:
        os.unlink(path)


def _fix(content: str) -> str:
    """Write content to temp file, run SpacingFixer, return result."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False, encoding='utf-8') as f:
        f.write(content)
        f.flush()
        fixer = SpacingFixer(f.name)
        lines, _ = fixer.fix()
        os.unlink(f.name)
        return '\n'.join(lines)


def _fix_syntax(content: str) -> tuple:
    """Write content to temp file, run SyntaxFixer, return (joined_lines, changes)."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False, encoding='utf-8') as f:
        f.write(content)
        f.flush()
        fixer = SyntaxFixer(f.name)
        lines, changes = fixer.fix()
        os.unlink(f.name)
        return '\n'.join(lines), changes


def _validate(content: str) -> dict:
    """Write content to temp file, run MarkdownValidator, return results."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False, encoding='utf-8') as f:
        f.write(content)
        f.flush()
        validator = MarkdownValidator(f.name)
        results = validator.validate()
        os.unlink(f.name)
        return results


# === SpacingFixer tests ===

class TestHeadingSpacing(unittest.TestCase):

    def test_heading_to_paragraph_no_blank(self):
        """Heading followed by blank then paragraph -> blank removed."""
        result = _fix("## Overview\n\nThis is text.")
        self.assertEqual(result, "## Overview\nThis is text.")

    def test_heading_to_heading_no_blank(self):
        """Heading followed by blank then subheading -> blank removed."""
        result = _fix("## Main\n\n### Sub")
        self.assertEqual(result, "## Main\n### Sub")

    def test_heading_to_list_no_blank(self):
        """Heading followed by list -> no blank (already works, verify)."""
        result = _fix("## List\n- item 1\n- item 2")
        self.assertEqual(result, "## List\n- item 1\n- item 2")

    def test_heading_to_list_removes_blank(self):
        """Heading followed by blank then list -> blank removed."""
        result = _fix("## List\n\n- item 1\n- item 2")
        self.assertEqual(result, "## List\n- item 1\n- item 2")


class TestParagraphSpacing(unittest.TestCase):

    def test_paragraphs_keep_blank_between(self):
        """Two paragraphs with blank between -> blank preserved."""
        result = _fix("First paragraph.\n\nSecond paragraph.")
        self.assertEqual(result, "First paragraph.\n\nSecond paragraph.")

    def test_paragraphs_add_blank_if_missing(self):
        """Two paragraphs without blank -> blank added."""
        result = _fix("First paragraph.\nSecond paragraph.")
        self.assertEqual(result, "First paragraph.\n\nSecond paragraph.")

    def test_paragraph_to_quote_keeps_blank(self):
        """Paragraph then blank then blockquote -> blank preserved."""
        result = _fix("Here is context.\n\n> A quote here.")
        self.assertEqual(result, "Here is context.\n\n> A quote here.")

    def test_paragraph_to_code_keeps_blank(self):
        """Paragraph then blank then code fence -> blank preserved."""
        result = _fix("Here is context.\n\n```python\ncode\n```")
        self.assertEqual(result, "Here is context.\n\n```python\ncode\n```")


class TestHorizontalRules(unittest.TestCase):

    def test_horizontal_rule_removed(self):
        """--- line between sections -> removed entirely."""
        result = _fix("## Section 1\nSome text.\n\n---\n\n## Section 2\nMore text.")
        self.assertNotIn("\n---\n", result)
        self.assertIn("## Section 1", result)
        self.assertIn("## Section 2", result)

    def test_horizontal_rule_frontmatter_preserved(self):
        """Frontmatter --- delimiters -> NOT removed."""
        content = "---\ntitle: Test\n---\n## Heading\nText."
        result = _fix(content)
        # Count --- occurrences: should still have 2 for frontmatter
        lines = result.split('\n')
        fm_count = sum(1 for l in lines if l.strip() == '---')
        self.assertEqual(fm_count, 2)

    def test_horizontal_rule_stars_removed(self):
        """*** horizontal rule also removed."""
        result = _fix("Text above.\n\n***\n\nText below.")
        self.assertNotIn("***", result)

    def test_horizontal_rule_underscores_removed(self):
        """___ horizontal rule also removed."""
        result = _fix("Text above.\n\n___\n\nText below.")
        self.assertNotIn("___", result)


class TestMultipleBlanks(unittest.TestCase):

    def test_multiple_blanks_collapsed(self):
        """Multiple blank lines collapsed to single (already works, verify)."""
        result = _fix("Text.\n\n\n\nMore text.")
        self.assertEqual(result, "Text.\n\nMore text.")

    def test_hr_removal_does_not_leave_doubled_blanks(self):
        """Removing an HR surrounded by blanks should not leave 2 blank lines."""
        result = _fix("Some text.\n\n---\n\n## Heading\nMore.")
        self.assertNotIn("\n\n\n", result)


# === MarkdownValidator tests ===

class TestValidatorHorizontalRules(unittest.TestCase):

    def test_warns_horizontal_rule(self):
        """HR flagged as error (not just warning)."""
        results = _validate("## Section\nText.\n---\n## Next")
        hr_errors = [e for e in results['errors'] if 'orizontal rule' in e['message'].lower()]
        self.assertTrue(len(hr_errors) > 0, "Horizontal rule should be an error")

    def test_no_false_positive_frontmatter(self):
        """Frontmatter --- not flagged as horizontal rule."""
        results = _validate("---\ntitle: Test\n---\n## Heading\nText.")
        hr_errors = [e for e in results['errors'] if 'orizontal rule' in e['message'].lower()]
        hr_warnings = [w for w in results['warnings'] if 'orizontal rule' in w['message'].lower()]
        self.assertEqual(len(hr_errors) + len(hr_warnings), 0,
                         "Frontmatter delimiters should not be flagged")


class TestValidatorBlankAfterHeading(unittest.TestCase):

    def test_detects_blank_after_heading(self):
        """Blank line after heading flagged as error."""
        results = _validate("## Heading\n\nSome text.")
        blank_errors = [e for e in results['errors']
                        if 'blank' in e['message'].lower() and 'heading' in e['message'].lower()]
        self.assertTrue(len(blank_errors) > 0, "Blank after heading should be an error")

    def test_paragraphs_with_blank_ok(self):
        """No error for blank between paragraphs."""
        results = _validate("First paragraph.\n\nSecond paragraph.")
        blank_errors = [e for e in results['errors']
                        if 'blank' in e['message'].lower() and 'heading' in e['message'].lower()]
        self.assertEqual(len(blank_errors), 0, "Blank between paragraphs should be fine")


# === CLI behavior tests (auto-fix by default, --check for read-only) ===

class TestCLIDefaultAutofix(unittest.TestCase):

    def test_default_autofix_modifies_file(self):
        """Default mode rewrites file: blank-after-heading and HR removed."""
        content = "## Heading\n\nSome text.\n\n---\n\n## Next\nMore."
        rc, stdout, final = _run_cli(content)
        self.assertIn("AUTO-FIXED", stdout)
        self.assertNotIn("\n---\n", final)
        self.assertNotIn("## Heading\n\nSome text.", final)
        self.assertEqual(rc, 0)

    def test_default_autofix_reports_residual_warnings(self):
        """Auto-fix clears errors; wordy-heading warning still surfaces."""
        content = "## Heading (with parens)\nText.\n\n---\n\n## Next\nMore."
        rc, stdout, final = _run_cli(content)
        self.assertIn("AUTO-FIXED", stdout)
        self.assertIn("Heading contains explanatory text", stdout)
        self.assertEqual(rc, 0)  # only warnings remain

    def test_clean_file_no_changes(self):
        """Well-formed file: no AUTO-FIXED line, no errors, exit 0."""
        content = "## Heading\nSome text.\n\nAnother paragraph."
        rc, stdout, final = _run_cli(content)
        self.assertNotIn("AUTO-FIXED", stdout)
        self.assertEqual(content, final)
        self.assertEqual(rc, 0)

    def test_exit_zero_when_only_warnings_remain(self):
        """Auto-fix removes errors; remaining warnings should not fail."""
        content = "## Foo (bar)\nText."
        rc, stdout, final = _run_cli(content)
        self.assertEqual(rc, 0)

    def test_exit_one_when_unfixable_error_remains(self):
        """Broken wiki link is an error with no auto-fixer → exit 1."""
        content = "## Heading\nSee [[Broken Link"
        rc, stdout, final = _run_cli(content)
        self.assertIn("Broken wiki link", stdout)
        self.assertEqual(rc, 1)


class TestCLICheckFlag(unittest.TestCase):

    def test_check_flag_preserves_file(self):
        """--check: file unchanged, errors reported."""
        content = "## Heading\n\nText.\n\n---\n\n## Next\nMore."
        rc, stdout, final = _run_cli(content, '--check')
        self.assertEqual(content, final)
        self.assertNotIn("AUTO-FIXED", stdout)
        self.assertIn("Blank line after heading", stdout)
        self.assertIn("Horizontal rule", stdout)
        self.assertEqual(rc, 1)

    def test_no_fix_alias_preserves_file(self):
        """--no-fix is an alias for --check."""
        content = "## Heading\n\nText."
        rc, stdout, final = _run_cli(content, '--no-fix')
        self.assertEqual(content, final)
        self.assertNotIn("AUTO-FIXED", stdout)
        self.assertEqual(rc, 1)


# === SyntaxFixer bold-formatting tests ===

class TestSyntaxFixerBold(unittest.TestCase):
    """Regression tests for the malformed-bold auto-fixer.

    Bug: the fix-regex `\\*([a-zA-Z]+)\\*\\*` matches the second `*` of a
    valid `**word**` opener, producing `***word**` and adding two more
    asterisks on each subsequent run. The fix should leave valid bold alone
    while still repairing genuinely malformed `*word**` (missing opener).
    """

    def test_valid_bold_with_emdash_unchanged(self):
        """**RED** followed by space-emdash-text must not be mutated."""
        content = "1. **RED** — write a failing test"
        result, changes = _fix_syntax(content)
        self.assertEqual(result, content)
        self.assertEqual(changes, [])

    def test_valid_bold_at_end_of_line_unchanged(self):
        """**word** at end of line must not be mutated."""
        content = "Status: **done**"
        result, changes = _fix_syntax(content)
        self.assertEqual(result, content)
        self.assertEqual(changes, [])

    def test_multiple_valid_bolds_unchanged(self):
        """Multiple **bold** spans on one line must not be mutated."""
        content = "**RED** then **GREEN** then **REFACTOR**"
        result, changes = _fix_syntax(content)
        self.assertEqual(result, content)
        self.assertEqual(changes, [])

    def test_genuine_malformed_still_fixed(self):
        """Genuine *word** (missing opener) IS still fixed to **word**."""
        content = "Status: *done**"
        result, changes = _fix_syntax(content)
        self.assertEqual(result, "Status: **done**")
        self.assertTrue(any("malformed bold" in c for c in changes))

    def test_idempotent_on_valid_bold(self):
        """Running the fixer twice on valid bold adds no asterisks."""
        content = "1. **RED** — write a failing test\n2. **GREEN** — make it pass"
        first, _ = _fix_syntax(content)
        second, _ = _fix_syntax(first)
        self.assertEqual(content, first)
        self.assertEqual(first, second)

    def test_idempotent_via_cli(self):
        """End-to-end: running validate_markdown.py twice is idempotent."""
        content = "## Header\n1. **RED** — write a failing test\n2. **GREEN** — make it pass\n"
        rc1, _, after_first = _run_cli(content)
        rc2, _, after_second = _run_cli(after_first)
        self.assertEqual(content, after_first,
                         "First run mutated valid bold")
        self.assertEqual(after_first, after_second,
                         "Second run mutated previously-stable file")


if __name__ == '__main__':
    unittest.main()
