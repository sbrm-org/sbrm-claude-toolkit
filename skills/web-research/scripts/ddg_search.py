#!/usr/bin/env python3
"""DuckDuckGo HTML search — no API key, stdlib only.

Usage:
    python3 ddg_search.py "your query" [--count N] [--site DOMAIN]

Scrapes https://html.duckduckgo.com/html/ (the no-JS endpoint).
Free and keyless; be polite — a few queries per minute, not bulk scraping.
"""
import argparse
import html
import re
import sys
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")

RESULT_RE = re.compile(
    r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', re.S)
SNIPPET_RE = re.compile(
    r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>', re.S)
TAG_RE = re.compile(r"<[^>]+>")


def clean(text: str) -> str:
    return html.unescape(TAG_RE.sub("", text)).strip()


def real_url(href: str) -> str:
    """DDG wraps results in //duckduckgo.com/l/?uddg=<encoded-url>."""
    parsed = urllib.parse.urlparse(href, scheme="https")
    if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
        qs = urllib.parse.parse_qs(parsed.query)
        if "uddg" in qs:
            return qs["uddg"][0]
    return href


def search(query: str, count: int) -> list[dict]:
    data = urllib.parse.urlencode({"q": query, "kl": "us-en"}).encode()
    req = urllib.request.Request(
        "https://html.duckduckgo.com/html/", data=data,
        headers={"User-Agent": UA,
                 "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        page = resp.read().decode("utf-8", errors="replace")
    if "anomaly" in page.lower() and "result__a" not in page:
        print("DDG served a bot-check page; wait a minute and retry, "
              "or fall back to another method.", file=sys.stderr)
        return []
    links = RESULT_RE.findall(page)
    snippets = [clean(s) for s in SNIPPET_RE.findall(page)]
    results = []
    for i, (href, title) in enumerate(links[:count]):
        results.append({
            "title": clean(title),
            "url": real_url(href),
            "snippet": snippets[i] if i < len(snippets) else "",
        })
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("query")
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--site", help="restrict to a domain")
    args = ap.parse_args()
    query = f"site:{args.site} {args.query}" if args.site else args.query
    try:
        results = search(query, args.count)
    except Exception as e:  # network errors, timeouts
        print(f"Search failed: {e}", file=sys.stderr)
        return 1
    if not results:
        print("No results.", file=sys.stderr)
        return 2
    for n, r in enumerate(results, 1):
        print(f"{n}. {r['title']}\n   {r['url']}")
        if r["snippet"]:
            print(f"   {r['snippet']}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
