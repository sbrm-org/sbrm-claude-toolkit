"""Tests for the org career-page scraper."""
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from init_db import init_database  # noqa: E402
from search_org_website import (  # noqa: E402
    log_search, parse_org_results, store_results,
)


def _db():
    path = tempfile.mktemp(suffix=".db")
    init_database(path)
    conn = sqlite3.connect(path)
    conn.execute("INSERT INTO roles (title, search_keywords) "
                 "VALUES ('Case Manager', '[\"case manager\"]')")
    conn.execute("INSERT INTO search_runs (run_date) VALUES (date('now'))")
    conn.execute("INSERT INTO search_runs (run_date) VALUES (date('now'))")
    conn.commit()
    conn.close()
    return path


# --- parsing -----------------------------------------------------------------

def test_parses_json_results_key():
    raw = json.dumps({"results": [
        {"title": "Case Manager", "employer": "Good Samaritan",
         "location": "Santa Barbara, CA", "pay": "$25 an hour",
         "url": "https://goodsamaritanshelter.org/jobs/1"}]})
    out = parse_org_results(raw)
    assert len(out) == 1
    assert out[0]["title"] == "Case Manager"
    assert out[0]["location_raw"] == "Santa Barbara, CA"
    assert out[0]["salary_raw"] == "$25 an hour"
    assert out[0]["source_url"].endswith("/jobs/1")


def test_parses_bare_json_list():
    raw = json.dumps([{"title": "Custodian", "organization": "CADA"}])
    out = parse_org_results(raw)
    assert out[0]["employer"] == "CADA"


def test_parses_block_format():
    raw = """
**Job Title:** Program Director
**Organization:** Transition House
**Location:** Santa Barbara, CA
**Salary:** $85,000 - $95,000 a year

**Job Title:** Custodian
**Organization:** CADA
**Pay:** $20/hr
"""
    out = parse_org_results(raw)
    assert len(out) == 2
    assert out[0]["title"] == "Program Director"
    assert out[1]["salary_raw"] == "$20/hr"


def test_empty_input_is_empty_list():
    assert parse_org_results("") == []
    assert parse_org_results("   \n ") == []


def test_malformed_json_falls_back_without_crashing():
    assert parse_org_results("{not valid json") == []


def test_entries_without_title_are_dropped():
    raw = json.dumps({"results": [{"employer": "CADA"},
                                  {"title": "Custodian", "employer": "CADA"}]})
    assert len(parse_org_results(raw)) == 1


# --- storing -----------------------------------------------------------------

def test_stores_with_org_website_board():
    path = _db()
    stats = store_results(path, parse_org_results(json.dumps({"results": [
        {"title": "Case Manager", "employer": "Good Samaritan",
         "location": "Santa Barbara, CA", "pay": "$25 an hour"}]})),
        role_id=1, run_id=1)
    assert stats["stored"] == 1
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM job_postings").fetchone()
        assert row["board"] == "org_website"
        assert row["original_rate_low"] == 25.0
        assert row["salary_type"] == "hourly"
        assert row["last_run_id"] == 1
    finally:
        conn.close()


def test_missing_employer_is_skipped_not_stored():
    path = _db()
    stats = store_results(path, [{"title": "Case Manager"}],
                          role_id=1, run_id=1)
    assert stats == {"stored": 0, "updated": 0, "skipped": 1, "errors": 0}


def test_resighting_counts_as_updated_not_stored():
    """The board scrapers report every upsert as 'stored', overstating new
    finds, because their IntegrityError branch is unreachable."""
    path = _db()
    rec = [{"title": "Case Manager", "employer": "Good Samaritan",
            "location_raw": "Santa Barbara, CA", "salary_raw": "$25 an hour"}]
    first = store_results(path, rec, role_id=1, run_id=1)
    second = store_results(path, rec, role_id=1, run_id=2)
    assert (first["stored"], first["updated"]) == (1, 0)
    assert (second["stored"], second["updated"]) == (0, 1)
    conn = sqlite3.connect(path)
    try:
        assert conn.execute(
            "SELECT count(*) FROM job_postings").fetchone()[0] == 1
        assert conn.execute(
            "SELECT search_run_id, last_run_id FROM job_postings"
        ).fetchone() == (1, 2)
    finally:
        conn.close()


def test_log_search_records_the_attempt():
    path = _db()
    log_search(path, run_id=1, role_id=1, org="CADA", count=3)
    conn = sqlite3.connect(path)
    try:
        row = conn.execute(
            "SELECT board, keyword_used, results_count FROM search_log"
        ).fetchone()
        assert row == ("org_website", "CADA", 3)
    finally:
        conn.close()
