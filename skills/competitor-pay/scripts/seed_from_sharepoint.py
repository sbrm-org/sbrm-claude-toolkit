#!/usr/bin/env python3
"""Seed local postings with the SharePoint item IDs that already exist.

Why this exists
---------------
Dedup against SharePoint keys on job_postings.sharepoint_item_id. Nothing else
in the skill ever reads the list, so a fresh database believes SharePoint is
empty and re-pushes every still-live posting on top of the rows already there.
This script is what makes the first push safe. Run it before any push against a
database that has not been seeded.

Usage:
    # fetch live (default)
    python3 seed_from_sharepoint.py --db data/comp_research.db

    # or seed from a previously saved payload
    python3 seed_from_sharepoint.py --db data/comp_research.db --from-file items.json

Matching, in priority order:
    1. the Job Posting hyperlink (hand-entered, ~150 rows)
    2. the URL column (where this skill's own writes land)
    3. title + employer, normalised

Exit status is non-zero if the list looks empty or unreachable — a zero-item
seed means auth or the list ID is wrong, and continuing would duplicate the
whole list.
"""

import argparse
import json
import re
import sqlite3
import subprocess
import sys
from urllib.parse import urlsplit, parse_qsl, urlencode, urlunsplit

import sharepoint_target
DEFAULT_ACCOUNT = "sbrmappadmin@sbrm.org"

# Query params that identify a posting; everything else is tracking noise.
MEANINGFUL_QUERY_KEYS = {"jk", "vjk", "currentjobid", "jobid", "id", "postingid"}

TRACKING_PREFIXES = ("utm_", "from", "advn", "vjs", "tk", "alid", "rq", "xkcb")


def _fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def ms365(*args):
    """Run the ms365 wrapper.

    The wrapper writes audit JSON to stderr, so only stdout is parsed. It also
    exits 0 and puts auth/Graph failures in the payload — treating that as data
    is how an expired token turns into "the list is empty", which would be read
    as "nothing to seed" and duplicate all 202 rows. Refuse it loudly instead.
    """
    proc = subprocess.run(["ms365", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        _fail(f"ms365 {args[0]} exited {proc.returncode}: {proc.stderr[-400:]}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        _fail(f"ms365 {args[0]} returned non-JSON: {proc.stdout[:300]}")
    if isinstance(data, dict) and "error" in data:
        _fail(f"ms365 {args[0]} failed: {data['error']}\n"
              f"If this mentions a token, re-authenticate with: ms365 login")
    return data


def fetch_items(site_id, list_id, account):
    return ms365(
        "list-sharepoint-site-list-items",
        "--site-id", site_id,
        "--list-id", list_id,
        "--expand", '["fields"]',
        "--fetch-all-pages",
        "--top", "100",
        "--account", account,
    )


def normalize_url(url):
    """Reduce a posting URL to something comparable across runs.

    Job boards decorate the same posting with per-visit tracking parameters, so
    a raw string compare would miss rows the skill itself wrote last month.
    """
    if not url:
        return None
    url = url.strip()
    if not url:
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None

    host = (parts.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]

    keep = []
    for key, val in parse_qsl(parts.query, keep_blank_values=False):
        lower = key.lower()
        if lower in MEANINGFUL_QUERY_KEYS:
            keep.append((lower, val))
        elif any(lower.startswith(p) for p in TRACKING_PREFIXES):
            continue
    keep.sort()

    path = (parts.path or "").rstrip("/")
    return urlunsplit(("", host, path, urlencode(keep), ""))


def _norm_text(value):
    if not value:
        return ""
    value = re.sub(r"[^\w\s-]", " ", str(value).lower())
    return re.sub(r"\s+", " ", value).strip()


def _norm_employer(value):
    text = _norm_text(value)
    text = re.sub(r"\b(inc|llc|ltd|corp|corporation|company|co|group|org)\b",
                  " ", text)
    text = re.sub(r"\bthe\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def extract_urls(fields):
    """Every URL an item carries. One item can hold the same link twice."""
    urls = []
    posting = fields.get("JobPosting")
    if isinstance(posting, dict):
        urls.append(posting.get("Url") or posting.get("url"))
    elif isinstance(posting, str):
        urls.append(posting)
    plain = fields.get("URL")
    if isinstance(plain, str):
        urls.append(plain)
    return [u for u in (normalize_url(u) for u in urls) if u]


def build_index(items):
    """Map normalised URL -> item id, and (title, employer) -> item id."""
    url_owners = {}
    by_name = {}
    for item in items:
        fields = item.get("fields") or {}
        item_id = str(item.get("id") or fields.get("id") or "").strip()
        if not item_id:
            continue
        for url in extract_urls(fields):
            url_owners.setdefault(url, set()).add(item_id)
        key = (_norm_text(fields.get("Title")),
               _norm_employer(fields.get("Organization")))
        if key != ("", ""):
            by_name.setdefault(key, item_id)

    # A URL claimed by more than one item cannot identify a row. The live list
    # has both causes: the same posting entered twice (84/85, 134/135), and
    # generic application-form URLs shared by unrelated jobs
    # (smartapply.indeed.com/.../contact-info covers 101, 114 and 115).
    # Matching on those would seed a posting to the wrong row and then push an
    # update over it. Drop them and let title+employer decide instead.
    by_url = {u: next(iter(ids)) for u, ids in url_owners.items()
              if len(ids) == 1}
    ambiguous = sum(1 for ids in url_owners.values() if len(ids) > 1)
    return by_url, by_name, ambiguous


def seed(db_path, items, dry_run=False):
    by_url, by_name, ambiguous = build_index(items)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, source_url, title, employer, sharepoint_item_id "
            "FROM job_postings"
        ).fetchall()

        matched_url = matched_name = already = 0
        updates = []
        for row in rows:
            if row["sharepoint_item_id"]:
                already += 1
                continue
            item_id = by_url.get(normalize_url(row["source_url"]))
            if item_id:
                matched_url += 1
            else:
                item_id = by_name.get((_norm_text(row["title"]),
                                       _norm_employer(row["employer"])))
                if item_id:
                    matched_name += 1
            if item_id:
                updates.append((item_id, row["id"]))

        if updates and not dry_run:
            conn.executemany(
                "UPDATE job_postings SET sharepoint_item_id = ? WHERE id = ?",
                updates,
            )
            conn.commit()
    finally:
        conn.close()

    return {
        "items": len(items),
        "local": len(rows),
        "matched_url": matched_url,
        "matched_name": matched_name,
        "already": already,
        "updates": len(updates),
        "ambiguous_urls": ambiguous,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--from-file",
                    help="read a saved list payload instead of fetching")
    ap.add_argument("--site-id", default=None)
    ap.add_argument("--list-id", default=None)
    ap.add_argument("--account", default=DEFAULT_ACCOUNT)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-empty", action="store_true",
                    help="do not fail when the list returns zero items")
    args = ap.parse_args()

    if args.from_file:
        with open(args.from_file) as fh:
            payload = json.load(fh)
    else:
        payload = fetch_items(args.site_id, args.list_id, args.account)

    items = payload.get("value") if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        _fail("unexpected payload shape: no 'value' list found")

    if not items and not args.allow_empty:
        _fail("SharePoint returned zero items. That almost always means the "
              "login expired or the list ID is wrong — it does not mean the "
              "list is empty. Pushing now would duplicate every row. "
              "Re-authenticate with 'ms365 login' and try again.")

    stats = seed(args.db, items, dry_run=args.dry_run)

    prefix = "DRY-RUN: would seed" if args.dry_run else "Seeded"
    print(f"{prefix} {stats['items']} existing SharePoint items; "
          f"{stats['updates']} matched to local postings "
          f"({stats['matched_url']} by URL, {stats['matched_name']} by "
          f"title+employer).")
    if stats["already"]:
        print(f"  {stats['already']} local postings were already seeded.")
    unmatched = stats["local"] - stats["updates"] - stats["already"]
    if unmatched > 0:
        print(f"  {unmatched} local postings had no SharePoint match "
              f"(these are genuinely new and will be pushed).")
    if stats["ambiguous_urls"]:
        print(f"  note: {stats['ambiguous_urls']} URLs are claimed by more "
              f"than one list item and were ignored for matching.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
