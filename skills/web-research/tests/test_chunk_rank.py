#!/usr/bin/env python3
"""Tests for chunk_rank.py: stdlib BM25 + proximity chunk reranker.

Run (no deps, any Python 3.9+): python3 -m unittest discover -s skills/web-research/tests
Ported from the private web-access skill; keep in sync with scripts/chunk_rank.py.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import chunk_rank  # noqa: E402


def _para(topic: str, n: int = 6) -> str:
    return " ".join(f"This paragraph is about {topic} number {i}." for i in range(n))


class TestTokenize(unittest.TestCase):
    def test_lowercase_word_chars_drop_stopwords(self):
        toks = chunk_rank.tokenize("The IDF is computed from N and the doc-frequency!")
        self.assertNotIn("the", toks)
        self.assertNotIn("is", toks)
        self.assertIn("idf", toks)
        self.assertIn("computed", toks)
        self.assertIn("frequency", toks)

    def test_single_char_tokens_dropped(self):
        self.assertEqual(chunk_rank.tokenize("a b c word"), ["word"])


class TestEstimateTokens(unittest.TestCase):
    def test_chars_over_four(self):
        self.assertEqual(chunk_rank.estimate_tokens("x" * 400), 100)
        self.assertEqual(chunk_rank.estimate_tokens(""), 0)


class TestChunkText(unittest.TestCase):
    def test_short_text_is_one_chunk(self):
        chunks = chunk_rank.chunk_text("Just one short paragraph.", chunk_tokens=300)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].body, "Just one short paragraph.")

    def test_splits_at_paragraph_boundaries(self):
        paras = [_para(f"topic{i}") for i in range(8)]
        text = "\n".join(paras)
        # 80 tokens = 320 chars: one ~250-char paragraph fits, two don't
        chunks = chunk_rank.chunk_text(text, chunk_tokens=80, overlap_tokens=10)
        self.assertGreater(len(chunks), 1)
        # every chunk body starts at a paragraph start (no mid-sentence cuts)
        for c in chunks:
            self.assertTrue(c.body.startswith("This paragraph"), c.body[:40])
        # concatenated bodies reproduce the page (overlap is separate)
        self.assertEqual("\n".join(c.body for c in chunks), text)

    def test_overlap_is_prefix_of_text_not_body(self):
        paras = [_para(f"topic{i}") for i in range(8)]
        chunks = chunk_rank.chunk_text("\n".join(paras), chunk_tokens=80, overlap_tokens=10)
        second = chunks[1]
        self.assertTrue(second.text.endswith(second.body))
        self.assertTrue(len(second.text) > len(second.body))
        # overlap text comes from the tail of the previous chunk
        overlap = second.text[: len(second.text) - len(second.body)].strip()
        self.assertTrue(chunks[0].body.endswith(overlap))

    def test_oversized_paragraph_is_split_by_sentence(self):
        text = " ".join(f"Sentence number {i} is here." for i in range(200))
        chunks = chunk_rank.chunk_text(text, chunk_tokens=50, overlap_tokens=5)
        self.assertGreater(len(chunks), 3)
        for c in chunks:
            self.assertLessEqual(chunk_rank.estimate_tokens(c.body), 70)
            self.assertTrue(c.body.endswith("."), c.body[-20:])

    def test_chunk_indexes_are_sequential(self):
        paras = [_para(f"topic{i}") for i in range(6)]
        chunks = chunk_rank.chunk_text("\n".join(paras), chunk_tokens=60)
        self.assertEqual([c.index for c in chunks], list(range(len(chunks))))


class TestRank(unittest.TestCase):
    def setUp(self):
        self.chunks = [
            chunk_rank.Chunk(0, "Cats are small mammals kept as pets. " * 3, "", 0),
            chunk_rank.Chunk(1, "The inverse document frequency IDF is computed as a log ratio of documents. " * 2, "", 0),
            chunk_rank.Chunk(2, "Frequency of trains. Later on, unrelated: documents about inverse problems appear. " * 2, "", 0),
            chunk_rank.Chunk(3, "Weather report: rain expected, then sun. " * 3, "", 0),
        ]

    def test_best_chunk_has_all_terms_adjacent(self):
        ranked = chunk_rank.rank_chunks("how is inverse document frequency computed", self.chunks)
        self.assertEqual(ranked[0][0].index, 1)
        self.assertEqual(ranked[1][0].index, 2)

    def test_scores_are_normalized_to_unit(self):
        ranked = chunk_rank.rank_chunks("inverse document frequency", self.chunks)
        self.assertAlmostEqual(ranked[0][1], 1.0, places=6)
        for _, s in ranked:
            self.assertGreaterEqual(s, 0.0)
            self.assertLessEqual(s, 1.0)

    def test_non_matching_chunks_score_zero(self):
        ranked = chunk_rank.rank_chunks("inverse document frequency", self.chunks)
        scores = {c.index: s for c, s in ranked}
        self.assertEqual(scores[0], 0.0)
        self.assertEqual(scores[3], 0.0)

    def test_proximity_beats_scattered_terms(self):
        near = chunk_rank.Chunk(0, "alpha beta gamma. " + "filler words here. " * 20, "", 0)
        far = chunk_rank.Chunk(1, "alpha. " + "filler words here. " * 10 + "beta. " + "filler words here. " * 10 + "gamma.", "", 0)
        ranked = chunk_rank.rank_chunks("alpha beta gamma", [near, far])
        self.assertEqual(ranked[0][0].index, 0)

    def test_empty_query_terms_gives_zero_scores(self):
        ranked = chunk_rank.rank_chunks("the of and", self.chunks)
        self.assertTrue(all(s == 0.0 for _, s in ranked))


class TestDedupe(unittest.TestCase):
    def test_near_duplicate_dropped_keeping_higher_score(self):
        a = chunk_rank.Chunk(0, "one two three four five six seven eight nine ten", "", 0)
        b = chunk_rank.Chunk(1, "one two three four five six seven eight nine ten!", "", 0)
        c = chunk_rank.Chunk(2, "completely different words in this chunk here now", "", 0)
        kept = chunk_rank.dedupe_ranked([(a, 0.9), (b, 0.8), (c, 0.5)], threshold=0.9)
        self.assertEqual([k.index for k, _ in kept], [0, 2])

    def test_below_threshold_kept(self):
        a = chunk_rank.Chunk(0, "one two three four five six seven eight nine ten", "", 0)
        b = chunk_rank.Chunk(1, "one two three four five apple pear plum fig kiwi", "", 0)
        kept = chunk_rank.dedupe_ranked([(a, 0.9), (b, 0.8)], threshold=0.9)
        self.assertEqual(len(kept), 2)


class TestSelectPassages(unittest.TestCase):
    def test_budget_respected_and_page_order(self):
        paras = [_para(f"topic{i}") for i in range(10)]
        paras[7] = "Inverse document frequency is computed here. " * 5
        paras[2] = "Another mention: inverse document frequency computed. " * 5
        text = "\n".join(paras)
        sel = chunk_rank.select_passages(
            text, "inverse document frequency computed", max_tokens=150, chunk_tokens=60,
        )
        self.assertGreater(len(sel.passages), 0)
        total = sum(chunk_rank.estimate_tokens(p.text) for p in sel.passages)
        self.assertLessEqual(total, 150)
        idxs = [p.chunk.index for p in sel.passages]
        self.assertEqual(idxs, sorted(idxs))
        self.assertEqual(sel.total_chunks, len(chunk_rank.chunk_text(text, chunk_tokens=60)))

    def test_top_ranked_chunk_always_included_when_it_fits(self):
        paras = [_para(f"topic{i}") for i in range(10)]
        paras[7] = "Inverse document frequency is computed here. " * 5
        text = "\n".join(paras)
        sel = chunk_rank.select_passages(text, "inverse document frequency", max_tokens=100, chunk_tokens=60)
        self.assertIn("Inverse document frequency", sel.passages[0].text)

    def test_zero_score_chunks_are_not_selected(self):
        paras = [_para(f"topic{i}") for i in range(10)]
        paras[7] = "Inverse document frequency is computed here. " * 5
        text = "\n".join(paras)
        sel = chunk_rank.select_passages(text, "inverse document frequency", max_tokens=5000, chunk_tokens=60)
        self.assertEqual(len(sel.passages), 1)

    def test_adjacent_passages_do_not_repeat_overlap(self):
        fillers = ["apple", "brick", "cloud", "delta", "ember", "frost"]
        paras = [f"Keyword zebra appears in paragraph {f}{i}. " * 4 for i, f in enumerate(fillers)]
        text = "\n".join(paras)
        sel = chunk_rank.select_passages(text, "zebra paragraph", max_tokens=5000, chunk_tokens=50, overlap_tokens=10)
        joined = "\n".join(p.text for p in sel.passages)
        self.assertEqual(joined, text)


class TestReviewFindings(unittest.TestCase):
    """Regressions from the 2026-08-29 adversarial review."""

    def test_chunk_tokens_zero_or_negative_does_not_hang(self):
        chunks = chunk_rank.chunk_text("word " * 50, chunk_tokens=0, overlap_tokens=-3)
        self.assertGreater(len(chunks), 0)
        self.assertEqual("".join(c.body for c in chunks).replace(" ", ""), "word" * 50)

    def test_start_offsets_correct_with_repeated_lines(self):
        lines = ["repeat line here."] * 5 + [f"unique line {i}." for i in range(5)] + ["repeat line here."] * 5
        text = "\n".join(lines)
        chunks = chunk_rank.chunk_text(text, chunk_tokens=10, overlap_tokens=2)
        starts = [c.start for c in chunks]
        self.assertEqual(starts, sorted(starts))
        self.assertEqual(len(set(starts)), len(starts))
        for c in chunks:
            self.assertTrue(text.startswith(c.body, c.start), (c.start, c.body[:30]))

    def test_large_page_selects_in_under_two_seconds(self):
        import time
        words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]
        # distinct filler per line so every chunk has a different token set (dedupe can't short-circuit)
        page = "\n".join(
            " ".join(words[(i + j) % 8] for j in range(8)) + " "
            + " ".join(f"filler{(i * 7 + j) % 9973}" for j in range(52)) + "."
            for i in range(7000)
        )
        self.assertGreater(len(page), 2_000_000)
        t0 = time.time()
        sel = chunk_rank.select_passages(page, "alpha beta gamma delta epsilon zeta eta theta iota kappa", max_tokens=2000)
        self.assertLess(time.time() - t0, 2.0)
        self.assertGreater(len(sel.passages), 0)

    def test_selection_reports_matched_count(self):
        paras = [_para(f"topic{i}") for i in range(10)]
        paras[7] = "Inverse document frequency is computed here. " * 5
        sel = chunk_rank.select_passages("\n".join(paras), "inverse document frequency", max_tokens=5, chunk_tokens=60)
        self.assertEqual(sel.matched, 1)
        self.assertEqual(sel.passages, [])
        sel = chunk_rank.select_passages("\n".join(paras), "zzzz", max_tokens=5000, chunk_tokens=60)
        self.assertEqual(sel.matched, 0)

    def test_angle_bracket_and_paren_urls(self):
        s = ("See [Mercury (disambiguation)](<https://en.wikipedia.org/wiki/Mercury_(disambiguation)>) and "
             "[Jina style](https://en.wikipedia.org/wiki/Mercury_(planet)) and ![img](https://x.y/i.png) end")
        self.assertEqual(chunk_rank.strip_links(s), "See Mercury (disambiguation) and Jina style and img end")
        links = chunk_rank.extract_links(s)
        self.assertEqual(links[0], ("Mercury (disambiguation)", "https://en.wikipedia.org/wiki/Mercury_(disambiguation)"))
        self.assertEqual(links[1][1], "https://en.wikipedia.org/wiki/Mercury_(planet)")

    def test_rank_links_ignores_scheme_and_host_tokens(self):
        s = "[Okapi BM25](https://en.wikipedia.org/wiki/Okapi_BM25) [Cats](https://en.wikipedia.org/wiki/Cat)"
        self.assertEqual(chunk_rank.rank_links(s, "wikipedia org https"), [])
        self.assertEqual([u for _, u in chunk_rank.rank_links(s, "okapi bm25")],
                         ["https://en.wikipedia.org/wiki/Okapi_BM25"])


class TestLinks(unittest.TestCase):
    TEXT = (
        "See [Okapi BM25](https://en.wikipedia.org/wiki/Okapi_BM25) and "
        "[tf-idf weighting](https://en.wikipedia.org/wiki/Tf%E2%80%93idf) or the "
        "[home page](https://example.com/) and again [Okapi BM25](https://en.wikipedia.org/wiki/Okapi_BM25)."
    )

    def test_extract_links_dedupes_by_url(self):
        links = chunk_rank.extract_links(self.TEXT)
        self.assertEqual(len(links), 3)
        self.assertEqual(links[0], ("Okapi BM25", "https://en.wikipedia.org/wiki/Okapi_BM25"))

    def test_rank_links_scores_anchor_and_url(self):
        ranked = chunk_rank.rank_links(self.TEXT, "tf idf weighting")
        self.assertEqual(ranked[0][1], "https://en.wikipedia.org/wiki/Tf%E2%80%93idf")
        # zero-score links are omitted
        self.assertNotIn("https://example.com/", [u for _, u in ranked])

    def test_strip_links_keeps_anchor_text(self):
        self.assertEqual(chunk_rank.strip_links("a [b](https://x.y/z) c"), "a b c")

    def test_strip_links_removes_fragment_citation_markers(self):
        # Wikipedia via trafilatura: `City University[\[1\]](#cite_note-1) in the 1980s`
        s = "City University[\\[1\\]](#cite_note-1) in the 1980s.[\\[2\\]](#cite_note-robertson2009-2) Next"
        self.assertEqual(chunk_rank.strip_links(s), "City University in the 1980s. Next")
        # plain fragment links go too; external links keep their anchor
        self.assertEqual(chunk_rank.strip_links("see [above](#top) and [BM25](https://x.y/bm25)"),
                         "see  and BM25")


if __name__ == "__main__":
    unittest.main()
