---
name: perfect-wiki
description: Operating rules for SBRM's Perfect Wiki knowledge bases: how to search without spending the shared AI allowance, the HTML content format, and write safety. Use whenever reading, searching, creating, or editing Perfect Wiki content. Triggers on "Perfect Wiki", "the wiki", "knowledge base", "wiki page", "look it up in the wiki", "add this to the wiki", "update the wiki".
---

# Perfect Wiki
Perfect Wiki holds SBRM's internal knowledge bases. Each connection is scoped to one knowledge base and exposes tools named `list_pages`, `get_page`, `create_page`, `update_page`, `delete_page`, `get_knowledgebase`, and `ask`. The tool schemas describe the mechanics. This skill covers what they do not say, all of which costs the organization money or breaks content if ignored.
## 1. Never call `ask`
`ask` is Perfect Wiki's AI query tool, and it will usually be available. **Do not call it.**

Every call is billed against SBRM's Perfect Wiki AI request allowance. That allowance is shared organization-wide with the Perfect Wiki bot staff use inside Microsoft Teams, so spending it here takes searches away from colleagues, and everything returns `402 Payment Required` once it runs out. There is no per-user budget and no warning before the cap.

This holds even when `ask` looks like the obvious tool for the job. It usually does. Use the method below instead, which is free.
## 2. How to search: list, then read
There is no free-text search endpoint, so search is two steps:

1. `list_pages` returns every page's title and tags in **one call**. No body text.
2. `get_page` on the candidates whose titles or tags look relevant. Returns full HTML content.

Both are free. They count only against a rate limit of **10 requests/second and 60/minute**, shared by everyone on that connection. One list plus a handful of reads sits comfortably inside it.

Titles are a weak signal on their own, so read a few extra candidates rather than too few. Do not walk an entire knowledge base page by page. If a title and tag scan genuinely surfaces nothing, say so and ask the user how to narrow it, rather than falling back to `ask`.
## 3. Content is HTML, in both directions
`get_page` returns HTML in `content`. `create_page` and `update_page` expect HTML.

**Never write Markdown into a page.** It will not render; it displays as literal asterisks and hashes. Convert to HTML before writing, and convert HTML to Markdown after reading if you are working with the text.
## 4. Writes are blunt
- **`delete_page` is permanent.** Perfect Wiki's docs state an API delete cannot be undone. Always confirm with the user before calling it, even when the request seems clear.
- **`update_page` replaces tags wholesale.** Passing `tags` drops every tag not in your list. Read the page first, then pass the full intended set.
- Every connection carries full write and delete rights regardless of what the user intended, so there is no permission backstop. Care at call time is the only guard.
## 5. One connection, one knowledge base
A connection is scoped to a single knowledge base, backed by a Microsoft Teams channel, so a user only sees the wikis whose channel they belong to. Several knowledge bases means several connections, each named for its space.

Pick by name. When a connection's name is ambiguous, or a page is not where it should be, call `get_knowledgebase` to confirm which space you are actually on. A missing page is more often the wrong connection than a missing page.
## Tools
| Tool | Notes |
|---|---|
| `get_knowledgebase` | Confirm which space this connection points at |
| `list_pages` | Titles and tags only, no body. One call covers the space. |
| `get_page` | Full page, HTML content |
| `create_page` | Only `title` required. Content is HTML. |
| `update_page` | Tags replace, not merge |
| `delete_page` | Permanent. Confirm first. |
| `ask` | **Billed against a shared allowance. Do not call.** |

## Note for CLI users
Some machines reach Perfect Wiki through `perfectwiki-<space>` CLI wrappers instead of MCP. Every rule above applies unchanged. Subcommands are hyphenated (`list-pages`, not `list_pages`), `ask` is excluded from those wrappers entirely, and output is JSON on stdout. See the `mcp2cli` skill for wrapper conventions.
