"""P1 #6: a second board must not destroy the first board's data.

The old ON CONFLICT clause reassigned search_run_id (removing the posting from
every earlier run's report) and let a later, salary-less sighting overwrite a
salary that was already recorded.
"""
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from init_db import init_database  # noqa: E402
from search_indeed import store_results  # noqa: E402


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


def _posting(**over):
    base = {
        "title": "Case Manager",
        "employer": "Good Samaritan",
        "location_raw": "Santa Barbara, CA",
        "salary_raw": "$45,000 - $55,000 a year",
        "source_url": "https://indeed.com/viewjob?jk=aaa",
    }
    base.update(over)
    return base


def _row(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return dict(conn.execute("SELECT * FROM job_postings").fetchone())
    finally:
        conn.close()


def test_second_sighting_keeps_original_run_id():
    path = _db()
    store_results(path, [_posting()], role_id=1, run_id=1)
    store_results(path, [_posting()], role_id=1, run_id=2)
    row = _row(path)
    assert row["search_run_id"] == 1, "first-seen run must not move"
    assert row["last_run_id"] == 2, "latest sighting must be tracked"


def test_salaryless_resighting_does_not_erase_salary():
    path = _db()
    store_results(path, [_posting()], role_id=1, run_id=1)
    before = _row(path)
    assert before["salary_low"] == 45000

    # same posting, seen again with no salary listed
    store_results(path, [_posting(salary_raw=None)], role_id=1, run_id=2)
    after = _row(path)
    assert after["salary_low"] == 45000, "salary was destroyed by re-sighting"
    assert after["salary_high"] == 55000
    assert after["salary_raw"] == "$45,000 - $55,000 a year"


def test_resighting_fills_a_previously_missing_salary():
    """Gap-filling must still work in the direction that adds information."""
    path = _db()
    store_results(path, [_posting(salary_raw=None)], role_id=1, run_id=1)
    assert _row(path)["salary_low"] is None
    store_results(path, [_posting()], role_id=1, run_id=2)
    assert _row(path)["salary_low"] == 45000


def test_only_one_row_exists_after_resighting():
    path = _db()
    store_results(path, [_posting()], role_id=1, run_id=1)
    store_results(path, [_posting()], role_id=1, run_id=2)
    conn = sqlite3.connect(path)
    try:
        assert conn.execute(
            "SELECT count(*) FROM job_postings").fetchone()[0] == 1
    finally:
        conn.close()
