"""Parse Indeed MCP results and store in SQLite.

Called by Claude after it calls the Indeed MCP tool. Claude passes
the structured data as JSON via stdin or --data argument.

Usage:
    echo '{"results": [...]}' | python3 search_indeed.py --store --role-id 1 --run-id 1 --db path/to/db
"""

import json
import sqlite3
import sys
from pathlib import Path

# Add scripts dir to path for local imports
sys.path.insert(0, str(Path(__file__).parent))

from extract_salary import normalize_salary
from location_bucket import bucket_location
from dedupe import make_dedup_hash


def parse_indeed_mcp_response(mcp_text: str) -> list[dict]:
    """Parse the markdown response from Indeed MCP into structured records.

    The MCP returns markdown blocks like:
        **Job Title:** Case Manager
        **Company:** Good Samaritan
        **Location:** Santa Barbara, CA
        **Compensation:** $26 - $31 an hour
        **Job Type:** Full-time
        **Posted on:** April 10, 2026
        **View Job URL:** https://to.indeed.com/xxx
    """
    results = []
    current = {}

    for line in mcp_text.strip().split("\n"):
        line = line.strip()
        if not line:
            if current:
                results.append(current)
                current = {}
            continue

        if line.startswith("**Job Title:**"):
            if current:
                results.append(current)
            current = {"title": line.split(":**", 1)[1].strip()}
        elif line.startswith("**Company:**"):
            current["employer"] = line.split(":**", 1)[1].strip()
        elif line.startswith("**Location:**"):
            current["location_raw"] = line.split(":**", 1)[1].strip()
        elif line.startswith("**Compensation:**"):
            current["salary_raw"] = line.split(":**", 1)[1].strip()
        elif line.startswith("**Job Type:**"):
            current["employment_type"] = line.split(":**", 1)[1].strip().lower()
        elif line.startswith("**Posted on:**"):
            current["post_date"] = line.split(":**", 1)[1].strip()
        elif line.startswith("**View Job URL:**"):
            current["source_url"] = line.split(":**", 1)[1].strip()

    if current:
        results.append(current)

    return results


def store_results(db_path: str, results: list[dict], role_id: int, run_id: int) -> dict:
    """Store parsed Indeed results in SQLite.

    Returns:
        {"stored": N, "duplicates": N, "errors": N}
    """
    conn = sqlite3.connect(db_path)
    stats = {"stored": 0, "duplicates": 0, "errors": 0}

    try:
        for r in results:
            try:
                title = r.get("title", "")
                employer = r.get("employer", "")
                if not title or not employer:
                    stats["errors"] += 1
                    continue

                location_raw = r.get("location_raw", "")
                loc_bucket = bucket_location(location_raw)

                salary_raw = r.get("salary_raw", "")
                sal_low, sal_high, sal_type, orig_low, orig_high = normalize_salary(salary_raw)

                dedup = make_dedup_hash(title, employer, loc_bucket)

                # Map employment type
                emp_type = r.get("employment_type", "")
                if "full" in emp_type:
                    emp_type = "full-time"
                elif "part" in emp_type:
                    emp_type = "part-time"
                elif "contract" in emp_type:
                    emp_type = "contract"
                else:
                    emp_type = None

                conn.execute("""
                    INSERT INTO job_postings (
                        dedup_hash, board, source_url, search_run_id,
                        title, employer, location_raw, location_bucket,
                        salary_low, salary_high, salary_raw, salary_type,
                        original_rate_low, original_rate_high,
                        post_date, employment_type,
                        matched_role_id
                    ) VALUES (?, 'indeed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(dedup_hash) DO UPDATE SET
                        last_seen_date = date('now'),
                        -- search_run_id stays at first sighting: overwriting it
                        -- deleted the posting from every earlier run's report.
                        last_run_id = excluded.search_run_id,
                        -- Only fill gaps. A board that lists no salary must not
                        -- erase a salary another board already supplied.
                        salary_low = COALESCE(job_postings.salary_low, excluded.salary_low),
                        salary_high = COALESCE(job_postings.salary_high, excluded.salary_high),
                        salary_raw = COALESCE(job_postings.salary_raw, excluded.salary_raw),
                        salary_type = COALESCE(job_postings.salary_type, excluded.salary_type),
                        original_rate_low = COALESCE(job_postings.original_rate_low, excluded.original_rate_low),
                        original_rate_high = COALESCE(job_postings.original_rate_high, excluded.original_rate_high),
                        post_date = COALESCE(job_postings.post_date, excluded.post_date),
                        employment_type = COALESCE(job_postings.employment_type, excluded.employment_type)
                """, (
                    dedup, r.get("source_url"), run_id,
                    title, employer, location_raw, loc_bucket,
                    sal_low, sal_high, salary_raw, sal_type,
                    orig_low, orig_high,
                    r.get("post_date"), emp_type,
                    role_id,
                ))
                stats["stored"] += 1

            except sqlite3.IntegrityError:
                stats["duplicates"] += 1
            except Exception as e:
                stats["errors"] += 1
                print(f"Error storing result: {e}", file=sys.stderr)

        conn.commit()
    finally:
        conn.close()

    return stats


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--store", action="store_true", help="Store results in DB")
    parser.add_argument("--parse-only", action="store_true", help="Parse and print JSON, don't store")
    parser.add_argument("--role-id", type=int, required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--db", required=True, help="Path to SQLite database")
    parser.add_argument("--data", default=None, help="MCP response text (or read from stdin)")
    args = parser.parse_args()

    if args.data:
        mcp_text = args.data
    else:
        mcp_text = sys.stdin.read()

    results = parse_indeed_mcp_response(mcp_text)

    if args.parse_only:
        print(json.dumps(results, indent=2))
        sys.exit(0)

    if args.store:
        stats = store_results(args.db, results, args.role_id, args.run_id)
        print(json.dumps(stats))
