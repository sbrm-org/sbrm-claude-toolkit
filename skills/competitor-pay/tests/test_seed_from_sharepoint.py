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


def _db_with(postings, legacy=False):
    """postings: list of (source_url, title, employer[, rate_low, rate_high]).

    legacy=True omits the original_rate columns, standing in for a database
    that predates the init_db migration.
    """
    path = tempfile.mktemp(suffix=".db")
    conn = sqlite3.connect(path)
    pay_cols = "" if legacy else """,
            original_rate_low REAL,
            original_rate_high REAL"""
    conn.executescript(f"""
        CREATE TABLE job_postings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dedup_hash TEXT UNIQUE,
            source_url TEXT,
            title TEXT,
            employer TEXT,
            sharepoint_item_id TEXT{pay_cols}
        );
    """)
    for i, posting in enumerate(postings):
        url, title, emp = posting[:3]
        lo, hi = (posting + (None, None))[3:5] if len(posting) > 3 \
            else (None, None)
        if legacy:
            conn.execute(
                "INSERT INTO job_postings (dedup_hash, source_url, title,"
                " employer) VALUES (?,?,?,?)", (f"h{i}", url, title, emp))
        else:
            conn.execute(
                "INSERT INTO job_postings (dedup_hash, source_url, title,"
                " employer, original_rate_low, original_rate_high)"
                " VALUES (?,?,?,?,?,?)", (f"h{i}", url, title, emp, lo, hi))
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
    idx = build_index([item])
    assert len(idx.by_url) == 1
    assert idx.ambiguous == 0


def test_real_payload_indexes_cleanly():
    items = _load_items()
    assert len(items) == 202
    idx = build_index(items)
    # 7 URLs are claimed by >1 item and must be excluded from matching.
    # Item 211 holds the same link in both JobPosting and URL — one item, so
    # it is deduped rather than counted ambiguous.
    assert (len(idx.by_url), len(idx.by_name), idx.ambiguous) == (133, 173, 7)
    # Every named row on the live list carries a Low/Only figure, so the
    # pay-aware index is never sparser than the name index.
    assert len(idx.by_name_pay) >= len(idx.by_name)


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


def test_seeds_by_title_employer_when_no_url_and_no_pay():
    """A local row with no pay figure still collapses onto the older item."""
    items = _load_items()
    target = next(i for i in items if i["fields"].get("Organization"))
    db = _db_with([(None, target["fields"]["Title"],
                    target["fields"]["Organization"], None, None)])
    stats = seed(db, items)
    assert stats["matched_name"] == 1 and stats["matched_pay"] == 0


# --- reposts -----------------------------------------------------------------

def _cada():
    """One list item standing in for CADA Clinic Monitor, item 133."""
    return [{"id": "133", "fields": {
        "Title": "Clinic Monitor", "Organization": "CADA",
        "Low_x002f_Only": 19, "High": 22, "PayUnit": "Hourly",
        "JobPosting": {"Url": "https://indeed.com/viewjob?jk=april"}}}]


def _stamp_of(db):
    conn = sqlite3.connect(db)
    got = conn.execute("SELECT sharepoint_item_id FROM job_postings").fetchone()
    conn.close()
    return got[0]


def test_repost_at_same_pay_collapses():
    db = _db_with([(None, "Clinic Monitor", "CADA", 19, 22)])
    stats = seed(db, _cada())
    assert stats["matched_pay"] == 1 and _stamp_of(db) == "133"
    assert stats["wage_moves"] == []


def test_repost_at_changed_pay_is_left_for_the_push():
    """The whole point: a competitor moving its wage must survive to be pushed."""
    db = _db_with([(None, "Clinic Monitor", "CADA", 21, 24)])
    stats = seed(db, _cada())
    assert stats["updates"] == 0 and _stamp_of(db) is None
    assert len(stats["wage_moves"]) == 1
    move = stats["wage_moves"][0]
    assert move["employer"] == "CADA"
    assert move["known"] == [("133", "19.00", "22.00")]


def test_annualized_pay_is_not_compared_against_the_list():
    """SharePoint holds the original rate. 19/hr on the list is 39520 locally.

    Comparing the annualized figure would make every unchanged hourly repost
    look like a wage move and re-push it, which is worse than the bug this
    fallback exists to fix.
    """
    db = _db_with([(None, "Clinic Monitor", "CADA", 19, 22)])
    conn = sqlite3.connect(db)
    conn.execute("ALTER TABLE job_postings ADD COLUMN salary_low REAL")
    conn.execute("ALTER TABLE job_postings ADD COLUMN salary_high REAL")
    conn.execute("UPDATE job_postings SET salary_low = 39520, "
                 "salary_high = 45760")
    conn.commit()
    conn.close()
    stats = seed(db, _cada())
    assert stats["matched_pay"] == 1 and stats["wage_moves"] == []


def test_url_match_beats_a_pay_difference():
    """The URL is the strongest signal; a changed rate on the same URL is an
    edit to the posting we already hold, not a new observation."""
    db = _db_with([("https://indeed.com/viewjob?jk=april&utm_source=x",
                    "Clinic Monitor", "CADA", 99, 99)])
    stats = seed(db, _cada())
    assert stats["matched_url"] == 1 and _stamp_of(db) == "133"


def test_half_open_ranges_still_match():
    """46 of the 202 live items carry Low/Only with High null. A flat "$20/hr"
    posting yields 20/20 locally and must not read as a wage move."""
    items = [{"id": "500", "fields": {
        "Title": "Program Support", "Organization": "Example Org",
        "Low_x002f_Only": 20, "High": None}}]
    db = _db_with([(None, "Program Support", "Example Org", 20, 20)])
    stats = seed(db, items)
    assert stats["matched_pay"] == 1 and stats["wage_moves"] == []


def test_zero_is_treated_as_no_figure():
    items = [{"id": "501", "fields": {
        "Title": "Volunteer Coordinator", "Organization": "Example Org",
        "Low_x002f_Only": 0, "High": 0}}]
    db = _db_with([(None, "Volunteer Coordinator", "Example Org", None, None)])
    stats = seed(db, items)
    assert stats["matched_name"] == 1


def test_string_pay_from_sharepoint_compares_equal():
    items = [{"id": "502", "fields": {
        "Title": "Cook", "Organization": "Example Org",
        "Low_x002f_Only": "$19.00", "High": "$22.00"}}]
    db = _db_with([(None, "Cook", "Example Org", 19.0, 22.0)])
    stats = seed(db, items)
    assert stats["matched_pay"] == 1


def test_new_job_at_a_known_employer_is_not_a_wage_move():
    db = _db_with([(None, "Night Monitor", "CADA", 20, 23)])
    stats = seed(db, _cada())
    assert stats["updates"] == 0 and stats["wage_moves"] == []


def test_legacy_db_without_rate_columns_degrades_safely():
    """A database that predates the migration keeps the 1.2.1 behaviour and
    says so, rather than reaching for the annualized column."""
    db = _db_with([(None, "Clinic Monitor", "CADA")], legacy=True)
    stats = seed(db, _cada())
    assert stats["pay_aware"] is False
    assert stats["matched_name"] == 1 and _stamp_of(db) == "133"


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
    idx = build_index(items)
    assert normalize_url(
        "https://www.indeed.com/viewjob?jk=92fb61034ccfe9e1"
        "&from=shareddesktop_copy") not in idx.by_url
