---
name: perfect-wiki
description: Operating rules for SBRM's Perfect Wiki knowledge bases: how to search without spending the AI allowance, the HTML content format, and write safety. Use whenever reading, searching, creating, or editing Perfect Wiki content. Triggers on "Perfect Wiki", "the wiki", "knowledge base", "wiki page", "look it up in the wiki", "add this to the wiki", "update the wiki".
---

# Perfect Wiki
Perfect Wiki is reached either through MCP tools (`list_pages`, `get_page`, ...) or through the `perfectwiki-<space>` CLI wrappers, depending on the machine. The tool schemas describe the mechanics. This skill covers what they do not say, all of which costs money or breaks content if ignored.
## 1. Never call `ask`
`ask` is Perfect Wiki's AI query tool. **Every call is billed against SBRM's AI request allowance**, and that allowance is shared with the Perfect Wiki bot staff use inside Microsoft Teams. Spending it from Claude takes it away from them, and the whole thing returns `402 Payment Required` once it runs out.

It is removed from the CLI wrappers entirely. If you are on a connection where it still appears, **do not use it.** Search using the method below instead, which costs nothing.
## 2. How to search: list, then read
There is no free-text search endpoint. Search is two steps:

1. `list_pages` returns every page's title and tags in **one call**. No body text.
2. `get_page` on the candidates whose titles or tags look relevant. Full HTML content.

Both are free. They count only against the rate limit of **10 requests/second and 60/minute**, shared across everyone on that connection. A list plus a handful of reads sits comfortably inside that.

Titles alone are a weak signal, so read more candidates rather than fewer, but do not fetch an entire knowledge base page by page. If a title scan genuinely fails to surface anything, say so and ask rather than escalating to `ask`.
## 3. Content is HTML, in both directions
`get_page` returns HTML in `content`. `create_page` and `update_page` expect HTML.

**Never write Markdown into a page.** It will not render; it displays as literal asterisks and hashes. Convert to HTML before writing, and convert HTML to Markdown after reading if you are working with the text.
## 4. Writes are blunt
- **`delete_page` is permanent via the API.** Perfect Wiki's docs state it cannot be undone this way. Always confirm with the user before calling it, even when the request seems clear.
- **`update_page` replaces tags wholesale.** Passing `tags` drops every tag not in your list. Read the page first and pass the full intended set.
- Every connection carries full write and delete rights regardless of intent, so there is no permission backstop. Care at call time is the only guard.
## One connection, one knowledge base
A connection is scoped to a single knowledge base, backed by a Microsoft Teams channel. Multiple knowledge bases mean multiple registered servers or wrappers, named for their space. Pick by name and confirm with `get_knowledgebase` if unsure. If a page is not where you expect, the likely cause is the wrong connection, not a missing page.
## Tools
| Tool | Notes |
|---|---|
| `get_knowledgebase` | Confirm which space this connection points at |
| `list_pages` | Titles and tags only, no body. One call covers the space. |
| `get_page` | Full page, HTML content |
| `create_page` | Only `title` required. Content is HTML. |
| `update_page` | Tags replace, not merge |
| `delete_page` | Permanent. Confirm first. |
| `ask` | **Billed. Do not call.** Removed from the CLI wrappers. |

## CLI equivalent
Where Perfect Wiki is wrapped as a CLI rather than an MCP server, the same rules apply unchanged. Wrappers are named `perfectwiki-<space>`. Discover subcommands with `perfectwiki-<space> --list`; output is JSON on stdout. See the `mcp2cli` skill for wrapper conventions.
