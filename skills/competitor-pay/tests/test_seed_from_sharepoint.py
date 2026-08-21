"""Tests for seed_from_sharepoint, run against the real 202-item payload."""
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from seed_from_sharepoint import (  # noqa: E402
    build_index, extract_urls, normalize_url, seed,
)

FIXTURE = Path(__file__).parent / "fixtures" / "sharepoint_items.json"


def _load_items():
    with open(FIXTURE) as fh:
        return json.load(fh)["value"]


def _db_with(postings):
    """postings: list of (source_url, title, employer)."""
    path = tempfile.mktemp(suffix=".db")
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE job_postings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dedup_hash TEXT UNIQUE,
            source_url TEXT,
            title TEXT,
            employer TEXT,
            sharepoint_item_id TEXT
        );
    """)
    for i, (url, title, emp) in enumerate(postings):
        conn.execute(
            "INSERT INTO job_postings (dedup_hash, source_url, title, employer)"
            " VALUES (?,?,?,?)", (f"h{i}", url, title, emp))
    conn.commit()
    conn.close()
    return path


# --- url normalisation -------------------------------------------------------

def test_tracking_params_stripped():
    a = normalize_url("https://www.indeed.com/viewjob?jk=abc123"
                      "&utm_campaign=google_jobs_apply&vjs=3")
    b = normalize_url("https://indeed.com/viewjob?jk=abc123")
    assert a == b


def test_different_jobs_stay_distinct():
    assert normalize_url("https://indeed.com/viewjob?jk=aaa") != \
           normalize_url("https://indeed.com/viewjob?jk=bbb")


def test_empty_url_is_none():
    assert normalize_url(None) is None
    assert normalize_url("   ") is None


# --- payload shape -----------------------------------------------------------

def test_jobposting_is_a_dict_not_a_string():
    """The live column returns {'Description':..., 'Url':...}."""
    items = _load_items()
    posting = next(i["fields"]["JobPosting"] for i in items
                   if "JobPosting" in i.get("fields", {}))
    assert isinstance(posting, dict) and "Url" in posting


def test_item_carrying_same_link_twice_indexes_once():
    """Item 211 holds the same URL in both JobPosting and URL."""
    item = {"id": "211", "fields": {
        "JobPosting": {"Url": "https://sbact.org/openings"},
        "URL": "https://sbact.org/openings",
        "Title": "X", "Organization": "Y"}}
    by_url, _, ambiguous = build_index([item])
    assert len(by_url) == 1
    assert ambiguous == 0


def test_real_payload_indexes_cleanly():
    items = _load_items()
    assert len(items) == 202
    by_url, by_name, ambiguous = build_index(items)
    # 7 URLs are claimed by >1 item and must be excluded from matching.
    # Item 211 holds the same link in both JobPosting and URL — one item, so
    # it is deduped rather than counted ambiguous.
    assert (len(by_url), len(by_name), ambiguous) == (133, 173, 7)


# --- seeding -----------------------------------------------------------------

def test_seeds_by_url_from_real_payload():
    items = _load_items()
    target = next(i for i in items
                  if isinstance(i.get("fields", {}).get("JobPosting"), dict))
    url = target["fields"]["JobPosting"]["Url"]
    db = _db_with([(url, "irrelevant title", "irrelevant employer")])

    stats = seed(db, items)
    assert stats["matched_url"] == 1
    conn = sqlite3.connect(db)
    got = conn.execute(
        "SELECT sharepoint_item_id FROM job_postings").fetchone()[0]
    conn.close()
    assert got == str(target["id"])


def test_seeds_by_title_employer_when_no_url():
    items = _load_items()
    target = next(i for i in items if i["fields"].get("Organization"))
    db = _db_with([(None, target["fields"]["Title"],
                    target["fields"]["Organization"])])
    stats = seed(db, items)
    assert stats["matched_name"] == 1


def test_unmatched_posting_is_left_null():
    items = _load_items()
    db = _db_with([("https://example.com/brand-new-posting",
                    "Totally New Role", "Nonexistent Org")])
    stats = seed(db, items)
    assert stats["updates"] == 0
    conn = sqlite3.connect(db)
    assert conn.execute(
        "SELECT sharepoint_item_id FROM job_postings").fetchone()[0] is None
    conn.close()


def test_already_seeded_rows_are_not_retouched():
    items = _load_items()
    db = _db_with([("https://example.com/x", "A", "B")])
    conn = sqlite3.connect(db)
    conn.execute("UPDATE job_postings SET sharepoint_item_id = '999'")
    conn.commit()
    conn.close()
    stats = seed(db, items)
    assert stats["already"] == 1 and stats["updates"] == 0


def test_dry_run_writes_nothing():
    items = _load_items()
    target = next(i for i in items
                  if isinstance(i.get("fields", {}).get("JobPosting"), dict))
    db = _db_with([(target["fields"]["JobPosting"]["Url"], "t", "e")])
    seed(db, items, dry_run=True)
    conn = sqlite3.connect(db)
    assert conn.execute(
        "SELECT sharepoint_item_id FROM job_postings").fetchone()[0] is None
    conn.close()


def test_ambiguous_url_never_matches():
    """A URL shared by several items must not seed any of them.

    smartapply.indeed.com/.../contact-info is carried by items 101, 114 and
    115 — it is a generic application form, not a posting identifier.
    """
    items = _load_items()
    shared = "https://smartapply.indeed.com/beta/indeedapply/form/contact-info"
    db = _db_with([(shared, "Some Role", "Some Org")])
    stats = seed(db, items)
    assert stats["matched_url"] == 0


def test_duplicate_posting_urls_excluded():
    items = _load_items()
    by_url, _, ambiguous = build_index(items)
    assert normalize_url(
        "https://www.indeed.com/viewjob?jk=92fb61034ccfe9e1"
        "&from=shareddesktop_copy") not in by_url
