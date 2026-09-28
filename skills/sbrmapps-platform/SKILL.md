---
name: sbrmapps-platform
description: >-
  Use when a build or proposal needs hosting, a database, a web app, automation, a webhook
  endpoint, a scheduler, a wiki, or an e-sign tool, or when anyone is about to propose a new SaaS
  subscription. SBRM runs its own SSO-gated app platform at *.sbrmapps.com and can self-host many
  of these; this skill says how to check what the platform is and what is on it (the SBRM Wiki
  is the source of truth), when self-hosting is the right proposal, and who decides. Not an
  operator skill: it installs nothing. Triggers on "do we have a server", "where can we host
  this", "we need a database", "need a webhook receiver", "need a scheduler", "put this on a
  site", "sign up for <SaaS>", "is there a self-hosted option", "sbrmapps", "can SBRM host it",
  "self-host this for SBRM", "evaluate a self-hosted app", "which app should we use".
---

## What exists
SBRM runs its own application platform at `*.sbrmapps.com`, built on Cloudron, a product that installs, patches, and backs up self-hosted apps. Staff sign in to the apps with their SBRM Microsoft (Entra) accounts, and the set of apps is curated, not open. Today it hosts the staff wiki and an e-signing tool among others; the App inventory page on the wiki is the only current list. When you would otherwise assume "we need a subscription for that," check the platform first.

## The wiki is the source of truth
Never state platform facts (what is installed, versions, limits, who operates it) from memory. This section's What exists paragraph is the only description usable without the wiki, and only when labeled unverified. When you do read the wiki, quote the page name and its updated date in your answer.

Lookup method, using the `bookstack` skill and the person's own wiki token in `BOOKSTACK_API_TOKEN`:

```bash
command -v curl >/dev/null 2>&1 || { echo "Error: curl not found"; exit 1; }
[ -n "$BOOKSTACK_API_TOKEN" ] || { echo "No wiki token: go to step 3"; exit 1; }
curl -s -G -w '\n%{http_code}\n' https://wiki.sbrmapps.com/api/search \
  -H "Authorization: Token $BOOKSTACK_API_TOKEN" --data-urlencode 'query="Platform Ops" {type:book}'
```

0. No shell, no token, or a `401`, `403`, or `5xx` status: skip to step 3. Do not suggest creating a token or asking for a higher wiki role for this purpose.
1. The platform lives in the notebook titled **Platform Ops** on the IT & Systems department. Read, in this order: **Why Cloudron, and how the platform works** (what it is, why, what it costs), **App inventory** (what is installed now), **Building principles** (the rules for adding anything).
2. A `200` with `"total":0`: try `query=sbrmapps {type:page}` and `query="App inventory" {type:page}`. Search honours permissions, so still-empty results mean the person cannot see the book. Any non-200 status means you could not check the wiki; say that instead.
3. **Platform Ops is a restricted notebook** (IT & Systems role and operators only). If the person cannot read it, do not guess and do not request access on their behalf. Say: "The platform overview is in the restricted Platform Ops notebook. Tim Molloy can confirm whether the platform fits." Then draft the proposal from What exists above and flag every platform fact as unverified.
4. Staff-visible pages that touch the platform (the e-signing how-to in Operations Knowledge Base, the bill-processing how-to in Finance Knowledge Base) describe how to use one app. They are not the inventory; do not cite them as such.
5. If a wiki page and this skill disagree, the wiki page wins. Note the mismatch so this skill gets fixed.

## When to propose self-hosting instead of a SaaS subscription
Propose the platform when the need is administrative and the candidate app passes every gate. The full gates and their reasons are on the Building principles page; the short list:

- **Open source**, ideally an official Cloudron store package (community package second, custom package last and only with Tim's agreement).
- **SSO-capable**: sign-in through SBRM Microsoft accounts, set at install, not a toggle someone must remember.
- **Fits Cloudron**: runs as a packaged app with no server-level changes, no extra ports, no patching the app's code.
- **Administrative data only**: no client, treatment, or health records and no resident identifiers, with no exception path. A need that holds them is not a platform question.
- **One control surface**: users and access managed through Microsoft, not a second login system to maintain.

Custom code (a script, a webhook receiver, a scheduler, a bare database with no app around it) needs a custom package. Propose it as "custom, Tim decides", never as something the platform already offers. A need that fails any other gate is a SaaS or Microsoft 365 question, not a platform question. Say which gate failed.

## Boundaries
- Staff Claude never installs, configures, restarts, or requests access to anything on the platform, and never asks anyone for a Cloudron token or the server address.
- Proposals go to Tim Molloy (administrator). Approved operators work from the `sbrmapps-operator` skill; do not reproduce its steps here.
- Using an existing app (the wiki, e-signing) needs no proposal and no operator: use that app's own skill (`bookstack`, `documenso`).
- Never place platform hostnames beyond `*.sbrmapps.com`, addresses, app IDs, or token names in documents that leave the wiki.

## How to write the proposal
Draft one short message to Tim Molloy for the person to send; never send it yourself. Six lines: what to host (the app or need), whether an installed app might already cover it (ask, since the inventory may be unreadable to you), why not SaaS (cost, data location, or SSO), data class (administrative, and confirm no client data), who uses it and how many, and estimated load (users per day, storage, any integrations). Attach the gate results, one line each, and name the wiki pages and dates you checked.

## Before you report done
Re-read the wiki section: did you quote a page and its date, or did you state a platform fact from memory? If from memory, mark it unverified in the same message.
