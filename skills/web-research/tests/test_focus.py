#!/usr/bin/env python3
"""Tests for scripts/focus.py: query-focused stdin->stdout filter.

Run (no deps, any Python 3.9+): python3 -m unittest discover -s skills/web-research/tests
"""

import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import chunk_rank  # noqa: E402
import focus  # noqa: E402

FOCUS_PY = SCRIPTS / "focus.py"


def _long_page() -> str:
    paras = []
    for i in range(40):
        paras.append(f"Section {i}: filler prose about unrelated topic {i} that goes on for a while. " * 4)
    paras[12] = ("The inverse document frequency IDF is computed as log((N - n + 0.5) / (n + 0.5) + 1), "
                 "see [Okapi BM25](https://en.wikipedia.org/wiki/Okapi_BM25) and "
                 "[tf-idf](https://en.wikipedia.org/wiki/Tf-idf). ") * 3
    paras[30] = "Later the IDF term is computed again for each query term in the document. " * 4
    return "\n".join(paras)


def _run(argv, stdin: str):
    proc = subprocess.run(
        [sys.executable, str(FOCUS_PY), *argv],
        input=stdin, capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout, proc.stderr


class TestFocusText(unittest.TestCase):
    def test_short_page_returned_whole_with_header(self):
        text = "A short page. Nothing to trim here."
        out = focus.focus_text(text, "anything", max_tokens=2000)
        self.assertTrue(out.startswith("focus: whole page (under budget)"))
        self.assertIn(text, out)

    def test_short_page_guard_measures_delinked_text(self):
        url = "https://example.com/" + "segment/" * 30
        paras = [f"Paragraph {i} says something ordinary [link {i}]({url}{i}) here." for i in range(60)]
        paras[33] = "The zebra paragraph is the one that matters."
        page = "\n".join(paras)
        self.assertGreater(chunk_rank.estimate_tokens(page), 2000)
        out = focus.focus_text(page, "zebra", max_tokens=2000)
        self.assertTrue(out.startswith("focus: whole page (under budget after de-linking)"), out.splitlines()[0])
        self.assertNotIn("--- passage", out)
        for i in (0, 59):
            self.assertIn(f"Paragraph {i}", out)
        self.assertIn("zebra paragraph", out)
        self.assertNotIn("](https://", out.split("related links:")[0])

    def test_long_page_header_and_passage_markers(self):
        out = focus.focus_text(_long_page(), "how is IDF computed", max_tokens=300, chunk_tokens=80)
        first = out.splitlines()[0]
        self.assertTrue(first.startswith('focus: "how is IDF computed" — '), first)
        self.assertRegex(first, r"\d+ of \d+ passages, ~\d+ tokens \(of ~\d+ page tokens\)")
        self.assertRegex(out, r"--- passage \d+ \(\d\.\d\d\) ---")
        self.assertIn("log((N - n + 0.5)", out)

    def test_budget_trims_output(self):
        page = _long_page()
        out = focus.focus_text(page, "filler prose unrelated topic", max_tokens=200, chunk_tokens=80)
        body = out.split("related links:")[0]
        self.assertLess(len(body), len(page) // 4)
        self.assertLessEqual(chunk_rank.estimate_tokens(body), 200 + 60)  # header slack

    def test_passages_in_page_order(self):
        out = focus.focus_text(_long_page(), "IDF computed", max_tokens=600, chunk_tokens=80)
        nums = [int(n) for n in re.findall(r"--- passage (\d+) ", out)]
        self.assertGreater(len(nums), 1)
        self.assertEqual(nums, sorted(nums))

    def test_related_links_block_ranked_and_capped(self):
        out = focus.focus_text(_long_page(), "okapi bm25", max_tokens=300, chunk_tokens=80, links_max_tokens=30)
        self.assertIn("related links:", out)
        links = out.split("related links:")[1].strip().splitlines()
        self.assertTrue(links[0].startswith("- Okapi BM25"), links)
        self.assertLessEqual(chunk_rank.estimate_tokens("\n".join(links)), 30)

    def test_no_related_links_block_when_none_match(self):
        out = focus.focus_text(_long_page(), "filler prose", max_tokens=200, chunk_tokens=80)
        self.assertNotIn("related links:", out)

    def test_over_budget_message_distinct_from_no_match(self):
        text = "pricing tiers are listed here in detail. " * 20
        self.assertGreater(chunk_rank.estimate_tokens(text), 150)
        out = focus.focus_text(text, "pricing tiers", max_tokens=150, chunk_tokens=300)
        self.assertRegex(out, r"--- passage 1 ")
        self.assertNotIn("no passage matched", out)
        out2 = focus.focus_text(_long_page(), "qqqq zzzz", max_tokens=150, chunk_tokens=300)
        self.assertIn("no passage matched", out2)

    def test_passages_are_delinked(self):
        out = focus.focus_text(_long_page(), "okapi bm25 idf", max_tokens=300, chunk_tokens=80)
        body = out.split("related links:")[0]
        self.assertNotIn("](https://", body)
        self.assertIn("Okapi BM25", body)


class TestCli(unittest.TestCase):
    def test_query_focuses_long_page(self):
        code, out, err = _run(["--query", "IDF computed", "--max-tokens", "300", "--chunk-tokens", "80"], _long_page())
        self.assertEqual(code, 0, err)
        self.assertIn('focus: "IDF computed"', out)
        self.assertIn("log((N - n + 0.5)", out)
        self.assertNotIn("Section 3: filler", out)

    def test_full_passes_stdin_through_unchanged(self):
        page = _long_page()
        code, out, err = _run(["--full"], page)
        self.assertEqual(code, 0, err)
        self.assertEqual(out, page)
        self.assertNotIn("focus:", out)

    def test_full_overrides_query(self):
        page = "short page\n"
        code, out, _ = _run(["--query", "x", "--full"], page)
        self.assertEqual(code, 0)
        self.assertEqual(out, page)

    def test_missing_query_exits_2_with_usage(self):
        code, out, err = _run([], "some page text")
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("--query", err)
        self.assertIn("--full", err)

    def test_empty_query_string_exits_2(self):
        code, _, err = _run(["--query", "   "], "some page text")
        self.assertEqual(code, 2)
        self.assertIn("--query", err)

    def test_empty_stdin_exits_1(self):
        code, out, err = _run(["--query", "anything"], "")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("stdin", err.lower())
        code, _, err = _run(["--query", "anything"], "  \n\n ")
        self.assertEqual(code, 1)

    def test_empty_stdin_with_full_exits_1(self):
        code, _, err = _run(["--full"], "")
        self.assertEqual(code, 1)
        self.assertIn("stdin", err.lower())

    def test_invalid_utf8_bytes_do_not_crash(self):
        proc = subprocess.run([sys.executable, str(FOCUS_PY), "--query", "abc"],
                              input=b"\xff\xfe abc here\n", capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(b"abc here", proc.stdout)
        proc = subprocess.run([sys.executable, str(FOCUS_PY), "--full"], input=b"\xff abc\n", capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(b"abc", proc.stdout)

    def test_ascii_stdout_encoding_does_not_crash(self):
        env = dict(os.environ, PYTHONIOENCODING="ascii")
        proc = subprocess.run([sys.executable, str(FOCUS_PY), "--query", "IDF computed", "--max-tokens", "300",
                               "--chunk-tokens", "80"], input=_long_page().encode(), capture_output=True, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(b"--- passage", proc.stdout)

    def test_query_equals_form_accepts_leading_dash(self):
        code, out, err = _run(["--query=--full"], _long_page())
        self.assertEqual(code, 0, err)
        self.assertIn('focus: "--full"', out)

    def test_matched_but_none_fit_message_is_singular_and_plural(self):
        paras = [f"Paragraph {i} about topic number {i} in some detail here." for i in range(60)]
        paras[33] = "The zebra paragraph."
        text = "\n".join(paras)
        out = focus.focus_text(text, "zebra", max_tokens=5, chunk_tokens=300)
        self.assertIn("(1 passage matched but none fit in --max-tokens 5", out)
        out = focus.focus_text(text, "paragraph topic", max_tokens=5, chunk_tokens=300)
        self.assertRegex(out, r"\(\d{2,} passages matched but none fit")

    def test_links_max_tokens_flag(self):
        code, out, _ = _run(["--query", "okapi bm25", "--max-tokens", "300", "--chunk-tokens", "80",
                             "--links-max-tokens", "30"], _long_page())
        self.assertEqual(code, 0)
        links = out.split("related links:")[1].strip().splitlines()
        self.assertLessEqual(chunk_rank.estimate_tokens("\n".join(links)), 30)


if __name__ == "__main__":
    unittest.main()
