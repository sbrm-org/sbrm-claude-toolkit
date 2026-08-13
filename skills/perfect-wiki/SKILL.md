---
name: perfect-wiki
description: Operating rules for SBRM's Perfect Wiki knowledge bases: what each call costs, how to search without burning the rate limit, and the HTML content format. Use whenever reading, searching, creating, or editing Perfect Wiki content. Triggers on "Perfect Wiki", "the wiki", "knowledge base", "wiki page", "look it up in the wiki", "add this to the wiki", "update the wiki".
---

# Perfect Wiki
Perfect Wiki is reached either through MCP tools (`list_pages`, `get_page`, `ask`, ...) or through the `perfectwiki` CLI wrapper, depending on the machine. The tool schemas describe the mechanics. This skill covers the four things they do not tell you, all of which cost money or break content if ignored.
## 1. `ask` is billed. `list_pages` loops are not free either.
`ask` is the AI query endpoint. **Every call counts against the plan's AI request allowance** and returns `402 Payment Required` once the allowance is spent. Do not call it speculatively, do not call it twice to "double-check," and do not fan it out across knowledge bases to see which one answers.

Rate limits are **10 requests/second and 60/minute, counted per connection and shared by everyone using it.** Perfect Wiki's own docs warn that bulk `list_pages` loops will hit these.
## 2. There is no search endpoint. `ask` is the search.
`list_pages` returns **titles and tags only** with no body text, so scanning it does not tell you what a page says.

The wrong instinct is to list every page, guess which look relevant, and `get_page` each one. That is many calls, it hits the rate limit, and it still misses pages whose titles do not match.

**Prefer one well-formed `ask` call.** It searches semantically and returns an answer plus `relatedPages` you can then `get_page` if you need the full text. Use `list_pages` only when you genuinely need an inventory of what exists rather than an answer.
## 3. Content is HTML, in both directions
`get_page` returns HTML in `content`. `create_page` and `update_page` expect HTML.

**Never write Markdown into a page.** It will not render; it will display as literal asterisks and hashes. Convert to HTML before writing, and convert HTML to Markdown after reading if you are working with the text.
## 4. Writes are blunt
- **`delete_page` is permanent via the API.** Perfect Wiki's docs state it cannot be undone this way. Always confirm with the user before calling it, even when the request seems clear.
- **`update_page` replaces tags wholesale.** Passing `tags` drops every tag not in your list. Read the page first and pass the full intended set.
- Every API token carries full write and delete rights regardless of intent, so there is no permission backstop. Care at call time is the only guard.
## One connection, one knowledge base
A connection is scoped to a single knowledge base. Multiple knowledge bases mean multiple registered servers or wrappers, named for their space. Pick by name and confirm with `get_knowledgebase` if unsure which one you are pointed at. If a page is not where you expect, the likely cause is the wrong connection, not a missing page.
## Tools
| Tool | Notes |
|---|---|
| `get_knowledgebase` | Confirm which space this connection points at |
| `list_pages` | Titles and tags only, no body. Do not loop. |
| `get_page` | Full page, HTML content |
| `ask` | Semantic search. **Billed per call.** |
| `create_page` | Only `title` required. Content is HTML. |
| `update_page` | Tags replace, not merge |
| `delete_page` | Permanent. Confirm first. |

## CLI equivalent
Where Perfect Wiki is wrapped as a CLI rather than an MCP server, the same rules apply unchanged. Discover subcommands with `perfectwiki --list` or `perfectwiki --search PATTERN`; output is JSON on stdout. See the `mcp2cli` skill for wrapper conventions.
