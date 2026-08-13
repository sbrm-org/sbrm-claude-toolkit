# Help Center, Privacy Center & Un-indexed Roots

Verified: 2026-08-13

The non-developer surfaces — **plans, seats, billing, invoices, refunds, the Console GUI, org administration, SSO/SCIM, and data controls**. The account, plan, seat, and billing side lives *only* here. Platform docs cover the Admin **API** (programmatic orgs, users, roles, workspaces, spend limits) and resource-level Console UI, but never the account-GUI equivalent.

**This is a dated cache.** Collections are reasonably stable; individual articles are not. Deliberately no long slug lists — search the collection's entries in `llms.txt` instead.

⚠️ Collection IDs are **not** in `llms.txt` — refresh them from `https://support.claude.com/en/` (top-level cards only), not from the index.

## support.claude.com — Help Center

Index: `https://support.claude.com/llms.txt` — **~670 KB**, so pull it with `curl` and slice the `## English` block rather than WebFetching whole. No `llms-full.txt`.
Articles: `/en/articles/<id>-<slug>` (+ `.md`) · Collections: `/en/collections/<id>-<slug>` (**`.md` does not work on collections** — returns HTML) · `.md` has **no frontmatter**, so verify the `# H1`.

Intercom serves an article for any slug attached to a valid numeric ID, so a 200 does not prove you got the article you meant — match the title.

### Collections — the routing layer

| Collection | ID |
|---|---|
| Claude (core app) | `4078531-claude` |
| Pro and Max plans | `5953830-pro-and-max-plans` |
| **Team and Enterprise plans** (seats, billing, roles, org admin) | `9387370-team-and-enterprise-plans` |
| Identity management (SSO, JIT, SCIM) | `17270717-identity-management-sso-jit-scim` |
| Claude Cowork | `19667525-claude-cowork` |
| Claude Code (plans, limits, login — not the tool itself) | `14445694-claude-code` |
| Claude Desktop | `16163169-claude-desktop` |
| Claude Mobile apps | `9387080-claude-mobile-apps` |
| **Claude API and Console** (account-level Console GUI lives here) | `5370014-claude-api-and-console` |
| Connectors | `15399129-connectors` |
| Claude in Chrome | `18031491-claude-in-chrome` |
| Claude for Education | `12630177-claude-for-education` |
| Privacy and legal | `4078534-privacy-and-legal` |
| Safeguards | `4078535-safeguards` |
| Amazon Bedrock | `4078537-amazon-bedrock` |
| Claude for Government | `19395194-claude-for-government` |

### What lives where (search these collections, don't guess slugs)

- **Choosing/comparing plans, what Team or Enterprise includes** → Team and Enterprise plans, or Pro and Max plans
- **Seats: buying, assigning, removing** → Team and Enterprise plans
- **Billing mechanics: how the bill is calculated, cancellation, refunds, receipts/invoices, tax/VAT ID, payment-method verification** → Team and Enterprise plans (org) or Pro and Max plans (individual)
- **Roles and permissions, custom roles, RBAC** → Team and Enterprise plans
- **Members: inviting, managing, joining an org, claiming a domain, migrating personal → org, Team → Enterprise** → Team and Enterprise plans
- **Org-wide admin controls: org instructions, default model, model access, provisioning skills/plugins, authorizing MCP connectors, US-only inference** → Team and Enterprise plans
- **SSO / JIT / SCIM, per-IdP setup (Google Workspace, Entra ID, Okta, OneLogin, Ping)** → Identity management
- **Usage limits, usage bundles, credits, context window on paid plans** → Claude, Pro and Max plans, or Team and Enterprise plans
- **Raising API rate limits, tier/spend qualification** → Claude API and Console
- **Account-level Console GUI: workbench, inviting Console members, cost/usage reporting, Console roles, why a Claude subscription doesn't cover API/Console billing** → Claude API and Console
- **Projects, sharing, RAG** → Claude or Pro and Max plans; **disabling public projects org-wide** → Team and Enterprise plans
- **Org data controls: retention settings, data export, audit logs, IP allowlisting, HIPAA-ready plans, incognito chats, what happens to a removed user's data** → Team and Enterprise plans / Privacy and legal
- **Claude Code plans and limits, using it on Pro/Max or Team/Enterprise, install/auth troubleshooting** → Claude Code

### Anchors (also demonstrate the URL shape)

- `/en/articles/11049762-choose-a-claude-plan.md` — best plain-English plan comparison
- `/en/articles/9267276-roles-and-permissions.md`
- `/en/articles/9796807-creating-and-managing-workspaces-in-the-claude-console.md`
- `/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console.md` — resolves the subscription-vs-API-billing confusion this skill's routing is built around

## privacy.claude.com — Privacy Center

Index: `https://privacy.claude.com/llms.txt` (~130 KB) · same Intercom platform and URL shape as support · `.md` works on articles, no frontmatter.

Two sections: **Commercial Customers** (API, Team, Enterprise) and **Consumers** (Free/Pro/Max).

⚠️ **Identical and near-identical titles exist in both sections under different IDs.** "Is my data used for model training?" is byte-identical in both. "How do you use personal data in model training?" differs only in capitalization but shares an **identical slug** (`how-do-you-use-personal-data-in-model-training`), so only the numeric ID tells them apart. "How long do you store my data?" (Consumers) vs "How long do you store my organization's data?" (Commercial) is the milder case. Picking the wrong one yields a correct-sounding answer aimed at the wrong audience. Always confirm which section an article belongs to — the ID is the only reliable discriminator.

The consumer model-improvement/data-training toggle is documented here, **not** on support: `/en/articles/12109829-how-do-i-change-my-model-improvement-privacy-settings.md`. Zero-data-retention scope is a Commercial article.

Several org data-control articles are cross-listed on both support and privacy under the **same** article IDs — either host resolves to the same content.

## Un-indexed roots

No `llms.txt`, no `.md` — fetch the HTML page, or use the `web-research` skill. The index cannot see these; re-verify with `curl -sL -o /dev/null -w '%{http_code} %{url_effective}'`.

| URL | Covers | Gotchas |
|---|---|---|
| `claude.com/pricing` | Canonical plan pricing | `/pricing/max` and `/pricing/team` redirect back to `/pricing`; `/pricing/enterprise` → `/solutions/enterprise`. `claude.com/llms.txt` exists but is stale and still lists those redirecting sub-URLs as if distinct. `.md` 404s. |
| `anthropic.com/legal/aup` | Usage Policy | `/legal/usage-policy` **404s** |
| `anthropic.com/legal/privacy` | Privacy Policy | `/legal/privacy-policy` **404s** |
| `anthropic.com/legal/consumer-terms` | Consumer ToS | `anthropic.com/legal` redirects here |
| `anthropic.com/legal/commercial-terms` | Commercial ToS | `/legal/commercial-terms-of-service` **404s** |
| `trust.anthropic.com` | SOC 2, ISO, subprocessors | Vanta SPA. Its `llms.txt` returns **200 with HTML** — a false positive. Needs a browser. |
| `status.claude.com` | Incident history and published uptime percentages | Machine-readable at `/api/v2/summary.json` and `/api/v2/status.json`, plus `/history.rss`. Bare `/api` is HTML. `status.anthropic.com` redirects here. ⚠️ Published uptime is **not** a contractual SLA — the Commercial Terms contain no SLA or service-level clause, and enterprise SLAs are negotiated in the customer agreement rather than published. Route SLA questions to sales/legal, not to a docs page. |
| `anthropic.com/news` · `/engineering` · `/transparency` · `/supported-countries` | Announcements, engineering blog, transparency reports, regional availability | |
| `claude.com/blog` | Product/teams blog | Distinct from `anthropic.com/news` |
| `github.com/anthropics/claude-cookbooks` | Cookbook notebooks | Repo renamed; `anthropic-cookbook` redirects here |

The legal 404s above are worth keeping: each wrong slug is the one a reasonable person would guess first.
