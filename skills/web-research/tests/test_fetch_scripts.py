#!/usr/bin/env python3
"""Shell-wiring tests for jina_fetch.sh and tavily.sh (no network: a fake
`curl` on PATH writes canned output to the -o target and prints 200).

Run (no deps, any Python 3.9+): python3 -m unittest discover -s skills/web-research/tests
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
JINA = SCRIPTS / "jina_fetch.sh"
TAVILY = SCRIPTS / "tavily.sh"

FAKE_CURL = """#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; esac
  shift
done
cat "$FAKE_CURL_BODY_FILE" > "$out"
printf 200
"""


def _long_page() -> str:
    paras = [f"Section {i}: filler prose about unrelated topic {i} that goes on for a while. " * 4 for i in range(40)]
    paras[12] = ("The inverse document frequency IDF is computed as log((N - n + 0.5) / (n + 0.5) + 1), "
                 "see [Okapi BM25](https://en.wikipedia.org/wiki/Okapi_BM25). ") * 3
    return "\n".join(paras)


class _ShellCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        (bin_dir / "curl").write_text(FAKE_CURL)
        (bin_dir / "curl").chmod(0o755)
        self.body = self.tmp / "body"
        self.env = dict(os.environ, PATH=f"{bin_dir}:{os.environ.get('PATH', '')}",
                        FAKE_CURL_BODY_FILE=str(self.body), TAVILY_API_KEY="dummy")
        self.env.pop("JINA_API_KEY", None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_sh(self, script, *args, cwd=None):
        proc = subprocess.run(["sh", str(script), *args], capture_output=True, text=True,
                              env=self.env, cwd=cwd or self.tmp)
        return proc.returncode, proc.stdout, proc.stderr


class TestJinaFetch(_ShellCase):
    def test_query_focuses(self):
        self.body.write_text(_long_page())
        code, out, err = self.run_sh(JINA, "https://x.example/p", "how is IDF computed")
        self.assertEqual(code, 0, err)
        self.assertIn('focus: "how is IDF computed"', out)
        self.assertIn("log((N - n + 0.5)", out)
        self.assertNotIn("Section 3: filler", out)
        self.assertNotIn("returning the whole page", err)

    def test_no_query_returns_whole_page_with_hint(self):
        self.body.write_text(_long_page())
        code, out, err = self.run_sh(JINA, "https://x.example/p")
        self.assertEqual(code, 0, err)
        self.assertEqual(out, _long_page())
        self.assertIn("returning the whole page", err)

    def test_query_starting_with_dash_is_a_query_not_a_flag(self):
        self.body.write_text(_long_page())
        code, out, err = self.run_sh(JINA, "https://x.example/p", "--full")
        self.assertEqual(code, 0, err)
        self.assertIn('focus: "--full"', out)

    def test_symlinked_script_finds_focus(self):
        link_dir = self.tmp / "link"
        link_dir.mkdir()
        link = link_dir / "jina_fetch.sh"
        link.symlink_to(JINA)
        self.body.write_text(_long_page())
        code, out, err = self.run_sh(link, "https://x.example/p", "IDF computed")
        self.assertEqual(code, 0, err)
        self.assertIn("--- passage", out)

    def test_empty_body_is_an_error_not_a_hint(self):
        self.body.write_text("\n")
        code, out, err = self.run_sh(JINA, "https://x.example/p", "anything")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("empty", err.lower())
        self.assertNotIn("pipe page text in", err)
        code, out, err = self.run_sh(JINA, "https://x.example/p")
        self.assertEqual(code, 1)
        self.assertIn("empty", err.lower())

    def test_latin1_body_with_leading_blank_lines_is_not_empty(self):
        # BSD tr aborts on invalid UTF-8 in a UTF-8 locale; the empty check must not trust it
        self.body.write_bytes(b"\n\n\xe9 caf\xe9 latin1 page about refunds\n")
        env = dict(self.env, LANG="en_US.UTF-8", LC_ALL="en_US.UTF-8")
        proc = subprocess.run(["sh", str(JINA), "https://x.example/p", "refunds"], capture_output=True, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(b"latin1 page", proc.stdout)
        proc = subprocess.run(["sh", str(JINA), "https://x.example/p"], capture_output=True, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(b"latin1 page", proc.stdout)

    def test_whole_page_mode_does_not_need_python3(self):
        stub = self.tmp / "bin" / "python3"
        stub.write_text("#!/bin/sh\necho 'python3: stub, should not be called' >&2\nexit 127\n")
        stub.chmod(0o755)
        self.body.write_text(_long_page())
        code, out, err = self.run_sh(JINA, "https://x.example/p")
        self.assertEqual(code, 0, err)
        self.assertEqual(out, _long_page())
        self.assertNotIn("stub", err)

    def test_whitespace_only_query_is_whole_page(self):
        self.body.write_text(_long_page())
        code, out, err = self.run_sh(JINA, "https://x.example/p", "   ")
        self.assertEqual(code, 0, err)
        self.assertEqual(out, _long_page())
        self.assertIn("returning the whole page", err)

    def test_no_args_is_usage(self):
        code, _, err = self.run_sh(JINA)
        self.assertEqual(code, 64)
        self.assertIn("Usage", err)


class TestTavily(_ShellCase):
    def _extract_json(self, content):
        self.body.write_text(json.dumps({"results": [{"url": "https://x.example/p", "raw_content": content}]}))

    def test_extract_with_query_focuses(self):
        self._extract_json(_long_page())
        code, out, err = self.run_sh(TAVILY, "extract", "https://x.example/p", "how is IDF computed")
        self.assertEqual(code, 0, err)
        self.assertIn('focus: "how is IDF computed"', out)
        self.assertIn("log((N - n + 0.5)", out)

    def test_extract_without_query_whole_page_and_hint(self):
        self._extract_json(_long_page())
        code, out, err = self.run_sh(TAVILY, "extract", "https://x.example/p")
        self.assertEqual(code, 0, err)
        self.assertIn("URL: https://x.example/p", out)
        self.assertIn("Section 3: filler", out)
        self.assertIn("returning the whole page", err)

    def test_extract_query_starting_with_dash(self):
        self._extract_json(_long_page())
        code, out, err = self.run_sh(TAVILY, "extract", "https://x.example/p", "--full")
        self.assertEqual(code, 0, err)
        self.assertIn('focus: "--full"', out)

    def test_extract_no_results_is_an_error(self):
        self.body.write_text(json.dumps({"results": [], "failed_results": [{"url": "https://x.example/p"}]}))
        code, out, err = self.run_sh(TAVILY, "extract", "https://x.example/p", "anything")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("empty", err.lower())
        self.assertNotIn("pipe page text in", err)

    def test_extract_result_with_empty_content_is_an_error(self):
        self.body.write_text(json.dumps({"results": [{"url": "https://x.example/p", "raw_content": "", "content": ""}]}))
        code, out, err = self.run_sh(TAVILY, "extract", "https://x.example/p", "refund")
        self.assertEqual(code, 1, out)
        self.assertEqual(out, "")
        self.assertIn("empty", err.lower())

    def test_extract_non_utf8_byte_in_response_does_not_crash(self):
        self.body.write_bytes(b'{"results":[{"url":"https://x.example/p","raw_content":"caf\xe9 refund policy text"}]}')
        code, out, err = self.run_sh(TAVILY, "extract", "https://x.example/p", "refund")
        self.assertEqual(code, 0, err)
        self.assertIn("refund policy text", out)
        self.assertNotIn("Traceback", err)

    def test_extract_odd_json_shapes_fail_cleanly(self):
        for body in ('{"results": null}', "<html>captive portal</html>", "[1, 2]"):
            self.body.write_text(body)
            code, out, err = self.run_sh(TAVILY, "extract", "https://x.example/p", "refund")
            self.assertEqual(code, 1, body)
            self.assertEqual(out, "", body)
            self.assertNotIn("Traceback", err, body)
            self.assertTrue("empty" in err.lower() or "not json" in err.lower(), (body, err))
        # a non-string content field is coerced, not a crash
        self.body.write_text('{"results": [{"url": "u", "raw_content": 42}]}')
        code, out, err = self.run_sh(TAVILY, "extract", "https://x.example/p", "refund")
        self.assertEqual(code, 0, err)
        self.assertNotIn("Traceback", err)
        self.assertIn("42", out)

    def test_no_key_message_does_not_need_python3(self):
        stub = self.tmp / "bin" / "python3"
        stub.write_text("#!/bin/sh\necho 'python3: stub, should not be called' >&2\nexit 127\n")
        stub.chmod(0o755)
        env = dict(self.env)
        env.pop("TAVILY_API_KEY")
        proc = subprocess.run(["sh", str(TAVILY), "search", "q"], capture_output=True, text=True, env=env)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("jina_fetch.sh", proc.stderr)
        self.assertNotIn("stub", proc.stderr)

    def test_search_unaffected(self):
        self.body.write_text(json.dumps({"answer": "A", "results": [{"title": "T", "url": "https://x.example", "content": "c"}]}))
        code, out, err = self.run_sh(TAVILY, "search", "q")
        self.assertEqual(code, 0, err)
        self.assertIn("ANSWER: A", out)
        self.assertIn("1. T", out)
        self.assertNotIn("returning the whole page", err)

    def test_no_key_points_to_free_tier(self):
        env = dict(self.env)
        env.pop("TAVILY_API_KEY")
        proc = subprocess.run(["sh", str(TAVILY), "extract", "https://x.example/p"], capture_output=True, text=True, env=env)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("jina_fetch.sh", proc.stderr)


if __name__ == "__main__":
    unittest.main()
