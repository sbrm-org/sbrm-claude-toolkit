---
name: web-research
description: Layered web search and page fetching beyond the built-in WebSearch/WebFetch tools. Tavily API (paid, TAVILY_API_KEY) as the primary upgrade for search + extraction, with free keyless fallbacks (DuckDuckGo search script, Jina Reader fetch script), a query-focused filter (focus.py) that keeps only the passages of a fetched page that answer your question, and guidance for bot-walled pages. Use when built-in web tools fail, are unavailable, or return poor results, or when higher-quality search/extraction is needed.
---

# Web Research (Layered Search & Fetch)
Layered options for getting web content when the built-in tools don't deliver. Start at Tier 0; escalate on failure or when you need better results.

> **Claude Desktop app users**: this skill's scripts are for Claude Code (they run shell/Python locally). In the Desktop app, use the **Exa connector** from the official connector directory instead.

## Fetch with a question, not just a URL
Every fetch script here takes an optional trailing argument: what you're looking for (second argument to `jina_fetch.sh`, third to `tavily.sh extract`). Give it. A long page (docs, Wikipedia, a policy PDF rendered to text) is 10,000+ tokens; you usually need one or two paragraphs of it. With a query, the script keeps only the passages that best match, within a ~2,000-token budget, and lists the page's links that relate to the query. Short pages come back whole either way, so there is no downside to always passing a query.

```bash
scripts/jina_fetch.sh "https://example.com/page" "what you're looking for"   # focused
scripts/jina_fetch.sh "https://example.com/page"                             # whole page, prints a hint on stderr
```

Whole-page output is right when you need to read the entire thing: a short article, a form you're filling from, a table you'll transcribe, or a page you'll quote at length. It is wrong for "find the part about X" on anything long, which is most research.
## Tier 0: Built-in tools (default)
Use the built-in `WebSearch` and `WebFetch` tools first, every time. Move on when they fail, are unavailable in the session, or return clearly poor results (empty pages, bot-check text, irrelevant hits).
## Tier 1: Tavily (paid, best results; requires `TAVILY_API_KEY`)
If `TAVILY_API_KEY` is set in the environment, Tavily is the primary fallback: purpose-built for LLM research, with both search (including a synthesized answer) and page extraction:

```bash
scripts/tavily.sh search "your query"                                            # top 5 results + answer
scripts/tavily.sh extract "https://example.com/page" "what you're looking for"   # focused extract
scripts/tavily.sh extract "https://example.com/page"                             # whole page, prints a hint on stderr
```

- If the key is unset, the script prints a pointer to the free tiers and exits 1; just drop to Tier 2.
- Never hardcode or echo the key; it comes only from the environment.
## Tier 2: Free script fallbacks (no key needed)
### Search: DuckDuckGo
```bash
python3 scripts/ddg_search.py "your query" [--count N] [--site domain.com]
```

- Scrapes DuckDuckGo's no-JS HTML endpoint; stdlib only, no dependencies.
- Prints numbered results: title, real URL (redirect-unwrapped), snippet.
- Be polite: a few queries per minute. If DDG serves a bot-check page the script says so on stderr; wait a minute and retry.
### Fetch: Jina Reader
```bash
scripts/jina_fetch.sh "https://example.com/page" "what you're looking for"   # focused
scripts/jina_fetch.sh "https://example.com/page"                             # whole page
```

- Returns the page as clean markdown via `https://r.jina.ai/<url>`; with a query, only the matching passages.
- Works keyless at low rate limits, but keyless access is **network-reputation-dependent**: some networks are blocked from anonymous use (HTTP 401 with a "network reputation" message); that's the network, not the URL.
- **Higher limits / unblocking**: set the optional `JINA_API_KEY` environment variable and the script sends it as a Bearer token automatically. A free personal key is available at https://jina.ai/reader. Never hardcode keys.
- Failures print the HTTP status and what to do next on stderr.
## Tier 3: Local browser (documented, not scripted)
For pages behind aggressive bot walls (Akamai, Imperva, PerimeterX, press-and-hold checks) that defeat Tiers 0-2, a locally installed real browser is the strongest option:

1. One-time install: `pip install playwright && playwright install chromium` (or use any Playwright/Puppeteer setup already on the machine).
2. Drive a **headed** (visible-window) browser to load the page, then extract `document.body.innerText` or save the HTML.
3. This requires a local install and a machine with a display; it is deliberately not bundled here. If it's needed regularly, ask your admin about a standing setup.
4. Pipe whatever you saved through `focus.py` (below) so the long page doesn't land in context whole.
## focus.py on its own
`scripts/focus.py` is what the fetch scripts call under the hood. It reads text on stdin and prints the passages that match a query. Use it directly on any text: a page saved by the Tier 3 browser, a file on disk, output from `WebFetch` you saved, or content someone pasted into a file.

```bash
python3 scripts/focus.py --query "refund policy" < saved_page.md
cat notes.txt | python3 scripts/focus.py --query "board approval dates" --max-tokens 1200
python3 scripts/focus.py --full < saved_page.md          # pass through unchanged
```

Flags: `--max-tokens` (budget for the passages, default 2000), `--chunk-tokens` (passage size, default 300), `--links-max-tokens` (budget for the related-links block, default 500), `--full` (no filtering). Without `--query` or `--full` it exits 2 and says so; with nothing on stdin it exits 1.

Output shape:

```text
focus: "refund policy" — 3 of 41 passages, ~1850 tokens (of ~14200 page tokens)

--- passage 12 (1.00) ---
...the passage text, links reduced to their anchor text...

--- passage 30 (0.61) ---
...

related links:
- Refunds and returns — https://example.com/help/refunds
```

Passages are printed in page order (not score order) so the excerpt reads naturally; the number in parentheses is the match score relative to the best passage. Pages already under the budget print whole with a `focus: whole page (under budget)` header (or `... (under budget after de-linking)` when they only fit once link URLs are reduced to anchor text). If nothing matched, a line under the header says so: try `--full` or reword the query. Ranking is BM25 plus term coverage and proximity, all stdlib Python 3, no installs.
## Choosing a path
| Situation | Do this |
|---|---|
| Normal search/fetch | Built-in WebSearch/WebFetch (Tier 0) |
| Built-ins fail/poor AND `TAVILY_API_KEY` set | `tavily.sh search` / `tavily.sh extract URL "query"` |
| No Tavily key, search needed | `ddg_search.py` |
| No Tavily key, fetch needed | `jina_fetch.sh URL "query"` |
| Need the whole page (short, or you'll quote it all) | Omit the query |
| Long text already in hand (file, paste, browser save) | `focus.py --query "..." < file` |
| Jina 401/429 | Set `JINA_API_KEY`, retry |
| Hard bot wall on all of the above | Tier 3 local browser (one-time install) |

## Rules
- Never hardcode API keys; keys come only from environment variables. Never echo a key.
- Cite fetched sources (URL + access date) in any deliverable that uses them.
- Respect sites' limits: these are low-volume research tools, not scrapers.
- Focused output is an excerpt. If the answer isn't in it, widen `--max-tokens` or reword the query before concluding the page doesn't say it.
## Tests
```bash
python3 -m unittest discover -s skills/web-research/tests
```

Stdlib `unittest`, no network, no installs.
