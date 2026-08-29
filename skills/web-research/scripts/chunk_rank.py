#!/usr/bin/env python3
# Mirrors the upstream chunk_rank.py maintained in the author's web-access skill;
# code is verbatim, only this header and the docstring's source note differ.
# Keep in sync: fix bugs upstream first, then re-copy here. Do not fork.
"""Query-focused passage selection for fetched pages (stdlib only).

Splits extracted page text into ~N-token chunks at paragraph/sentence
boundaries, ranks them against a query with BM25 + IDF-weighted coverage +
term proximity, drops near-duplicates, and returns the best chunks in
original page order within a token budget. Tokens are estimated as
chars/4 (no tiktoken dependency). Runs on Python 3.9+.

Self-contained on purpose (BM25 + coverage + min-window proximity, no shared
ranking library): it has to run anywhere a plain python3 exists.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import List, Optional, Tuple
from urllib.parse import unquote, urlparse

STOPWORDS = frozenset("""
a an the of for to in on at by with and or but is are was were be been being
this that these those it its as from into about over under your you i we our
my me he she they them his her their where when what who which how why did do
does done also can could would should will shall may might must have has had
get got make made put set not no so if than then there here
""".split())
_WORD = re.compile(r"[^\W_]+")   # word chars minus underscore (Okapi_BM25 -> okapi, bm25)
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
# [anchor](url), [anchor](<url>), ![alt](url); URL may hold one level of
# balanced parens (Wikipedia `..._(disambiguation)`) and an optional "title".
# The label class excludes `[` and newline so each `[` scans only to the next
# `[`/`]`/line end: scans from different `[` never overlap, so matching stays
# linear on runs of unclosed `[` (with `[^\]]*` a 40k-`[` run took 15 s).
_MD_LINK = re.compile(
    r"!?\[([^\[\]\n]*)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+\"[^\"]*\")?\s*\)"
)
# In-page fragment links carry no content: `[above](#top)`, and the escaped
# citation markers trafilatura emits for Wikipedia, `[\[1\]](#cite_note-1)`.
_FRAGMENT_LINK = re.compile(r"\[(?:\\\[)?[^\[\]\n]*?(?:\\\])?\]\(#[^)\s]*\)")
K1, B = 1.4, 0.75


def tokenize(text: str) -> List[str]:
    return [t for t in _WORD.findall(text.lower()) if len(t) > 1 and t not in STOPWORDS]


def estimate_tokens(text: str) -> int:
    return len(text) // 4


@dataclass
class Chunk:
    index: int
    body: str        # this chunk's own text
    overlap: str     # tail of the previous chunk, prepended for context
    start: int       # char offset of body in the page text

    @property
    def text(self) -> str:
        return f"{self.overlap}\n{self.body}" if self.overlap else self.body


def _units(text: str, chunk_chars: int) -> List[Tuple[str, str]]:
    """Page -> (unit, joiner) pairs. Units are lines; lines longer than a
    chunk are split into sentences (joiner ' '), then hard-split on words."""
    units: List[Tuple[str, str]] = []
    for line in text.split("\n"):
        if not line.strip():
            continue
        if len(line) <= chunk_chars:
            units.append((line, "\n"))
            continue
        joiner = "\n"
        for sent in _SENTENCE_SPLIT.split(line):
            while len(sent) > chunk_chars:
                cut = sent.rfind(" ", 0, chunk_chars)
                cut = cut if cut > 0 else chunk_chars
                units.append((sent[:cut], joiner))
                sent, joiner = sent[cut:].lstrip(), " "
            if sent:
                units.append((sent, joiner))
                joiner = " "
    return units


def _tail(units: List[Tuple[str, str]], max_chars: int) -> str:
    """Trailing whole units within max_chars; if none fit, a word-boundary tail."""
    out: List[str] = []
    size = 0
    for unit, joiner in reversed(units):
        if size + len(unit) > max_chars:
            break
        out.insert(0, (joiner if out else "") + unit)
        size += len(unit) + 1
    if out:
        return "".join(out).strip()
    last = units[-1][0]
    cut = last.rfind(" ", len(last) - max_chars, len(last)) if len(last) > max_chars else -1
    return last[cut + 1:] if cut >= 0 else last[-max_chars:]


def chunk_text(text: str, chunk_tokens: int = 300, overlap_tokens: int = 40) -> List[Chunk]:
    chunk_chars = max(1, chunk_tokens) * 4
    overlap_chars = max(0, overlap_tokens) * 4
    chunks: List[Chunk] = []
    current: List[Tuple[str, str]] = []
    size = 0
    overlap = ""
    chunk_start = 0
    cursor = 0  # char offset just past the last unit placed; keeps `start` right on repeated lines

    def flush() -> None:
        nonlocal current, size, overlap
        if not current:
            return
        body = "".join((j if i else "") + u for i, (u, j) in enumerate(current))
        chunks.append(Chunk(len(chunks), body, overlap, chunk_start))
        overlap = _tail(current, overlap_chars) if overlap_chars > 0 else ""
        current, size = [], 0

    for unit, joiner in _units(text, chunk_chars):
        if current and size + len(unit) + 1 > chunk_chars:
            flush()
        idx = text.find(unit, cursor)
        if idx < 0:
            idx = cursor
        if not current:
            chunk_start = idx
        cursor = idx + len(unit)
        current.append((unit, joiner))
        size += len(unit) + 1
    flush()
    return chunks


def _min_window(plists: List[List[int]]) -> int:
    if len(plists) == 1:
        return 0
    ptr = [0] * len(plists)
    best = 10 ** 9
    while True:
        cur = [plists[i][ptr[i]] for i in range(len(plists))]
        lo, hi = min(cur), max(cur)
        best = min(best, hi - lo)
        mi = cur.index(lo)
        ptr[mi] += 1
        if ptr[mi] == len(plists[mi]):
            return best


def rank_chunks(query: str, chunks: List[Chunk]) -> List[Tuple[Chunk, float]]:
    """Score every chunk against the query; returns (chunk, score) sorted by
    score desc, scores normalized so the best chunk is 1.0 and non-matching
    chunks are 0.0. Score = 0.5*bm25 + 0.35*IDF-weighted coverage + 0.15*proximity."""
    qterms = list(dict.fromkeys(tokenize(query)))
    if not qterms or not chunks:
        return [(c, 0.0) for c in chunks]
    positions = []
    for c in chunks:
        pos: dict = {}
        for i, t in enumerate(tokenize(c.body)):
            pos.setdefault(t, []).append(i)
        positions.append(pos)
    n = len(chunks)
    avglen = sum(max(1, sum(len(v) for v in p.values())) for p in positions) / n
    idf = {}
    for q in qterms:
        df = sum(1 for p in positions if q in p)
        idf[q] = math.log(1 + (n - df + 0.5) / (df + 0.5))
    total_idf = sum(idf.values()) or 1.0

    rows = []
    for c, pos in zip(chunks, positions):
        length = max(1, sum(len(v) for v in pos.values()))
        matched = [q for q in qterms if q in pos]
        if not matched:
            rows.append((c, 0.0, 0.0, 0.0))
            continue
        bm25 = 0.0
        for q in matched:
            tf = len(pos[q])
            bm25 += idf[q] * tf * (K1 + 1) / (tf + K1 * (1 - B + B * length / avglen))
        cov = sum(idf[q] for q in matched) / total_idf
        span = _min_window([pos[q] for q in matched])
        prox = (len(matched) - 1) / (span + 1) if len(matched) >= 2 else 0.0
        rows.append((c, bm25, cov, prox))

    max_bm25 = max(r[1] for r in rows) or 1.0
    max_prox = max(r[3] for r in rows) or 1.0
    raw = [(c, 0.5 * b / max_bm25 + 0.35 * cov + 0.15 * p / max_prox if b else 0.0)
           for c, b, cov, p in rows]
    top = max(s for _, s in raw) or 1.0
    scored = [(c, s / top) for c, s in raw]
    scored.sort(key=lambda r: (-r[1], r[0].index))
    return scored


def dedupe_ranked(ranked: List[Tuple[Chunk, float]], threshold: float = 0.9) -> List[Tuple[Chunk, float]]:
    """Drop chunks whose token-set Jaccard with an already-kept (higher-scored)
    chunk >= threshold. O(n^2): select_passages dedupes lazily instead."""
    kept: List[Tuple[Chunk, float]] = []
    kept_sets: List[set] = []
    for chunk, score in ranked:
        toks = set(tokenize(chunk.body))
        if not any(_jaccard(toks, other) >= threshold for other in kept_sets):
            kept.append((chunk, score))
            kept_sets.append(toks)
    return kept


@dataclass
class Passage:
    chunk: Chunk
    score: float
    text: str        # overlap dropped when the previous passage is the adjacent chunk


@dataclass
class Selection:
    passages: List[Passage]
    total_chunks: int
    page_tokens: int
    used_tokens: int   # tokens of the passage texts as returned (overlap-trimmed)
    matched: int = 0   # chunks with a non-zero score, whether or not they fit


def _jaccard(a: set, b: set) -> float:
    union = len(a | b)
    return len(a & b) / union if union else 0.0


def select_passages(
    text: str,
    query: str,
    max_tokens: int = 2000,
    chunk_tokens: int = 300,
    overlap_tokens: int = 40,
    dedupe_threshold: float = 0.9,
) -> Selection:
    """Best-matching chunks in original page order, within max_tokens.
    Ranked chunks are taken greedily; one that doesn't fit is skipped so a
    smaller lower-ranked chunk can still use the remaining budget. Near-
    duplicates (Jaccard >= dedupe_threshold) are checked only against
    already-picked chunks, which keeps this linear in page size."""
    chunks = chunk_text(text, chunk_tokens, overlap_tokens)
    ranked = rank_chunks(query, chunks)
    picked: List[Tuple[Chunk, float]] = []
    picked_sets: List[set] = []
    used = 0
    matched = 0
    for chunk, score in ranked:
        if score <= 0.0:
            break
        matched += 1
        cost = estimate_tokens(chunk.text)
        if used + cost > max_tokens:
            continue
        toks = set(tokenize(chunk.body))
        if any(_jaccard(toks, other) >= dedupe_threshold for other in picked_sets):
            continue
        picked.append((chunk, score))
        picked_sets.append(toks)
        used += cost
    picked.sort(key=lambda r: r[0].index)
    passages: List[Passage] = []
    prev = -2
    for chunk, score in picked:
        body_only = chunk.index == prev + 1
        passages.append(Passage(chunk, score, chunk.body if body_only else chunk.text))
        prev = chunk.index
    used = sum(estimate_tokens(p.text) for p in passages)
    return Selection(passages, len(chunks), estimate_tokens(text), used, matched)


def extract_links(text: str) -> List[Tuple[str, str]]:
    """(anchor, url) pairs from markdown links in extracted text, deduped by URL."""
    seen = set()
    out = []
    for m in _MD_LINK.finditer(text):
        anchor, url = m.group(1).strip(), m.group(2)
        if url in seen or not url.startswith(("http://", "https://")):
            continue
        seen.add(url)
        out.append((anchor, url))
    return out


def rank_links(text: str, query: str, limit: Optional[int] = None) -> List[Tuple[str, str]]:
    """Links whose anchor text or URL path share terms with the query, best
    first. Scheme and host are ignored so "wikipedia" doesn't match every link."""
    qterms = set(tokenize(query))
    if not qterms:
        return []
    scored = []
    for order, (anchor, url) in enumerate(extract_links(text)):
        toks = set(tokenize(anchor)) | set(tokenize(unquote(urlparse(url).path)))
        hits = len(qterms & toks)
        if hits:
            scored.append((-hits / len(qterms), order, anchor, url))
    scored.sort()
    out = [(a, u) for _, _, a, u in scored]
    return out[:limit] if limit else out


def strip_links(text: str) -> str:
    """Replace markdown links with their anchor text; drop in-page fragment links."""
    return _MD_LINK.sub(r"\1", _FRAGMENT_LINK.sub("", text))
