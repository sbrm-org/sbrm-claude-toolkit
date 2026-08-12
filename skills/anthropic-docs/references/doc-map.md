# Anthropic Docs — Section Map & Direct Links

Two roots. Always re-resolve via `llms.txt` if a path 404s — these are a cache, not the source of truth.

## platform.claude.com — Claude API / SDK / cloud platform

Master index: `https://platform.claude.com/llms.txt` (~1,680 EN pages). Page shape: `https://platform.claude.com/docs/en/<section>/<page>` (+ `.md` for raw).

### Messages (core API)
Intro, Quickstart, Features overview, Build with Claude (Batch, Vision, Files API), Agent Skills (overview/quickstart/best-practices/enterprise), MCP Tunnels, Tool Use (define/handle-calls/how-it-works/parallel), Advanced (adaptive thinking, extended thinking, structured outputs, prompt caching), Streaming, Citations & Search results, Token counting & Context windows, Multilingual.

### Managed Agents
Overview & Quickstart, Agent setup & Configuration, Prototype in Console, Cloud environments & Sandboxes, Sessions & Session operations, Event streaming & Webhooks, Skills & Memory stores, Tools & Permissions, File management, GitHub integration, Vault authentication, Multi-agent sessions, **Scheduled deployments**.

### Admin
Authentication & WIF, API Keys & External Keys, Orgs/Users/Roles/Groups, Workspaces & Members, Compliance API (Activities/Chats/Files/Projects), Activity Feed, Usage & Cost API, Rate Limits API, Data residency & CMEK (AWS KMS / Azure Key Vault / GCP KMS), WIF Providers (AWS/GitHub Actions/GCP/Kubernetes/Azure/Okta/SPIFFE), Claude Code Analytics API.

### API Reference
Per-resource endpoints, SDK tabs: Beta, CLI, C#, Go, Java, PHP, Python, Ruby, Terraform, TypeScript. Resources: Messages (+Batch, count tokens), Agents (beta), Sessions (beta), Memory Stores (beta), Skills (beta), Deployments (beta) + Deployment Runs, Vaults (beta), Environments (beta), Files (beta), User Profiles (beta), Models, Admin (API/External Keys, Invites, Tunnels, Cost/Usage), Compliance.

### High-traffic direct links
- Managed Agents overview — `/docs/en/managed-agents/overview`
- Scheduled deployments — `/docs/en/managed-agents/scheduled-deployments`
- Sessions — `/docs/en/managed-agents/sessions`
- Agent setup — `/docs/en/managed-agents/agent-setup`
- Environments — `/docs/en/managed-agents/environments`
- Webhooks — `/docs/en/managed-agents/webhooks`
- Memory stores — `/docs/en/managed-agents/memory`
- Vaults — `/docs/en/managed-agents/vaults`
- Prompt caching — `/docs/en/build-with-claude/prompt-caching` (verify exact path in llms.txt)
- Console deployments UI — `https://platform.claude.com/workspaces/default/deployments`
- API base for Managed Agents: `https://api.anthropic.com/v1/deployments` (beta header `managed-agents-2026-04-01`)

## code.claude.com/docs — Claude Code CLI

Master index: `https://code.claude.com/docs/llms.txt`. Page shape: `https://code.claude.com/docs/en/<page>` (+ `.md` for raw). Internal links in pages are written relative as `/en/<page>`.

### Sections
- **Getting started**: Quickstart, Overview, How Claude Code works
- **Install/setup**: Advanced setup, Troubleshoot install/login, Authentication, Terminal config
- **Usage**: Interactive mode, CLI reference, Commands, Common workflows, Permission modes, Sessions
- **Configuration**: Settings, Env variables, CLAUDE.md & Memory, Hooks, Skills, Subagents, MCP, Keyboard shortcuts
- **Advanced**: Computer use, Chrome, Desktop app, VS Code, JetBrains, Web, Mobile/Remote control
- **Agent SDK**: Python & TS references, Quickstart/overview, Custom tools/hooks/MCP, Sessions/streaming/structured outputs, Hosting/deployment, Cost tracking/observability
- **Enterprise**: Admin setup, Permissions & policies, Analytics, Server-managed settings, Network config, Secure deployment
- **Extensions**: Plugins, MCP servers, GitHub Actions, GitLab CI/CD, Slack, Cloud platforms (AWS/GCP/Azure)
- **Reference**: Tools, Hooks, Errors, Glossary, Changelog, What's new

### High-traffic direct links
- Overview — `/en/overview`
- Quickstart — `/en/quickstart`
- Settings — `/en/settings`
- CLAUDE.md & Memory — `/en/memory`
- Hooks — `/en/hooks`  | Hooks reference — `/en/hooks` (reference variant in Reference section)
- Skills — `/en/skills`
- Subagents — `/en/sub-agents`
- MCP — `/en/mcp` | MCP quickstart — `/en/mcp-quickstart`
- Slash commands / Commands — `/en/commands`
- CLI reference — `/en/cli-reference`
- Routines (scheduled, Anthropic-hosted) — `/en/routines`
- Desktop scheduled tasks — `/en/desktop-scheduled-tasks`
- `/loop` in-session — `/en/scheduled-tasks`
- Agent SDK overview — `/en/agent-sdk/overview`
- GitHub Actions — `/en/github-actions`

## Fetch tips
- Use `<url>.md` for raw markdown (confirmed on both roots).
- Don't fetch `llms-full.txt` — >10 MB, exceeds WebFetch limit.
- `docs.claude.com` / `docs.anthropic.com` 301 → `platform.claude.com`; old `docs.claude.com/en/docs/claude-code/*` 301 → `code.claude.com/docs/en/*`. Follow the redirect.
