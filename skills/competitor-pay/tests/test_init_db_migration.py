"""Schema v3: last_run_id, its trigger, and the v2->v3 migration."""
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from init_db import SCHEMA_VERSION, init_database, load_roles  # noqa: E402

ROLES = Path(__file__).parent.parent / "roles" / "roles.json"


def _fresh():
    path = tempfile.mktemp(suffix=".db")
    init_database(path)
    return path


def _cols(conn, table):
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def test_fresh_db_is_v3_with_last_run_id():
    conn = sqlite3.connect(_fresh())
    try:
        version = conn.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()[0]
        assert int(version) == SCHEMA_VERSION == 3
        assert "last_run_id" in _cols(conn, "job_postings")
    finally:
        conn.close()


def test_roles_load_to_sixteen():
    """Chiamaka's guide said 15. It has always been 16, and 'active' is a DB
    column defaulting to 1, not a field in roles.json."""
    path = _fresh()
    load_roles(path, str(ROLES))
    conn = sqlite3.connect(path)
    try:
        assert conn.execute(
            "SELECT count(*) FROM roles WHERE active = 1").fetchone()[0] == 16
    finally:
        conn.close()


def test_trigger_defaults_last_run_id_on_insert():
    """Scrapers do not name last_run_id in their INSERTs; the trigger fills it."""
    conn = sqlite3.connect(_fresh())
    try:
        conn.execute("INSERT INTO search_runs (run_date) VALUES (date('now'))")
        conn.execute(
            "INSERT INTO job_postings (dedup_hash, board, search_run_id, "
            "title, employer) VALUES ('h1','indeed',1,'CM','Org')")
        conn.commit()
        assert conn.execute(
            "SELECT last_run_id FROM job_postings").fetchone()[0] == 1
    finally:
        conn.close()


def _build_v2_db():
    """A database at the old schema, with a posting already in it."""
    path = tempfile.mktemp(suffix=".db")
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE search_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, run_date TEXT);
        CREATE TABLE roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT,
            search_keywords TEXT, active INTEGER DEFAULT 1,
            description_summary TEXT, exclude_keywords TEXT);
        CREATE TABLE job_postings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dedup_hash TEXT UNIQUE NOT NULL, board TEXT, source_url TEXT,
            search_run_id INTEGER, title TEXT, employer TEXT,
            salary_low REAL, salary_high REAL, salary_raw TEXT,
            salary_type TEXT, original_rate_low REAL, original_rate_high REAL,
            sharepoint_item_id TEXT);
        INSERT INTO schema_meta VALUES ('schema_version','2');
        INSERT INTO search_runs (run_date) VALUES (date('now'));
        INSERT INTO job_postings (dedup_hash, board, search_run_id, title,
                                  employer, salary_low)
        VALUES ('old1','indeed',1,'Case Manager','Good Sam',45000);
    """)
    conn.commit()
    conn.close()
    return path


def test_v2_to_v3_migration_adds_and_backfills():
    path = _build_v2_db()
    init_database(path)                      # should migrate, not recreate
    conn = sqlite3.connect(path)
    try:
        assert int(conn.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()[0]) == 3
        assert "last_run_id" in _cols(conn, "job_postings")
        # existing row keeps its data and gets last_run_id = search_run_id
        row = conn.execute(
            "SELECT search_run_id, last_run_id, salary_low FROM job_postings "
            "WHERE dedup_hash='old1'").fetchone()
        assert row == (1, 1, 45000)
    finally:
        conn.close()


def test_migration_is_idempotent():
    path = _build_v2_db()
    init_database(path)
    init_database(path)                      # second run must not blow up
    conn = sqlite3.connect(path)
    try:
        assert conn.execute(
            "SELECT count(*) FROM job_postings").fetchone()[0] == 1
    finally:
        conn.close()
