---
name: anthropic-docs
description: Navigate Anthropic's official documentation (Claude API / cloud platform AND Claude Code CLI) efficiently. Use when building or debugging Claude API / Anthropic SDK code, working with Managed Agents (agents, sessions, deployments, skills, memory, vaults), configuring or troubleshooting Claude Code (hooks, slash commands, MCP, settings, subagents), or whenever the user asks where something is documented. ALWAYS resolve a page through the llms.txt index before guessing a URL — guessing stale paths is what causes "page not found". Every docs page can be fetched as raw markdown by appending .md to the URL.
---

# Anthropic Documentation Navigator

Anthropic splits its docs across **two roots**. Pick the right one, then use the index — never guess a deep path.

## The two doc roots

| Domain | Covers | Master index |
|---|---|---|
| `platform.claude.com` | Claude **API** / Anthropic **SDK** / cloud platform: Messages API, Tool Use, Vision, Files, Batch, Prompt Caching, Extended Thinking, **Managed Agents** (agents, sessions, deployments, skills, memory, vaults, environments), Admin/Compliance, full API Reference | `https://platform.claude.com/llms.txt` |
| `code.claude.com/docs` | **Claude Code CLI**: install, settings, CLAUDE.md/memory, hooks, slash commands, skills, subagents, MCP, IDE integrations, **Agent SDK** (Python/TS), enterprise/admin, tools/hooks/error reference | `https://code.claude.com/docs/llms.txt` |

Redirect notes (follow the 301, don't treat as broken):
- `docs.claude.com` and `docs.anthropic.com` → `platform.claude.com`
- old `docs.claude.com/en/docs/claude-code/*` → `code.claude.com/docs/en/*`

## Core patterns

**1. Index first.** Fetch the relevant `llms.txt` to discover the exact page path. The platform index lists ~1,680 English pages grouped by section (Messages, Managed Agents, Admin, API Reference). Resolve the page from there before fetching.

**2. Raw markdown by appending `.md`.** Every docs page serves clean markdown at `<url>.md`:
- HTML: `https://platform.claude.com/docs/en/managed-agents/scheduled-deployments`
- Markdown: `https://platform.claude.com/docs/en/managed-agents/scheduled-deployments.md`

Prefer the `.md` form when fetching — less HTML noise, fewer tokens.

**3. Do NOT fetch `llms-full.txt`.** It exists (the entire docs concatenated) but exceeds WebFetch's 10 MB limit and will error. Use `llms.txt` (the index) + individual `.md` pages instead.

**4. URL shape.** Pages live at `/docs/en/<section>/<page>`. English is `/docs/en/...`; other locales swap `en` for `de`, `es`, `ja`, etc. (translations cover ~131 pages vs 1,680 English).

## Workflow

1. Decide the root: API/SDK/Managed-Agents → `platform.claude.com`; Claude Code CLI → `code.claude.com/docs`.
2. Fetch that root's `llms.txt` (or check `references/doc-map.md` for the section map and common direct URLs).
3. Identify the page path, fetch `<url>.md`.
4. If a known URL 404s, it's almost certainly stale — go back to `llms.txt` and re-resolve rather than guessing variants.

See `references/doc-map.md` for the full section breakdown and high-traffic direct links (Managed Agents, scheduled deployments, prompt caching, hooks, etc.).
