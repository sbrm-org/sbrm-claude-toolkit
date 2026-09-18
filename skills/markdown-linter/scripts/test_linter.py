#!/usr/bin/env python3
"""Tests for markdown linter fix_spacing and validate_markdown."""

import subprocess
import tempfile
import os
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VALIDATE_SCRIPT = os.path.join(SCRIPT_DIR, 'validate_markdown.py')

# Add script directory to path
sys.path.insert(0, SCRIPT_DIR)

SKILL_ROOT = Path(__file__).resolve().parent.parent

from fix_spacing import SpacingFixer
from fix_syntax import SyntaxFixer
import validate_markdown
from validate_markdown import MarkdownValidator


def _run_cli(content: str, *flags) -> tuple:
    """Write content to temp file, run validate_markdown.py CLI, return (returncode, stdout, final_content)."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False, encoding='utf-8') as f:
        f.write(content)
        path = f.name
    try:
        result = subprocess.run(
            ['python3', VALIDATE_SCRIPT, '--force', *flags, path],
            capture_output=True, text=True
        )
        with open(path, encoding='utf-8') as f:
            final = f.read()
        return result.returncode, result.stdout, final
    finally:
        os.unlink(path)


def _fix_full(content: str) -> str:
    """Run the full CLI auto-fix pipeline (forced) and return the file."""
    _, _, final = _run_cli(content)
    return final


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

    def test_hard_wrapped_prose_is_left_alone(self):
        """Adjacent prose lines are one paragraph - never split them.

        The old rule inserted a blank between every pair of wrapped lines,
        which doubled the length of hard-wrapped READMEs.
        """
        src = ("This is a hard-wrapped paragraph that the author chose to\n"
               "break at eighty columns, which markdown renders as one\n"
               "paragraph with soft breaks.")
        self.assertEqual(_fix(src), src)

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


class TestProtectedRegions(unittest.TestCase):
    """Code fences and frontmatter must survive every auto-fixer."""

    def test_shebang_in_code_fence_untouched(self):
        src = "## Shell\n```bash\n#!/usr/bin/env bash\n#comment\necho hi\n```"
        self.assertEqual(_fix_syntax(src)[0], src)

    def test_yaml_dashes_in_code_fence_untouched(self):
        src = "## Example\n```yaml\n---\ntitle: x\n---\n```"
        self.assertEqual(_fix(src), src)

    def test_blank_lines_in_code_fence_untouched(self):
        src = "## Code\n```python\ndef a():\n    pass\n\n\ndef b():\n    pass\n```"
        self.assertEqual(_fix(src), src)

    def test_trailing_whitespace_in_code_fence_untouched(self):
        src = "## Code\n```text\ncol1   \ncol2\n```"
        self.assertEqual(_fix_syntax(src)[0], src)

    def test_nested_four_backtick_fence_untouched(self):
        src = "## Nested\n````markdown\nouter\n```\ninner\n```\n````"
        self.assertEqual(_fix(src), src)

    def test_horizontal_rule_in_fence_not_reported(self):
        rc, out, _ = _run_cli("## X\n```\n---\n```\n", '--check')
        self.assertNotIn('Horizontal rule', out)

    def test_list_continuation_not_split(self):
        src = "- item one\n  continued line A\n  continued line B\n- item two"
        self.assertEqual(_fix(src), src)


class TestFalsePositives(unittest.TestCase):

    def test_literal_brackets_in_code_span_not_broken_wikilink(self):
        rc, out, _ = _run_cli("Type `[[` to start a link.\n", '--check')
        self.assertNotIn('Broken wiki link', out)

    def test_em_dash_in_code_fence_not_flagged(self):
        rc, out, _ = _run_cli("## X\n```\na — b\n```\n", '--check')
        self.assertNotIn('Em-dash', out)

    def test_em_dash_in_frontmatter_is_still_reported(self):
        """Frontmatter is protected from rewriting, not from reporting."""
        rc, out, _ = _run_cli("---\ntitle: a — b\n---\nBody.\n", '--check')
        self.assertIn('Em-dash', out)

    def test_em_dash_column_is_real_column(self):
        rc, out, _ = _run_cli("Use `x` and `yy` then — here.\n", '--check')
        self.assertIn('column 23', out)


class TestScopeGate(unittest.TestCase):

    def test_autofix_skipped_outside_configured_fix_paths(self):
        """With MARKDOWN_LINTER_FIX_PATHS set, files outside it are never rewritten."""
        src = "## Heading\n\nBody.\n"
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False,
                                         encoding='utf-8') as f:
            f.write(src)
            path = f.name
        env = dict(os.environ, MARKDOWN_LINTER_FIX_PATHS='/nonexistent-vault/')
        try:
            result = subprocess.run(['python3', VALIDATE_SCRIPT, path],
                                    capture_output=True, text=True, env=env)
            with open(path, encoding='utf-8') as f:
                final = f.read()
        finally:
            os.remove(path)
        self.assertEqual(final, src)
        self.assertIn('MARKDOWN_LINTER_FIX_PATHS', result.stdout)

    def test_autofix_runs_when_unconfigured(self):
        """With no MARKDOWN_LINTER_FIX_PATHS, auto-fix is unrestricted."""
        src = "## Heading\n\nBody.\n"
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False,
                                         encoding='utf-8') as f:
            f.write(src)
            path = f.name
        env = {k: v for k, v in os.environ.items()
               if k != 'MARKDOWN_LINTER_FIX_PATHS'}
        try:
            subprocess.run(['python3', VALIDATE_SCRIPT, path],
                           capture_output=True, text=True, env=env)
            with open(path, encoding='utf-8') as f:
                final = f.read()
        finally:
            os.remove(path)
        self.assertEqual(final, "## Heading\nBody.\n")


class TestIdempotence(unittest.TestCase):

    def test_second_run_is_a_no_op(self):
        src = "## Heading\n\nBody text.\n\n\n- a\n- b\n"
        once = _fix_full(src)
        twice = _fix_full(once)
        self.assertEqual(once, twice)


class TestFenceEdgeCases(unittest.TestCase):

    def test_four_space_indented_fence_protected(self):
        """Obsidian sub-bullets indent 4 spaces, so fences under them are indented."""
        src = ("- Run it:\n\n"
               "    ```bash\n"
               "    #!/usr/bin/env bash\n"
               "    ---\n"
               "    echo done\n"
               "    ```\n")
        self.assertEqual(_fix(src), src)

    def test_callout_fence_protected(self):
        src = "> [!note]\n> ```bash\n> curl -H \'X-Token: <nonce>\'\n> ```\n"
        self.assertEqual(_fix_syntax(src)[0], src)

    def test_tilde_fence_protected(self):
        src = "## X\n~~~yaml\n---\na: 1\n---\n~~~\n"
        self.assertEqual(_fix(src), src)

    def test_bom_frontmatter_survives(self):
        src = "\ufeff---\ntitle: BOM\n---\n## Body\n"
        self.assertEqual(_fix(src), src)

    def test_setext_underline_not_removed(self):
        src = "Section Title\n---\nBody text.\n"
        self.assertEqual(_fix(src), src)

    def test_loose_pipe_lines_not_merged(self):
        """Without a separator row these are not a table; the blank is content."""
        src = "| 1 | 2 |\n\n| 3 | 4 |\n"
        self.assertEqual(_fix(src), src)


# The gates resolve() a path before comparing, and on macOS /tmp is a symlink
# to /private/tmp, so fixture paths have to be already-real.
TMP = os.path.realpath(tempfile.gettempdir())


class _EnvMixin(unittest.TestCase):
    """Set env vars for one test and restore them afterwards.

    No module reload is needed: validate_markdown reads its configuration on
    every call rather than capturing it at import.
    """

    def setenv(self, **env):
        for key, value in env.items():
            self.addCleanup(self._restore, key, os.environ.get(key))
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    @staticmethod
    def _restore(key, value):
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


class TestPathGates(_EnvMixin):
    """fix_allowed()/should_skip() honour the env-configured path lists."""

    def test_unconfigured_allows_everything(self):
        self.setenv(MARKDOWN_LINTER_FIX_PATHS=None)
        self.assertTrue(validate_markdown.fix_allowed(f'{TMP}/x.md'))
        self.assertTrue(validate_markdown.fix_allowed(f'{TMP}/anywhere/else/README.md'))

    def test_configured_paths_allow_autofix(self):
        self.setenv(MARKDOWN_LINTER_FIX_PATHS=f'{TMP}/notes/:{TMP}/wiki/')
        self.assertTrue(validate_markdown.fix_allowed(f'{TMP}/notes/x.md'))
        self.assertTrue(validate_markdown.fix_allowed(f'{TMP}/wiki/x.md'))
        self.assertFalse(validate_markdown.fix_allowed(f'{TMP}/other/README.md'))

    def test_configured_paths_are_case_insensitive(self):
        self.setenv(MARKDOWN_LINTER_FIX_PATHS=f'{TMP}/Notes/')
        self.assertTrue(validate_markdown.fix_allowed(f'{TMP}/notes/x.md'))

    def test_symlinked_prefix_is_resolved(self):
        """/tmp is a symlink on macOS; a prefix typed that way must still match."""
        if os.path.realpath('/tmp') == '/tmp':
            self.skipTest('/tmp is not a symlink on this platform')
        self.setenv(MARKDOWN_LINTER_FIX_PATHS='/tmp/')
        self.assertTrue(validate_markdown.fix_allowed('/tmp/x.md'))

    def test_prefix_does_not_match_sibling_directory(self):
        self.setenv(MARKDOWN_LINTER_FIX_PATHS=f'{TMP}/notes')
        self.assertTrue(validate_markdown.fix_allowed(f'{TMP}/notes/x.md'))
        self.assertFalse(validate_markdown.fix_allowed(f'{TMP}/notes-archive/x.md'))

    def test_whitespace_around_prefixes_is_ignored(self):
        self.setenv(MARKDOWN_LINTER_FIX_PATHS=f'{TMP}/notes/ : {TMP}/wiki/')
        self.assertTrue(validate_markdown.fix_allowed(f'{TMP}/notes/x.md'))
        self.assertTrue(validate_markdown.fix_allowed(f'{TMP}/wiki/x.md'))

    def test_tilde_prefix_is_expanded(self):
        self.setenv(MARKDOWN_LINTER_FIX_PATHS='~/')
        home = os.path.realpath(os.path.expanduser('~'))
        self.assertTrue(validate_markdown.fix_allowed(f'{home}/x.md'))

    def test_skip_list_is_case_insensitive(self):
        self.setenv(MARKDOWN_LINTER_SKIP='/02 Memory/:/.obsidian/')
        self.assertTrue(validate_markdown.should_skip(f'{TMP}/vault/02 Memory/x.md'))
        self.assertTrue(validate_markdown.should_skip(f'{TMP}/vault/02 memory/x.md'))
        self.assertTrue(validate_markdown.should_skip(f'{TMP}/vault/.obsidian/x.md'))
        self.assertFalse(validate_markdown.should_skip(f'{TMP}/vault/30 Notes/x.md'))

    def test_skip_list_replaces_defaults(self):
        self.setenv(MARKDOWN_LINTER_SKIP='/templates/')
        self.assertTrue(validate_markdown.should_skip(f'{TMP}/vault/templates/x.md'))
        self.assertFalse(validate_markdown.should_skip(f'{TMP}/proj/node_modules/p/README.md'))

    def test_empty_skip_list_disables_skipping(self):
        self.setenv(MARKDOWN_LINTER_SKIP='')
        self.assertFalse(validate_markdown.should_skip(f'{TMP}/proj/node_modules/p/README.md'))

    def test_default_skip_list(self):
        self.setenv(MARKDOWN_LINTER_SKIP=None)
        self.assertTrue(validate_markdown.should_skip(f'{TMP}/proj/node_modules/pkg/README.md'))
        self.assertTrue(validate_markdown.should_skip(f'{TMP}/vault/.obsidian/x.md'))
        self.assertFalse(validate_markdown.should_skip(f'{TMP}/vault/notes/x.md'))

    def test_em_dash_exemption_prefix(self):
        self.setenv(MARKDOWN_LINTER_EM_DASH_OK=f'{TMP}/Writing/')
        self.assertTrue(validate_markdown.em_dash_exempt(f'{TMP}/writing/draft.md'))
        self.assertFalse(validate_markdown.em_dash_exempt(f'{TMP}/notes/draft.md'))

    def test_em_dash_exemption_off_by_default(self):
        self.setenv(MARKDOWN_LINTER_EM_DASH_OK=None)
        self.assertFalse(validate_markdown.em_dash_exempt(f'{TMP}/writing/draft.md'))


class TestPerformance(unittest.TestCase):

    def test_large_file_autofix_is_fast(self):
        """A 4000-line note must not take seconds (the protected-set cache)."""
        import time
        block = "## Heading\n\nSome prose line.\n\n- a\n- b\n\n```python\nx = 1\n\n\ny = 2\n```\n"
        src = block * 300
        start = time.time()
        _fix_full(src)
        self.assertLess(time.time() - start, 5.0)


class TestEmDashPolicy(unittest.TestCase):
    """Spaced em-dash as a list/table separator is allowed; sentence use is not."""

    def _errs(self, content):
        _, out, _ = _run_cli(content, '--check')
        return out

    def test_spaced_separator_in_list_item_allowed(self):
        self.assertNotIn('Em-dash', self._errs("- departure flight: 9:00am — SBA to LAX\n"))

    def test_date_log_bullet_allowed(self):
        self.assertNotIn('Em-dash', self._errs("- 2026-09-18 — reviewed the linter\n"))

    def test_numbered_list_separator_allowed(self):
        self.assertNotIn('Em-dash', self._errs("1. Phase one — scoping\n"))

    def test_table_cell_separator_allowed(self):
        self.assertNotIn('Em-dash', self._errs("| A | 9:00am — SBA |\n|---|---|\n| B | c |\n"))

    def test_sentence_em_dash_flagged(self):
        self.assertIn('Em-dash', self._errs("The plan is fine — but the budget is not.\n"))

    def test_heading_em_dash_flagged(self):
        self.assertIn('Em-dash', self._errs("## Budget — FY27\n"))

    def test_unspaced_em_dash_in_list_flagged(self):
        self.assertIn('Em-dash', self._errs("- flight 9:00am—SBA to LAX\n"))

    def test_frontmatter_title_em_dash_flagged(self):
        self.assertIn('Em-dash', self._errs("---\ntitle: Budget — FY27\n---\nBody.\n"))


class TestBoldInCodeSpans(unittest.TestCase):
    """Counter-examples in backticks are content, not markdown to repair."""

    def test_code_span_example_untouched(self):
        src = "- Wrong: `*text**` (mismatched)\n- Wrong: `**text*` (mismatched)\n"
        result, changes = _fix_syntax(src)
        self.assertEqual(result, src)
        self.assertEqual(changes, [])

    def test_prose_outside_span_still_fixed(self):
        src = "Use `*text**` but this *word** is broken\n"
        result, changes = _fix_syntax(src)
        self.assertEqual(result, "Use `*text**` but this **word** is broken\n")
        self.assertEqual(len(changes), 1)

    def test_double_backtick_span_untouched(self):
        src = "Write it as `` `*text**` `` in prose.\n"
        result, changes = _fix_syntax(src)
        self.assertEqual(result, src)
        self.assertEqual(changes, [])

    def test_reference_doc_is_a_fixed_point(self):
        """The skill's own reference doc must survive its own fixer."""
        doc = SKILL_ROOT / 'references' / 'formatting_rules.md'
        original = doc.read_text(encoding='utf-8')
        self.assertIn('`*text**`', original)
        result, _ = _fix_syntax(original)
        self.assertIn('`*text**`', result)
        self.assertIn('`**text*`', result)


if __name__ == '__main__':
    unittest.main()
