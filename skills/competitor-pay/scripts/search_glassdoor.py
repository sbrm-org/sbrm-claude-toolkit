"""Glassdoor job search via Playwright headed browser.

Login required for salary data. Uses playwright-cli with persistent session.
Glassdoor's "estimated salary" is uniquely valuable for benchmarking.

Usage:
    echo '<snapshot>' | python3 search_glassdoor.py --store \
        --role-id 1 --run-id 1 --db data/comp_research.db
"""

import json
import re
import sqlite3
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from extract_salary import normalize_salary
from location_bucket import bucket_location
from dedupe import make_dedup_hash


def build_search_url(keyword: str) -> str:
    """Build Glassdoor search URL for Santa Barbara area."""
    kw_slug = keyword.lower().replace(" ", "-")
    return (
        f"https://www.glassdoor.com/Job/santa-barbara-{kw_slug}"
        f"-jobs-SRCH_IL.0,13_IC1146821.htm"
    )


def parse_snapshot(snapshot_text: str) -> list[dict]:
    """Parse a Playwright snapshot of Glassdoor search results.

    Glassdoor shows:
    - Job title (linked)
    - Company name + rating
    - Location
    - Salary estimate (Glassdoor's own estimate, very valuable)
    - Posted date
    """
    results = []
    current = {}

    for line in snapshot_text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue

        # Job title links - Glassdoor uses various URL patterns
        title_match = re.search(
            r'\[([^\]]+)\]\((https://www\.glassdoor\.com/(?:job-listing|partner)/[^\)]+)\)',
            line
        )
        if title_match:
            title = title_match.group(1).strip()
            url = title_match.group(2).strip()
            if len(title) > 3:
                if current and current.get("title"):
                    results.append(current)
                current = {"title": title, "source_url": url}
                continue

        if not current or not current.get("title"):
            continue

        # Glassdoor salary estimates: "$45K - $65K (Glassdoor est.)" or "$22 - $28 Per Hour"
        if "salary_raw" not in current:
            sal_match = re.search(
                r'(\$[\d,.]+[Kk]?\s*[-–—to]+\s*\$[\d,.]+[Kk]?'
                r'(?:\s*(?:Per|/)\s*(?:Year|Hour|Month|Week|Yr|Hr))?'
                r'(?:\s*\((?:Glassdoor|Employer)\s+est\.?\))?)',
                line, re.IGNORECASE
            )
            if sal_match:
                current["salary_raw"] = sal_match.group(1).strip()

        # Company name
        if "employer" not in current:
            # Glassdoor often shows "Company Name ★ 3.5" or just company name
            company_match = re.search(r'^([A-Z][\w\s&\'-]+?)(?:\s*★|\s*\d\.\d|\s*$)', line)
            if company_match and len(company_match.group(1).strip()) > 2:
                current["employer"] = company_match.group(1).strip()
                continue

        # Location
        if "location_raw" not in current:
            loc_match = re.search(r'([\w\s]+,\s*[A-Z]{2})', line)
            if loc_match:
                current["location_raw"] = loc_match.group(1).strip()

        # Employment type
        if "employment_type" not in current:
            if re.search(r'\bfull[- ]?time\b', line, re.I):
                current["employment_type"] = "full-time"
            elif re.search(r'\bpart[- ]?time\b', line, re.I):
                current["employment_type"] = "part-time"

        # Date
        if "post_date" not in current:
            date_match = re.search(r'(\d+d|\d+h|\d+\s*(?:day|hour|week)s?\s+ago)', line, re.I)
            if date_match:
                current["post_date"] = date_match.group(1).strip()

    if current and current.get("title"):
        results.append(current)

    return results


def store_results(db_path: str, results: list[dict], role_id: int, run_id: int) -> dict:
    """Store parsed Glassdoor results in SQLite."""
    conn = sqlite3.connect(db_path)
    stats = {"stored": 0, "duplicates": 0, "errors": 0}

    try:
        for r in results:
            try:
                title = r.get("title", "")
                employer = r.get("employer", "Unknown")
                if not title:
                    stats["errors"] += 1
                    continue

                location_raw = r.get("location_raw", "")
                loc_bucket = bucket_location(location_raw)

                salary_raw = r.get("salary_raw", "")
                sal_low, sal_high, sal_type, orig_low, orig_high = normalize_salary(salary_raw)

                dedup = make_dedup_hash(title, employer, loc_bucket)
                emp_type = r.get("employment_type")

                conn.execute("""
                    INSERT INTO job_postings (
                        dedup_hash, board, source_url, search_run_id,
                        title, employer, location_raw, location_bucket,
                        salary_low, salary_high, salary_raw, salary_type,
                        original_rate_low, original_rate_high,
                        post_date, employment_type,
                        matched_role_id
                    ) VALUES (?, 'glassdoor', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    parser.add_argument("--store", action="store_true")
    parser.add_argument("--parse-only", action="store_true")
    parser.add_argument("--role-id", type=int, required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--db", required=True)
    args = parser.parse_args()

    snapshot_text = sys.stdin.read()
    results = parse_snapshot(snapshot_text)

    if args.parse_only:
        print(json.dumps(results, indent=2))
        sys.exit(0)

    if args.store:
        stats = store_results(args.db, results, args.role_id, args.run_id)
        print(json.dumps(stats))
