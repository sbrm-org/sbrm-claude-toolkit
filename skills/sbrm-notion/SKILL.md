---
name: sbrm-notion
description: Map and conventions for the SBRM (Santa Barbara Rescue Mission) Notion workspace. Use whenever working with Notion at SBRM — searching pages, reading or updating databases (grants, projects, meeting notes, facilities inspections, IT inventory), or deciding where new content belongs. Triggers on "Notion", "SBRM workspace", "grant tracker", "meeting notes", "facilities inspections", "IT closet", "cash on hand".
---

# SBRM Notion Workspace Guide

How the SBRM Notion workspace is organized, and how to work in it safely using the official Notion connector (Claude Desktop / claude.ai) or Notion MCP (Claude Code).

## Ground rules

1. **Search before you create.** Always search the workspace for an existing page or database entry before adding anything — duplicates are the main source of clutter.
2. **Confirm the target database before writing.** Several databases have similar names (there are two "Open Projects" databases, and multiple inspection-related databases). Retrieve the database and check its properties match what you expect before inserting rows.
3. **Never bulk-edit without explicit confirmation.** Any change touching more than a couple of pages/rows: list exactly what will change and get a yes from the person you're working with first.
4. **Match existing property values.** Statuses, selects, and categories are curated lists (documented below). Use existing options; don't invent new ones without asking.
5. **No client data.** SBRM serves shelter guests and treatment-program residents. Never put client-identifying information (names, case details, health information) into Notion — it is not the system of record for client data.

## Workspace map

### Top-level pages

| Page | Purpose |
|---|---|
| Getting Started | Workspace orientation |
| 1:1 notes | One-on-one meeting notes |
| Cash on Hand | Hub page for the Cash on Hand Database |
| 2026 Grant Tracker | Hub page for the grant tracker database |
| Facilities Inspections Hub | Hub for the inspection system (items, monthly runs, results) |
| New-Staff Training | Onboarding/training program (sub-pages: Who We Are, Your Role, HR Operations, Policies and Compliance, Tech Systems, Rhythm of Work, speaker outlines) |
| Scratchpad | Informal working space |

### Databases

| Database | Purpose | Key properties |
|---|---|---|
| 2026 Grant Tracker | Grant applications, LOIs, reports | Submission name, Request type (LOI/Report/New Application/Other), Amount requested, Application closes, Application URL, Status (Not started/In progress/Submitted) |
| Operations-Projects | Ops team project list | Name, Project Status (In Progress/Planned and Upcoming/Completed/Idea), Priority, Assignees, Due Date, Tag |
| Meeting Notes | Ops meeting notes | Title, Meeting Date, Notetaker, Task Writer, Absentees, relation to Cash on Hand entry |
| Open Actions - This Meeting | Action items from meetings | Action, Owner, Due date, Meeting date, Status (Open/Closed) |
| Cash on Hand Database | Weekly cash snapshot per account, with deltas vs. prior entry (formula-heavy — do not edit formula/rollup columns) | Meeting, Meeting Date, account balances, Previous Entry relation |
| Functions Coverage | Coverage plan for development/HR/admin functions | Function, Category, Priority, Interim Coverage, Permanent Owner |
| Open Projects (x2 — confirm which by parent/ID before writing) | Projects spun out of the functions-coverage work | Project, Category, Priority (CRITICAL→Low), Status (Open/Needs owner/In progress/Closed), Source Function relation |
| New-Staff Training Tracker | Onboarding task tracker | Task, Module (0–7), Type, Status, Due, Blocked by/Blocks relations |
| Inspection Items | Master checklist of what gets inspected | Item, Area, Sites, Frequency, Months due, How to Inspect, Active |
| Monthly Inspections | One row per site per month; "Generate Checklist" button creates the result rows | Inspection, Site (Yanonali/Property/Cornerstone/Bethel), Inspection month, Inspector, Status |
| Inspection Results | Individual checklist results for a monthly inspection | Result, Outcome (Unreviewed/Needs follow-up/Pass/Fail/N/A), Checked, Photos, Comments, Follow-up Task relation |
| Facilities Tasks | Facilities to-dos, including inspection follow-ups | Task, Site, Priority, Owner, Status (To do/Doing/Done) |
| Inspections 2026 | Legacy/summary index of inspection runs | Name, Month, Status, Page Link |
| IT Closet Inventory | Hardware inventory by shelf | Item Name, Category, Shelf Location, Status, Quantity |
| Document Hub | Shared document library | Doc name, Category |

## Conventions

- **Meeting notes** are titled with the date, e.g. `2026/08/13 - Operations Meeting`. Each ops meeting note links to a matching Cash on Hand entry (`Ops Meeting - 2026-08-13`) and generates rows in Open Actions.
- **Statuses**: use each database's own status list (shown above). Project priority scale is CRITICAL / High / Medium / Low-Medium / Low where used.
- **New items go where the work lives**: grants → 2026 Grant Tracker; ops projects → Operations-Projects; meeting follow-ups → Open Actions; facilities work → Facilities Tasks; hardware → IT Closet Inventory; shared docs → Document Hub.
- **The inspection system is interlinked** (Items → Monthly Inspections → Results → Facilities Tasks). Add inspection results through the Monthly Inspections "Generate Checklist" flow, not by hand-creating Result rows.

## What NOT to touch

- **Cash on Hand Database formulas/rollups** — the delta and "Prev" columns are computed; only enter the raw account numbers, date, and Previous Entry link on a new row.
- **Inspection Items master list** — edits change every future month's checklist; propose changes, don't apply them unilaterally.
- **New-Staff Training pages and tracker** — a structured onboarding program; read freely, but don't reorganize or mark tasks done on someone else's behalf.
- **Other people's 1:1 notes and the Scratchpad contents** — read only if relevant; never edit.
- **Database schemas** (adding/removing/renaming properties or select options) — always confirm with the database owner first.

## Working pattern for AI-assisted edits

1. Search the workspace for the page/database by name.
2. Retrieve the database and verify its properties before writing.
3. Draft the change and state exactly what will be created or edited.
4. Apply after confirmation; report the page URL of what was changed.
