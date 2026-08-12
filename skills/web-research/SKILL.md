---
name: web-research
description: Layered web search and page fetching beyond the built-in WebSearch/WebFetch tools. Tavily API (paid, TAVILY_API_KEY) as the primary upgrade for search + extraction, with free keyless fallbacks (DuckDuckGo search script, Jina Reader fetch script) and guidance for bot-walled pages. Use when built-in web tools fail, are unavailable, or return poor results, or when higher-quality search/extraction is needed.
---

# Web Research (Layered Search & Fetch)

Layered options for getting web content when the built-in tools don't deliver. Start at Tier 0; escalate on failure or when you need better results.

> **Claude Desktop app users**: this skill's scripts are for Claude Code (they run shell/Python locally). In the Desktop app, use the **Exa connector** from the official connector directory instead.

## Tier 0 — Built-in tools (default)

Use the built-in `WebSearch` and `WebFetch` tools first, every time. Move on when they fail, are unavailable in the session, or return clearly poor results (empty pages, bot-check text, irrelevant hits).

## Tier 1 — Tavily (paid, best results; requires `TAVILY_API_KEY`)

If `TAVILY_API_KEY` is set in the environment, Tavily is the primary fallback — purpose-built for LLM research, with both search (including a synthesized answer) and page extraction:

```bash
scripts/tavily.sh search "your query"     # top 5 results + answer
scripts/tavily.sh extract "https://example.com/page"
```

- If the key is unset, the script prints a pointer to the free tiers and exits 1 — just drop to Tier 2.
- Never hardcode or echo the key; it comes only from the environment.

## Tier 2 — Free script fallbacks (no key needed)

### Search: DuckDuckGo

```bash
python3 scripts/ddg_search.py "your query" [--count N] [--site domain.com]
```

- Scrapes DuckDuckGo's no-JS HTML endpoint; stdlib only, no dependencies.
- Prints numbered results: title, real URL (redirect-unwrapped), snippet.
- Be polite: a few queries per minute. If DDG serves a bot-check page the script says so on stderr — wait a minute and retry.

### Fetch: Jina Reader

```bash
scripts/jina_fetch.sh "https://example.com/page"
```

- Returns the page as clean markdown via `https://r.jina.ai/<url>`.
- Works keyless at low rate limits, but keyless access is **network-reputation-dependent**: some networks are blocked from anonymous use (HTTP 401 with a "network reputation" message) — that's the network, not the URL.
- **Higher limits / unblocking**: set the optional `JINA_API_KEY` environment variable and the script sends it as a Bearer token automatically. A free personal key is available at https://jina.ai/reader. Never hardcode keys.
- Failures print the HTTP status and what to do next on stderr.

## Tier 3 — Local browser (documented, not scripted)

For pages behind aggressive bot walls (Akamai, Imperva, PerimeterX, press-and-hold checks) that defeat Tiers 0-2, a locally installed real browser is the strongest option:

1. One-time install: `pip install playwright && playwright install chromium` (or use any Playwright/Puppeteer setup already on the machine).
2. Drive a **headed** (visible-window) browser to load the page, then extract `document.body.innerText` or save the HTML.
3. This requires a local install and a machine with a display; it is deliberately not bundled here. If it's needed regularly, ask your admin about a standing setup.

## Choosing a path

| Situation | Do this |
|---|---|
| Normal search/fetch | Built-in WebSearch/WebFetch (Tier 0) |
| Built-ins fail/poor AND `TAVILY_API_KEY` set | `tavily.sh search` / `tavily.sh extract` |
| No Tavily key, search needed | `ddg_search.py` |
| No Tavily key, fetch needed | `jina_fetch.sh` |
| Jina 401/429 | Set `JINA_API_KEY`, retry |
| Hard bot wall on all of the above | Tier 3 local browser (one-time install) |

## Rules

- Never hardcode API keys; keys come only from environment variables. Never echo a key.
- Cite fetched sources (URL + access date) in any deliverable that uses them.
- Respect sites' limits: these are low-volume research tools, not scrapers.
