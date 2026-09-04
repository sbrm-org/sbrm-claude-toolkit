---
name: bookstack
description: >
  Use the SBRM Wiki (BookStack at wiki.sbrmapps.com) from Claude or any AI agent: how the wiki is
  organized (Departments > Notebooks > Sections > Pages), how to log in, how to create your own API
  token for your agent, and how to read, search, create, and update wiki content through the REST
  API without breaking the house conventions. Triggers on "SBRM Wiki", "the wiki", "BookStack",
  "wiki.sbrmapps.com", "wiki API token", "put this on the wiki", "update the wiki page",
  "search the wiki", "find the policy on the wiki", "add a page to my department's notebook".
---

# SBRM Wiki (BookStack)

SBRM's staff knowledge base runs on **BookStack**, an open-source wiki, at **https://wiki.sbrmapps.com**. It replaced Perfect Wiki. Everything staff need to know about how SBRM works, department by department, lives here, and it is meant to be read and written by people *and* by their AI agents.

This skill is for staff and their agents *using* the wiki. Server administration (upgrades, theme, SSO configuration, roles, creating departments) is not covered; route those to the administrator (Tim).

## How the wiki is organized

BookStack's built-in names are renamed on our instance. The API still uses BookStack's names, so you need both columns:

| What you see | BookStack / API name | What it is |
|---|---|---|
| **Department** | shelf (`/api/shelves`) | A label, not a folder. One notebook can appear on several departments. |
| **Notebook** | book (`/api/books`) | The unit of ownership and permissions. Every notebook sits on at least one department. |
| **Section** | chapter (`/api/chapters`) | A group of pages inside a notebook. |
| **Page** | page (`/api/pages`) | The content. Every page lives in a section, except one "Start Here" / overview page per notebook. |

The nine departments: All Staff, HR, Finance, Shelter Programs, Treatment, Sober Living, Development, Operations, IT & Systems. Each has a "<Department> Knowledge Base" notebook for institutional knowledge, plus optional topical notebooks (HR Best Practices, Donor App Guide, and so on).

House rules your agent must follow when it writes:

- **Never duplicate a notebook to make it show up in two departments.** Departments are labels; ask the administrator to cross-list it.
- **New pages go inside a section**, not loose in a notebook. If no section fits, create one, or ask the notebook's owner.
- **New departments and new notebooks are a decision for the department lead and the administrator**, not something an agent creates on its own. Pages and sections are yours.
- **Edit in place; do not clone.** If a page exists on the topic, update it (BookStack keeps full revision history, so nothing is lost).
- The staff-facing version of all this is on the wiki itself: All Staff → **SBRM Wiki Guide**.

## Logging in

Go to https://wiki.sbrmapps.com. It sends you straight to Microsoft sign-in; use your `@sbrm.org` account. There is no separate wiki password. The first login creates your account automatically. If you can read the wiki but not edit or create anything, you have the Viewer role; ask the administrator for Editor.

The wiki is also pinned as a tab in Teams. That tab is fine for reading; do token and API work in a normal browser.

## Create your own API token

Everyone creates and holds their own token. Tokens are personal and are never shared between people, and an agent acting for you uses *your* token, so the wiki's activity feed shows the change under your name. That is deliberate: the wiki should always show who changed what.

You need the **Editor** (or Admin) role. Viewers cannot create tokens; ask the administrator first.

1. Log in at https://wiki.sbrmapps.com.
2. Click your name or avatar in the top-right corner → **My Account**.
3. Open the **Access & Security** tab (direct link: https://wiki.sbrmapps.com/my-account/auth).
4. Scroll to **API Tokens** and click **Create Token**.
5. Fill in:
   - **Name**: what it is for, e.g. `claude-desktop-hr-laptop`, not `token1`. One token per agent or machine makes revoking easy later.
   - **Expiry**: the form defaults to a very long expiry. Pick something sensible (a year is plenty); you can always make another.
6. Click **Save**. The next screen shows two values: a **Token ID** and a **Token Secret**. **The secret is shown exactly once.** Copy both now. If you lose the secret, delete the token and make a new one; it cannot be shown again.
7. Store them in a password manager or your machine's secret store. Not in a chat message, not in a shared drive, not in a spreadsheet, not in a repo.
8. When an agent or laptop is retired, delete its token from the same screen.

A token carries exactly the permissions of your user. It cannot do anything you cannot do in the browser.

**Working with Claude:** put the token in an environment variable and let Claude read it from there. Never paste the secret into a conversation; everything typed into a chat becomes part of the transcript. The convenient form is one variable holding `ID:SECRET`:

```bash
# in your shell profile or secret store, never in a repo
export BOOKSTACK_API_TOKEN="<token id>:<token secret>"
```

### Authenticating requests

```bash
curl -s https://wiki.sbrmapps.com/api/books \
  -H "Authorization: Token $BOOKSTACK_API_TOKEN"
```

The header is literally `Authorization: Token <id>:<secret>` (the word `Token`, a space, then id, colon, secret). A `401` means the header is malformed, the token expired, or it was deleted. A `403` means your user lacks that permission on that content; the token is fine.

Rate limit: 180 requests per minute per user. Batch jobs should pace themselves.

## The API

Base URL: `https://wiki.sbrmapps.com/api`. Full, version-matched documentation for every endpoint lives on the wiki itself at **https://wiki.sbrmapps.com/api/docs** (log in first). It is generated by the running build, so it beats any external documentation. Read it before writing a call you have not made before.

### Reading

| Task | Call |
|---|---|
| List departments | `GET /shelves` |
| One department with its notebooks | `GET /shelves/{id}` |
| List notebooks | `GET /books` (add `?filter[name]=HR%20Knowledge%20Base` to find one by name) |
| A notebook's sections and pages, in order | `GET /books/{id}` (the `contents` array) |
| A page's content | `GET /pages/{id}` → `html` (rendered) and `markdown` (if the page was written in markdown) |
| Search | `GET /search?query=<terms>` (see below) |
| Export a page as plain text or markdown | `GET /pages/{id}/export/plaintext`, `/export/markdown`, `/export/pdf` |

Lists return at most 100 items by default (`count` up to 500) and paginate with `offset`; check `total` in the response.

Search uses the same syntax as the wiki's search box, and it is the fastest way to answer "where is the policy on X":

```bash
curl -s -G https://wiki.sbrmapps.com/api/search \
  --data-urlencode 'query=travel reimbursement {type:page}' \
  -H "Authorization: Token $BOOKSTACK_API_TOKEN"
```

Useful filters inside the query string: `{type:page}`, `{type:book}`, `{in_name:budget}`, `{updated_after:2026-01-01}`, and `"exact phrase"` in quotes.

### Writing

| Task | Call |
|---|---|
| Create a page in a section | `POST /pages` with `{"chapter_id": <section id>, "name": "...", "html": "<p>...</p>"}` (or `"markdown"` instead of `"html"`) |
| Update a page | `PUT /pages/{id}` with the fields to change (`name`, `html` or `markdown`, `chapter_id` to move it) |
| Create a section | `POST /chapters` with `{"book_id": <notebook id>, "name": "...", "description": "..."}` |
| Upload an image for a page | `POST /image-gallery` (multipart: `type=gallery`, `uploaded_to=<page id>`, `image=@file.png`) → use the returned `url` in an `<img>` |
| Delete a page | `DELETE /pages/{id}` (goes to the recycle bin; the administrator can restore it) |

Writing rules for agents:

- **Read before you write.** `GET` the page, make your change to the returned `html` or `markdown`, then `PUT` it back. Never overwrite a page with only your new paragraph.
- **Send `html` or `markdown`, not both.** Sending `html` to a page written in markdown converts it to the visual editor; that is fine, but do it knowingly.
- **Keep formatting simple.** Headings (`h2`, `h3`), paragraphs, lists, tables, links, images. The wiki strips scripts, forms, and inline SVG; do not try to embed them.
- **Diagrams** go in as PNG images (export at 2x or 3x so they stay sharp when zoomed) wrapped like this, which the wiki styles full-width with click-to-zoom:

  ```html
  <figure class="sbrm-diagram"><img src="<image url from /image-gallery>" alt="What it shows"><figcaption>What it shows. Click to zoom.</figcaption></figure>
  ```

- **Do not bulk-edit** (renaming or moving many pages, deleting sections) without checking with the notebook's owner. Every change is attributed to you and shows in the department's activity feed.

### Worked example: agent adds a how-to to a department notebook

1. Find the notebook: `GET /books?filter[name]=Finance%20Knowledge%20Base` → note its `id`.
2. Find the right section: `GET /books/{id}` → look through `contents` for a chapter such as "Procedures"; note its `id`.
3. Check nothing exists yet: `GET /search?query=petty cash {type:page}`.
4. Create: `POST /pages` with `chapter_id`, `name`, and `html`.
5. Tell the person the resulting URL (`https://wiki.sbrmapps.com/link/{page id}` always works).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401` on every call | Header not `Token id:secret`, or the token expired / was deleted. Make a new one. |
| `403` on a write | Your user is a Viewer, or the notebook's permissions exclude your department. Ask the administrator. |
| `404` for a page you can see in the browser | Wrong id (page ids and notebook ids are separate sequences), or the page is in the recycle bin. |
| Content you sent is missing after save | The wiki's HTML filter removed it (scripts, iframes, SVG, form elements). Use plain HTML. |
| Search finds nothing for an exact title | Add `{in_name:...}` or quote the phrase; search also honours your permissions, so you cannot find what you cannot read. |
| Cannot find "API Tokens" on My Account | You have the Viewer role. Ask the administrator for Editor. |

## Boundaries

- The wiki holds **how SBRM works**: procedures, policies, guides, contacts, system documentation. It is not a document store for signed forms (that is Documenso), not a task tracker, and not a place for client or resident information.
- **No protected health information and no client identifiers** on the wiki, ever. Program documentation describes processes, never people.
- Anything an agent publishes is attributed to you and visible to every staff member with access to that notebook. Review before you let an agent publish.
