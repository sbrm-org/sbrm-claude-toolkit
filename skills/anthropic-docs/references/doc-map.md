# Developer Docs — Structure Map

Verified: 2026-08-13

Section-level structure for the two developer roots, to narrow a search before hitting `llms.txt`. For plans/seats/billing/account-GUI/org-admin, see `help-center-map.md`.

**This is a dated cache.** Section names and page paths change. `llms.txt` is the source of truth — if this file disagrees with it, this file is wrong. Resolve exact paths there rather than pasting from here. Deliberately no page counts and no exhaustive link lists: those rot fastest.

Reminder: on both roots a stale path returns 200 with the *wrong page*. Platform emits `url:` frontmatter to check; code emits none, so check the `# H1` or confirm the path in the index.

## platform.claude.com — Claude API / SDK / cloud platform

Index: `https://platform.claude.com/llms.txt` · Pages: `/docs/en/<section>/<page>` (+ `.md`) · English plus other locales · `llms-full.txt` exists but is far too large to fetch.

### Sections

| Section | What's actually in it |
|---|---|
| Messages | **Misleadingly narrow name** — this is essentially the whole `build-with-claude/*` + `agents-and-tools/*` surface (plus a few strays like `intro` and `get-api-key`): Agent Skills, all tool use (bash, computer use, code execution, memory, text editor, web fetch/search, tool search, programmatic/parallel/strict tool calling, tool runner), MCP connector and remote MCP servers, MCP tunnels, prompt caching, batch, Files API, PDF/vision, citations, structured outputs, streaming, token counting, context windows/editing/compaction, thinking and effort budgets, embeddings, and third-party platforms (Bedrock, Vertex AI, Microsoft Foundry, Claude Platform on AWS). If you're looking for an API *feature*, start here. |
| Managed Agents | Agent setup and config, Build in Console, cloud environments and sandboxes, sessions, event streaming and webhooks, skills and memory stores, tools and permissions, file management, GitHub integration, vault auth, multi-agent sessions, scheduled deployments |
| Admin | Auth and WIF, API/external keys, orgs/users/roles/groups, workspaces, Compliance API, activity feed, usage/cost/spend-limit/rate-limit/analytics APIs, data residency, CMEK, WIF providers, Claude Code analytics |
| Best practices | Prompt engineering and per-model prompting guides, `strengthen-guardrails/*` (hallucinations, prompt leak, jailbreaks, consistency, latency), develop-tests, use-case guides, glossary |
| Models & pricing | Models overview, choosing a model, model IDs/versioning, deprecations, migration guide, per-token pricing, model cards, system prompts |
| CLI, SDKs, and libraries | The first-party CLI, the language SDKs (Python, TS, Go, Java, Ruby, PHP, C#), SDK middleware, OpenAI-SDK compatibility, Apple Foundation Models |
| API reference *(conceptual)* | Overview, beta headers, errors, rate limits, service tiers, IP addresses, supported regions, versioning, IAM actions |
| API Reference *(generated)* | Per-endpoint pages under `api/beta/*`, `api/admin/*`, `api/compliance/*`, `api/messages/*`, `api/models/*` — the bulk of this root's page count, so expect index noise from it when grepping |
| Release notes, Claude API skill, Docs home | Small; self-explanatory |

⚠️ **Two sections share a name** — conceptual `API reference` vs generated `API Reference`. Don't conflate them.

⚠️ **No account-GUI docs here.** No workbench, prompt generator, prompt improver, eval tool, billing, plans, or seats pages; those legacy URLs were retired and now silently serve replacement pages. Resource-level Console UI *is* documented — see `manage-claude/workspaces` § Using the Console, and `managed-agents/onboarding` ("Build in Console").

⚠️ **No invoice, subscription, seat, or payment-method endpoints exist in the API.** Billing questions are help-center articles, not API calls.

### Anchors

- Org/Console-adjacent, the single best page on this root: `/docs/en/manage-claude/workspaces.md` — workspaces, API-key assignment, member roles, spend/rate limits, centralized billing
- Getting a key: `/docs/en/get-api-key.md` · Admin API: `/docs/en/manage-claude/admin-api.md`
- Per-token pricing: `/docs/en/about-claude/pricing.md` · Retirements: `/docs/en/about-claude/model-deprecations.md`
- Rate limits (conceptual): `/docs/en/api/rate-limits.md`
- Managed Agents: `/docs/en/managed-agents/overview.md` · core API resources `/v1/agents`, `/v1/sessions`, `/v1/environments`, `/v1/memory_stores` (all require a beta header, and memory stores use a different one — read the Note block atop `managed-agents/reference.md` rather than trusting a remembered date string)
- ⚠️ `/v1/deployments` is **scheduled deployments**, a different corner of the product — don't reach for it when you mean agents. Console: `/workspaces/default/agent-quickstart/` builds an agent; `/workspaces/default/deployments` is scheduling.

## code.claude.com/docs — Claude Code CLI

Index: `https://code.claude.com/docs/llms.txt` — **one flat list, no sections**; the tab structure below comes from site nav, not the index, so it cannot be refreshed from `llms.txt`. Pages: `/docs/en/<page>` (+ `.md`) · internal links are written `/docs/en/<page>` · `.md` pages open with a pointer block then `# Title`, **no YAML frontmatter** · `llms-full.txt` exists but is too large to fetch.

### Tabs

| Tab | Landing |
|---|---|
| Getting started | `/en/overview` |
| Build with Claude Code | `/en/agents` |
| Administration | `/en/admin-setup` |
| Configuration | `/en/settings` |
| Reference | `/en/cli-reference` |
| Agent SDK | `/en/agent-sdk/overview` |
| What's New | `/en/whats-new/index` |
| Resources | `/en/legal-and-compliance` |

Notable clusters worth knowing exist, then resolving in the index: **gateways** (`claude-apps-gateway*`, `llm-gateway*`), **plugins** (`plugins*`, `plugin-*`), **multi-agent** (`agents`, `agent-teams`, `agent-view`, `workflows`, `worktrees`), **self-hosted runners** (`self-hosted-environments*`), **cloud providers** (`amazon-bedrock`, `google-vertex-ai`, `microsoft-foundry`, `claude-platform-on-aws`), and **Agent SDK** (a large sub-tree under `/en/agent-sdk/`).

### Disambiguations that bite

- `/en/hooks` = hooks **reference**; `/en/hooks-guide` = the **how-to**. Both live.
- `/en/mcp` = full MCP guide; `/en/mcp-quickstart` = add-a-server. Both live.
- `/en/permissions` and `/en/permission-modes` are different pages.
- Agent SDK pages mirror top-level names — `/en/agent-sdk/permissions`, `/hooks`, `/sessions`, `/subagents` all exist alongside different top-level pages of nearly the same name (note the top-level one is `/en/sub-agents`, hyphenated). Always write the full path.
- `/en/claude-tag` and `/en/slack` are both live and their relationship is in flux; read each page's description line to see which is current.
- Scheduling splits three ways: `/en/routines` (Anthropic-hosted), `/en/desktop-scheduled-tasks`, `/en/scheduled-tasks` (`/loop`, in-session).

### Anchors

`/en/overview` · `/en/quickstart` · `/en/settings` · `/en/memory` · `/en/skills` · `/en/sub-agents` · `/en/commands` · `/en/cli-reference` · `/en/mcp` · `/en/hooks` · `/en/admin-setup` · `/en/costs` · `/en/feature-availability` (plan matrix — closest thing to a seats page) · `/en/agent-sdk/overview` · `/en/troubleshooting`
