---
name: anthropic-docs
description: Find and cite the right page in Anthropic's official documentation. Covers the Help Center (support.claude.com) for plans, seats, billing, usage limits, Projects, the Console, organization and member administration, and SSO/SCIM; the Privacy Center (privacy.claude.com) for data training, retention, and GDPR; un-indexed roots for legal terms, usage policy, trust center, status, and pricing; and the developer docs for the Claude API/SDK (platform.claude.com) and the Claude Code CLI (code.claude.com). Use whenever someone asks how a Claude feature or plan works, what a subscription includes, how to administer an organization, what happens to data put into Claude, where something is documented, or wants a help-center or support article. Resolve every page through the root's llms.txt index rather than guessing a URL — stale paths return the wrong page, not a 404.
---

# Anthropic Documentation Navigator

Verified: 2026-08-13

**This skill routes; it does not remember.** Anthropic reorganizes docs frequently, so the durable knowledge here is *which root owns a question* and *how to resolve a page safely*. Look specific pages up live from each root's `llms.txt`; never recall a path from memory. Treat everything in `references/` as a dated cache to verify, not as truth.

## Step 1 — Route by audience

Most questions land in the first three rows. The developer roots are further down for a reason: they are the wrong answer for anything about accounts, plans, or day-to-day use.

| The question is about... | Root |
|---|---|
| **Using Claude day to day** — plans and what they include, usage limits, Projects, Cowork, the desktop/mobile/Chrome apps, connectors | `support.claude.com` |
| **Running an organization** — seats, billing, invoices, refunds, member and role management, SSO/SCIM, org-wide controls, the Console GUI | `support.claude.com` |
| **What happens to data** — model-training settings, retention, GDPR, zero-data-retention | `privacy.claude.com` |
| Legal terms, usage policy, trust center, service status, marketing pricing | un-indexed roots |
| *Developer:* writing code against the API or SDKs, Managed Agents, model IDs, per-token pricing | `platform.claude.com` |
| *Developer:* the Claude Code CLI — install, settings, hooks, skills, MCP, Agent SDK | `code.claude.com/docs` |

**The distinction that drives most routing mistakes:** the developer docs cover the Admin *API* and the Console UI **only where it configures a developer resource** (workspaces, Managed Agents, MCP tunnels). They contain no plan comparison, no seats, and no billing pages. GUI that concerns the *account* rather than a *resource* — workbench, invites, cost reporting, plan changes, cancellation — is a **help-center** article. When a click is about the account, go to support; when it's about a resource, platform may well have it.

### Tie-breaks for questions that straddle roots

- **"How much does it cost?"** — per-seat/subscription cost, billing mechanics, refunds → support; per-token API rates → platform; marketing plan comparison → `claude.com/pricing`.
- **"Which models can I use?"** — which models a *plan or org* exposes → support; model IDs, capabilities, retirements → platform; which model Claude Code picks → code (`/en/feature-availability`).
- **Usage limits** — hitting a cap in normal use, bundles, credits → support; API rate limits and 429s → platform (`/docs/en/api/rate-limits`); raising API limits or qualifying for a higher tier → support (Claude API and Console).
- **Desktop / Chrome / mobile** — the standalone Claude app → support; Claude Code *inside* those surfaces → code.
- **Claude Code plans, limits, login trouble** — support (it has its own Claude Code collection); the tool's own behavior → code.
- **Bedrock / Vertex / Foundry** — calling the *API* through them → platform; running Claude *Code* on them → code. On support, Bedrock has its own collection while Vertex and Foundry coverage is thin to absent — search `llms.txt` for the provider name before routing there.

### Data-handling questions

Anything about what Claude does with information put into it — whether conversations train models, how long data is retained, what an admin can turn off, what happens to a departing member's data — belongs on `privacy.claude.com` or in the org data-control articles on support. Route the question to the documentation rather than answering from memory; the settings and the defaults differ by plan and change over time.

Separately, follow your organization's own policy on what may be put into any AI tool. This skill documents what Anthropic publishes; it is not a substitute for that policy.

## Step 2 — Resolve the page through the index

Never guess a deep path. Fetch the root's index and find the real one:

| Root | Index | Size note |
|---|---|---|
| `support.claude.com` | `/llms.txt` | **~670 KB — a plain fetch will truncate it** |
| `privacy.claude.com` | `/llms.txt` | ~130 KB, borderline |
| `platform.claude.com` | `/llms.txt` | small, fetches fine |
| `code.claude.com/docs` | `/llms.txt` | small, fetches fine |
| `anthropic.com`, `claude.com`, `trust.`, `status.` | none usable | fetch the HTML page, or use the `web-research` skill |

The support index is too large to pull whole. Two ways around it:

- **With a shell available**, slice the English block:

  ```bash
  curl -s https://support.claude.com/llms.txt | awk '/^## English/{f=1;next} /^## /{f=0} f' | grep -i '<your term>'
  ```

- **Without a shell**, skip the index entirely: open the relevant collection page from `references/help-center-map.md` and browse its article list, which is a fraction of the size.

`references/doc-map.md` and `references/help-center-map.md` cache section maps and a few anchor links to save a round-trip. They are dated. Where `llms.txt` can settle a disagreement, it wins — but note it does **not** contain support collection IDs, so that table is verified against the site, not the index.

## Step 3 — Fetch as markdown, then verify you got the right page

**Append `.md` to any article or docs page** on the four indexed roots for clean markdown (the HTML equivalents run from ~350 KB to ~1 MB):

- `https://support.claude.com/en/articles/<id>-<slug>.md`
- `https://privacy.claude.com/en/articles/<id>-<slug>.md`
- `https://platform.claude.com/docs/en/manage-claude/workspaces.md`
- `https://code.claude.com/docs/en/skills.md`

**⚠️ The trap that matters most: a stale path does NOT 404.** On both `platform.claude.com` and `code.claude.com`, retired URLs return **HTTP 200 serving the nearest surviving page**. A guessed-from-memory path will hand you a real, confident, wrong answer. Only genuinely nonexistent paths 404.

Detection differs by root:

| Root | How to confirm you got the page you asked for |
|---|---|
| platform | Check the `url:` field in the returned YAML frontmatter |
| code, support, privacy | **No frontmatter exists** — check the `# H1` title, or confirm the path is in `llms.txt` before fetching |

On support and privacy the slug is decorative: the help-center platform serves an article for **any** slug attached to a valid numeric ID, so a 200 proves nothing. Match the title.

Three more gotchas: **don't fetch `llms-full.txt`** (platform and code both publish one, far too large; support and privacy have none). **`.md` on a support/privacy *collection* URL returns HTML**, not markdown — it only works on articles. And **a 200 is not proof of markdown** — `trust.anthropic.com/llms.txt` returns 200 with an HTML shell; check `content-type`.

## Domain redirects

The whole estate migrated off `anthropic.com` to `claude.com`. Follow the 301s; they are not breakage. Prefer the new domains when citing.

`docs.claude.com` / `docs.anthropic.com` / `console.anthropic.com` → `platform.claude.com` · `support.anthropic.com` → `support.claude.com` · `privacy.anthropic.com` → `privacy.claude.com` · old `docs.claude.com/en/docs/claude-code/*` → `code.claude.com/docs/en/*`

## Keeping this skill from going stale

Each file carries a `Verified:` date. If it is more than ~6 months old, or a cached path misses, refresh instead of working around it:

1. **Section maps** — fetch each root's `llms.txt`; fix section names, add new clusters, delete what's gone.
2. **Support collection IDs** — *not in `llms.txt`*. Fetch `https://support.claude.com/en/` and read the top-level collection cards, each linking `/en/collections/<id>-<slug>`. The homepage also surfaces nested sub-collections; only the top-level cards belong in the table.
3. **Anchors** — re-fetch every one. On platform the `url:` frontmatter must equal the path requested; on support/privacy the `# H1` must match the title.
4. **Un-indexed roots** — the index cannot see these. Re-check each URL and each claimed-404 slug with `curl -sL -o /dev/null -w '%{http_code} %{url_effective}'`.
5. **The stale-path trap** — re-confirm it still behaves as described: fetch a known-retired path (expect 200 + wrong page) and a nonsense path (expect 404). The whole Step 3 safety rule rests on this.
6. Re-stamp the `Verified:` date in all three files, this one included.

Do **not** expand the maps back into long lists of individual article slugs, page counts, or superlatives like "largest collection" — those rot fastest and are exactly what the indexes are for. Section-level structure plus a few anchors is the target.

Freshness anchors when you need "what changed recently": Claude Code publishes a weekly changelog under `/en/whats-new/` (resolve the current week from the index — the series has gaps, don't assume contiguity); platform has `/docs/en/release-notes/overview.md`; model retirements live at `/docs/en/about-claude/model-deprecations.md`; service status is machine-readable at `https://status.claude.com/api/v2/summary.json`.
