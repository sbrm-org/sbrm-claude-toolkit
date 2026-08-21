"""Initialize and migrate the competitor pay SQLite database."""

import json
import sqlite3
import sys
from pathlib import Path

SCHEMA_VERSION = 3

SCHEMA_SQL = """
-- SBRM roles being benchmarked
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    department TEXT,
    sbrm_pay_low REAL,
    sbrm_pay_high REAL,
    pay_type TEXT DEFAULT 'annual',
    classification TEXT DEFAULT 'full-time',
    search_keywords TEXT NOT NULL,
    education_req TEXT,
    description_summary TEXT,
    exclude_keywords TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Individual search runs
CREATE TABLE IF NOT EXISTS search_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date TEXT NOT NULL,
    triggered_by TEXT DEFAULT 'manual',
    status TEXT DEFAULT 'running',
    roles_searched INTEGER DEFAULT 0,
    boards_searched INTEGER DEFAULT 0,
    postings_found INTEGER DEFAULT 0,
    postings_new INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    notes TEXT
);

-- Job postings found
CREATE TABLE IF NOT EXISTS job_postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_hash TEXT UNIQUE NOT NULL,
    board TEXT NOT NULL,
    source_url TEXT,
    search_run_id INTEGER REFERENCES search_runs(id),
    last_run_id INTEGER REFERENCES search_runs(id),
    title TEXT NOT NULL,
    employer TEXT NOT NULL,
    location_raw TEXT,
    location_bucket TEXT,
    salary_low REAL,
    salary_high REAL,
    salary_raw TEXT,
    salary_type TEXT,
    original_rate_low REAL,
    original_rate_high REAL,
    post_date TEXT,
    employment_type TEXT,
    description_snippet TEXT,
    education_req TEXT,
    sector TEXT DEFAULT 'unknown',
    matched_role_id INTEGER REFERENCES roles(id),
    relevance_score REAL,
    sharepoint_item_id TEXT,
    archive_path TEXT,
    first_seen_date TEXT DEFAULT (date('now')),
    last_seen_date TEXT DEFAULT (date('now')),
    created_at TEXT DEFAULT (datetime('now'))
);

-- A new posting's first sighting is also its most recent one. Enforced here so
-- every scraper gets it right without repeating the column in five INSERTs.
CREATE TRIGGER IF NOT EXISTS trg_postings_last_run_default
AFTER INSERT ON job_postings
WHEN NEW.last_run_id IS NULL
BEGIN
    UPDATE job_postings SET last_run_id = NEW.search_run_id WHERE id = NEW.id;
END;

-- Checkpoint/resume tracking
CREATE TABLE IF NOT EXISTS search_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_run_id INTEGER REFERENCES search_runs(id),
    role_id INTEGER REFERENCES roles(id),
    board TEXT NOT NULL,
    keyword_used TEXT NOT NULL,
    results_count INTEGER DEFAULT 0,
    error TEXT,
    searched_at TEXT DEFAULT (datetime('now'))
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_postings_role ON job_postings(matched_role_id);
CREATE INDEX IF NOT EXISTS idx_postings_board ON job_postings(board);
CREATE INDEX IF NOT EXISTS idx_postings_bucket ON job_postings(location_bucket);
CREATE INDEX IF NOT EXISTS idx_postings_run ON job_postings(search_run_id);
CREATE INDEX IF NOT EXISTS idx_postings_dedup ON job_postings(dedup_hash);
CREATE INDEX IF NOT EXISTS idx_search_log_run ON search_log(search_run_id, role_id, board);
"""


def _get_schema_version(conn: sqlite3.Connection) -> int:
    """Get current schema version, or 0 if no DB exists yet."""
    try:
        row = conn.execute(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'"
        ).fetchone()
        return int(row[0]) if row else 0
    except sqlite3.OperationalError:
        return 0


def _migrate_v1_to_v2(conn: sqlite3.Connection) -> None:
    """Migrate schema from v1 to v2.

    Adds: roles.description_summary, roles.exclude_keywords,
          job_postings.original_rate_low, job_postings.original_rate_high,
          job_postings.sharepoint_item_id
    """
    # Check which columns already exist (idempotent)
    role_cols = {row[1] for row in conn.execute("PRAGMA table_info(roles)")}
    posting_cols = {row[1] for row in conn.execute("PRAGMA table_info(job_postings)")}

    if "description_summary" not in role_cols:
        conn.execute("ALTER TABLE roles ADD COLUMN description_summary TEXT")
    if "exclude_keywords" not in role_cols:
        conn.execute("ALTER TABLE roles ADD COLUMN exclude_keywords TEXT")
    if "original_rate_low" not in posting_cols:
        conn.execute("ALTER TABLE job_postings ADD COLUMN original_rate_low REAL")
    if "original_rate_high" not in posting_cols:
        conn.execute("ALTER TABLE job_postings ADD COLUMN original_rate_high REAL")
    if "sharepoint_item_id" not in posting_cols:
        conn.execute("ALTER TABLE job_postings ADD COLUMN sharepoint_item_id TEXT")

    # Backfill original rates from salary_raw for existing postings
    _backfill_original_rates(conn)

    conn.execute(
        "UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'"
    )
    conn.commit()
    print("Migrated database schema v1 → v2")


def _migrate_v2_to_v3(conn: sqlite3.Connection) -> None:
    """Migrate schema from v2 to v3.

    Adds job_postings.last_run_id. Before this, a posting seen again on a later
    run had its search_run_id overwritten, which silently removed it from every
    earlier run's report (report.py and export_csv.py both filter on
    search_run_id). search_run_id is now first-seen and never moves; last_run_id
    tracks the most recent sighting.
    """
    posting_cols = {row[1] for row in conn.execute("PRAGMA table_info(job_postings)")}
    if "last_run_id" not in posting_cols:
        conn.execute("ALTER TABLE job_postings ADD COLUMN last_run_id INTEGER")
        # Existing rows: the run we know about is both first and last sighting.
        conn.execute("UPDATE job_postings SET last_run_id = search_run_id "
                     "WHERE last_run_id IS NULL")

    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS trg_postings_last_run_default
        AFTER INSERT ON job_postings
        WHEN NEW.last_run_id IS NULL
        BEGIN
            UPDATE job_postings SET last_run_id = NEW.search_run_id
            WHERE id = NEW.id;
        END;
    """)
    conn.execute(
        "UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'"
    )
    conn.commit()
    print("Migrated database schema v2 → v3")


def _backfill_original_rates(conn: sqlite3.Connection) -> None:
    """Re-parse salary_raw for existing postings to populate original rates."""
    # Import here to avoid circular imports at module level
    sys.path.insert(0, str(Path(__file__).parent))
    from extract_salary import normalize_salary

    rows = conn.execute(
        "SELECT id, salary_raw FROM job_postings "
        "WHERE salary_raw IS NOT NULL AND original_rate_low IS NULL"
    ).fetchall()

    for row_id, salary_raw in rows:
        result = normalize_salary(salary_raw)
        original_low = result[3] if len(result) > 3 else None
        original_high = result[4] if len(result) > 4 else None
        if original_low is not None:
            conn.execute(
                "UPDATE job_postings SET original_rate_low = ?, original_rate_high = ? "
                "WHERE id = ?",
                (original_low, original_high, row_id),
            )

    if rows:
        print(f"Backfilled original rates for {len(rows)} existing postings")


def init_database(db_path: str) -> None:
    """Create or migrate the database schema."""
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(path))
    try:
        current_version = _get_schema_version(conn)

        if current_version == 0:
            # Fresh database — create everything
            conn.executescript(SCHEMA_SQL)
            conn.execute(
                "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
                ("schema_version", str(SCHEMA_VERSION)),
            )
            conn.commit()
            print(f"Database initialized at {path} (schema v{SCHEMA_VERSION})")
        elif current_version < SCHEMA_VERSION:
            # Run migrations
            if current_version < 2:
                _migrate_v1_to_v2(conn)
            if current_version < 3:
                _migrate_v2_to_v3(conn)
            print(f"Database at {path} is now schema v{SCHEMA_VERSION}")
        else:
            print(f"Database at {path} already at schema v{SCHEMA_VERSION}")
    finally:
        conn.close()


def load_roles(db_path: str, roles_file: str) -> int:
    """Load roles from roles.json into the database.

    Strategy: deactivate all existing roles, then upsert new ones by title.
    Old role IDs remain valid for historical postings.

    Returns:
        Number of roles loaded.
    """
    with open(roles_file) as f:
        data = json.load(f)

    roles = data.get("roles", [])
    if not roles:
        print("No roles found in roles.json")
        return 0

    conn = sqlite3.connect(db_path)
    count = 0
    try:
        # Deactivate all existing roles
        conn.execute("UPDATE roles SET active = 0, updated_at = datetime('now')")

        for role in roles:
            keywords_json = json.dumps(role.get("search_keywords", []))
            exclude_json = json.dumps(role.get("exclude_keywords", [])) if role.get("exclude_keywords") else None

            # Try to find existing role by title
            existing = conn.execute(
                "SELECT id FROM roles WHERE title = ?", (role["title"],)
            ).fetchone()

            if existing:
                # Update existing role
                conn.execute("""
                    UPDATE roles SET
                        department = ?,
                        classification = ?,
                        search_keywords = ?,
                        education_req = ?,
                        description_summary = ?,
                        exclude_keywords = ?,
                        active = 1,
                        updated_at = datetime('now')
                    WHERE id = ?
                """, (
                    role.get("department"),
                    role.get("classification", "full-time"),
                    keywords_json,
                    role.get("education"),
                    role.get("description_summary"),
                    exclude_json,
                    existing[0],
                ))
            else:
                # Insert new role
                conn.execute("""
                    INSERT INTO roles (title, department, classification,
                                       search_keywords, education_req,
                                       description_summary, exclude_keywords,
                                       active)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                """, (
                    role["title"],
                    role.get("department"),
                    role.get("classification", "full-time"),
                    keywords_json,
                    role.get("education"),
                    role.get("description_summary"),
                    exclude_json,
                ))
            count += 1

        conn.commit()
        print(f"Loaded {count} roles into database ({count} active, old roles deactivated)")
    finally:
        conn.close()

    return count


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Initialize competitor pay database")
    parser.add_argument("--db", default=None, help="Path to SQLite database")
    parser.add_argument("--data-dir", default=None, help="Data directory")
    parser.add_argument("--load-roles", default=None, help="Path to roles.json")
    args = parser.parse_args()

    # Determine DB path
    if args.db:
        db = args.db
    elif args.data_dir:
        db = str(Path(args.data_dir) / "comp_research.db")
    else:
        db = str(Path(__file__).parent.parent / "data" / "comp_research.db")

    init_database(db)

    if args.load_roles:
        load_roles(db, args.load_roles)
