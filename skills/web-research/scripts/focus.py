#!/usr/bin/env python3
"""Query-focused filter for fetched page text (stdin -> stdout, stdlib only).

Reads page text (markdown or plain) on stdin and prints only the passages
that best match --query, within --max-tokens. Short pages come back whole.
Works on anything: jina_fetch.sh / tavily.sh output, a saved file, or
pasted text.

Usage:
    cat page.md | python3 focus.py --query "what you're looking for" [--max-tokens 2000]
                     [--chunk-tokens 300] [--links-max-tokens 500]
    cat page.md | python3 focus.py --full        # pass stdin through unchanged

Output format (long pages):
    focus: "<query>" — 4 of 37 passages, ~1900 tokens (of ~12000 page tokens)

    --- passage 7 (1.00) ---
    ...best-matching text, in original page order...

    related links:
    - anchor text — https://...

Ranking is BM25 + IDF-weighted coverage + term proximity (chunk_rank.py,
which mirrors the upstream copy in the author's web-access skill; keep the
two in sync).
Tokens are estimated as chars/4. Python 3.9+.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chunk_rank  # noqa: E402

FOCUS_MAX_TOKENS = 2000
FOCUS_CHUNK_TOKENS = 300
FOCUS_OVERLAP_TOKENS = 40
FOCUS_LINKS_MAX_TOKENS = 500


def focus_text(
    text: str,
    query: str,
    max_tokens: int = FOCUS_MAX_TOKENS,
    chunk_tokens: int = FOCUS_CHUNK_TOKENS,
    links_max_tokens: int = FOCUS_LINKS_MAX_TOKENS,
) -> str:
    """Query-focused view of extracted page text (tokens ~= chars/4).

    Pages at or under max_tokens are returned whole: reranking them would
    risk dropping content for no savings. Longer pages are chunked, ranked
    with BM25 + coverage + proximity (chunk_rank.py), deduped, and the best
    passages are emitted in page order until the budget is used. Markdown
    links inside passages are reduced to their anchor text (URLs are token
    dead weight); links that match the query are listed separately under
    `related links:`, capped at links_max_tokens.
    """
    if chunk_rank.estimate_tokens(text) <= max_tokens:
        return f"focus: whole page (under budget)\n\n{text}"

    # Rank and budget the de-linked text so URLs don't eat the budget or
    # inflate the header count; links are ranked from the original below.
    page = chunk_rank.strip_links(text)
    if chunk_rank.estimate_tokens(page) <= max_tokens:
        parts = ["focus: whole page (under budget after de-linking)", "", page]
    else:
        # A chunk plus its overlap must be able to fit the budget, else nothing can.
        chunk_tokens = max(20, min(chunk_tokens, max_tokens - FOCUS_OVERLAP_TOKENS))
        sel = chunk_rank.select_passages(
            page, query, max_tokens=max_tokens, chunk_tokens=chunk_tokens,
            overlap_tokens=FOCUS_OVERLAP_TOKENS,
        )
        parts = [
            f'focus: "{query}" — {len(sel.passages)} of {sel.total_chunks} passages, '
            f"~{sel.used_tokens} tokens (of ~{sel.page_tokens} page tokens)"
        ]
        if not sel.passages:
            if sel.matched == 0:
                parts.append("(no passage matched the query terms; try --full or a different --query)")
            else:
                noun = "passage" if sel.matched == 1 else "passages"
                parts.append(f"({sel.matched} {noun} matched but none fit in --max-tokens {max_tokens}; raise it)")
        for p in sel.passages:
            parts.append(f"\n--- passage {p.chunk.index + 1} ({p.score:.2f}) ---")
            parts.append(p.text)

    links = []
    used = 0
    for anchor, url in chunk_rank.rank_links(text, query):
        line = f"- {anchor or url} — {url}"
        cost = chunk_rank.estimate_tokens(line) + 1
        if used + cost > links_max_tokens:
            break
        links.append(line)
        used += cost
    if links:
        parts.append("\nrelated links:")
        parts.extend(links)
    return "\n".join(parts)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Keep only the passages of stdin that match a query (default), "
                    "or pass it through whole with --full.",
        epilog='Example: scripts/jina_fetch.sh URL | python3 scripts/focus.py --query "refund policy"',
    )
    parser.add_argument(
        "--query", "-q", metavar="FOCUS",
        help="What you're looking for. Only the best-matching passages are printed, "
             "within --max-tokens (short pages come back whole).",
    )
    parser.add_argument(
        "--full", action="store_true",
        help="Print stdin unchanged (no focusing). Overrides --query.",
    )
    parser.add_argument("--max-tokens", type=int, default=FOCUS_MAX_TOKENS,
                        help=f"Budget for focused output, ~chars/4 (default {FOCUS_MAX_TOKENS})")
    parser.add_argument("--chunk-tokens", type=int, default=FOCUS_CHUNK_TOKENS,
                        help=f"Approximate size of each ranked passage (default {FOCUS_CHUNK_TOKENS})")
    parser.add_argument("--links-max-tokens", type=int, default=FOCUS_LINKS_MAX_TOKENS,
                        help=f"Budget for the 'related links:' block (default {FOCUS_LINKS_MAX_TOKENS})")
    args = parser.parse_args(argv)

    query = (args.query or "").strip()
    if not args.full and not query:
        print(
            "focus.py: pass --query \"what you're looking for\" (default: only matching passages "
            "are printed), or --full to print the whole input unchanged.",
            file=sys.stderr,
        )
        return 2

    # Bytes in, bytes out: a stray non-UTF-8 byte in a pasted file must not
    # kill the run, and the header's em dash must print even under an ASCII
    # locale (PYTHONIOENCODING=ascii).
    text = sys.stdin.buffer.read().decode("utf-8", "replace")
    if not text.strip():
        print("focus.py: nothing on stdin (pipe page text in, e.g. scripts/jina_fetch.sh URL | ...)",
              file=sys.stderr)
        return 1

    if args.full:
        out = text
    else:
        out = focus_text(
            text, query,
            max_tokens=args.max_tokens,
            chunk_tokens=args.chunk_tokens,
            links_max_tokens=args.links_max_tokens,
        ) + "\n"
    sys.stdout.buffer.write(out.encode("utf-8", "replace"))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
