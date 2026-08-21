"""Tests for report generation."""

import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from report import generate_report


def _create_test_db():
    """Create an in-memory test database with sample data."""
    db_path = tempfile.mktemp(suffix=".db")
    conn = sqlite3.connect(db_path)

    conn.executescript("""
        CREATE TABLE roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            department TEXT,
            sbrm_pay_low REAL,
            sbrm_pay_high REAL,
            pay_type TEXT DEFAULT 'annual',
            classification TEXT DEFAULT 'full-time',
            search_keywords TEXT NOT NULL,
            education_req TEXT,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE search_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_date TEXT DEFAULT (date('now')),
            triggered_by TEXT,
            status TEXT DEFAULT 'running',
            roles_searched INTEGER,
            postings_found INTEGER,
            postings_new INTEGER,
            errors INTEGER,
            started_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT,
            notes TEXT
        );

        CREATE TABLE job_postings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dedup_hash TEXT UNIQUE NOT NULL,
            board TEXT NOT NULL,
            source_url TEXT,
            search_run_id INTEGER,
            title TEXT NOT NULL,
            employer TEXT NOT NULL,
            location_raw TEXT,
            location_bucket TEXT,
            salary_low REAL,
            salary_high REAL,
            salary_raw TEXT,
            salary_type TEXT,
            post_date TEXT,
            employment_type TEXT,
            description_snippet TEXT,
            education_req TEXT,
            sector TEXT,
            matched_role_id INTEGER,
            relevance_score REAL,
            archive_path TEXT,
            first_seen_date TEXT DEFAULT (date('now')),
            last_seen_date TEXT DEFAULT (date('now')),
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE search_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            search_run_id INTEGER,
            role_id INTEGER,
            board TEXT,
            keyword_used TEXT,
            results_count INTEGER,
            error TEXT,
            searched_at TEXT DEFAULT (datetime('now'))
        );

        INSERT INTO roles (title, department, sbrm_pay_low, sbrm_pay_high, search_keywords)
        VALUES ('Case Manager', 'Programs', 45000, 55000, '["case manager"]');

        INSERT INTO search_runs (run_date, triggered_by, status)
        VALUES (date('now'), 'test', 'completed');

        INSERT INTO job_postings (dedup_hash, board, title, employer, location_bucket,
                                  salary_low, salary_high, salary_raw, salary_type,
                                  search_run_id, matched_role_id)
        VALUES
            ('hash1', 'indeed', 'Case Manager', 'Good Sam', 'Santa Barbara County',
             45000, 55000, '$45,000 - $55,000', 'annual', 1, 1),
            ('hash2', 'indeed', 'Case Manager', 'County SB', 'Santa Barbara County',
             50000, 65000, '$50,000 - $65,000', 'annual', 1, 1),
            ('hash3', 'linkedin', 'Case Manager', 'PATH', 'Other California',
             NULL, NULL, NULL, 'not_listed', 1, 1);

        INSERT INTO search_log (search_run_id, role_id, board, keyword_used, results_count)
        VALUES (1, 1, 'indeed', 'case manager', 2),
               (1, 1, 'linkedin', 'case manager', 1);
    """)
    conn.close()
    return db_path


def test_generate_report():
    """Generate a report from test data."""
    db_path = _create_test_db()
    report = generate_report(db_path)

    assert "Competitor Pay Report" in report
    assert "Board Summary" in report
    assert "Indeed" in report
    assert "Market Data by Role" in report
    assert "Case Manager" in report
    assert "Location Distribution" in report
    assert "Top Employers" in report

    # Clean up
    Path(db_path).unlink()


def test_generate_report_empty_db():
    """Handle empty database."""
    db_path = tempfile.mktemp(suffix=".db")
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE search_runs (
            id INTEGER PRIMARY KEY, run_date TEXT, triggered_by TEXT,
            status TEXT, roles_searched INTEGER, postings_found INTEGER,
            postings_new INTEGER, errors INTEGER, started_at TEXT,
            completed_at TEXT, notes TEXT
        );
    """)
    conn.close()

    report = generate_report(db_path)
    assert "No search runs found" in report

    Path(db_path).unlink()


def test_generate_report_with_null_high():
    """A posting with a low but no high must not crash the report.

    46 of the 202 rows on the live SharePoint list carry a null High, so this
    is the normal case, not an edge case. v0.2.0 raised:
    TypeError: unsupported format string passed to NoneType.__format__
    """
    db_path = _create_test_db()
    conn = sqlite3.connect(db_path)
    conn.execute("""
        INSERT INTO job_postings (dedup_hash, board, title, employer,
                                  location_bucket, salary_low, salary_high,
                                  salary_raw, salary_type, search_run_id,
                                  matched_role_id)
        VALUES ('hash-nullhigh', 'indeed', 'Case Manager', 'Transition House',
                'Santa Barbara County', 48000, NULL, 'From $48,000', 'annual',
                1, 1)
    """)
    conn.commit()
    conn.close()

    report = generate_report(db_path)          # must not raise
    assert "Case Manager" in report
    assert "Market Data by Role" in report


def test_generate_report_all_highs_null():
    """Every salaried posting missing a high — MAX() returns NULL outright."""
    db_path = _create_test_db()
    conn = sqlite3.connect(db_path)
    conn.execute("UPDATE job_postings SET salary_high = NULL")
    conn.commit()
    conn.close()

    report = generate_report(db_path)          # must not raise
    assert "Market Data by Role" in report
