"""ZipRecruiter job search via Playwright headed browser.

No login required, but Cloudflare blocks headless/Jina access.
Uses playwright-cli with persistent session to bypass bot detection.

Usage:
    # Parse Playwright snapshot from stdin and store
    echo '<snapshot>' | python3 search_ziprecruiter.py --store \
        --role-id 1 --run-id 1 --db data/comp_research.db

    # Parse only (no DB write)
    echo '<snapshot>' | python3 search_ziprecruiter.py --parse-only
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


def build_search_url(keyword: str, location: str = "Santa Barbara, CA") -> str:
    """Build ZipRecruiter search URL."""
    return (
        f"https://www.ziprecruiter.com/jobs-search"
        f"?search={urllib.parse.quote(keyword)}"
        f"&location={urllib.parse.quote(location)}"
        f"&radius=50"
    )


def parse_snapshot(snapshot_text: str) -> list[dict]:
    """Parse a Playwright snapshot of ZipRecruiter search results.

    ZipRecruiter search results typically contain job cards with:
    - Job title (linked)
    - Company name
    - Location
    - Salary (often shown)
    - Posted date
    - Job type
    """
    results = []
    current = {}

    for line in snapshot_text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue

        # Job title links
        title_match = re.search(
            r'\[([^\]]+)\]\((https://www\.ziprecruiter\.com/[^\)]+)\)',
            line
        )
        if title_match:
            title = title_match.group(1).strip()
            url = title_match.group(2).strip()
            # Skip navigation/filter links
            if len(title) > 2 and "/jobs-search" not in url:
                if current and current.get("title"):
                    results.append(current)
                current = {"title": title, "source_url": url}
                continue

        if not current or not current.get("title"):
            continue

        # Salary patterns
        if "salary_raw" not in current and "$" in line:
            sal_match = re.search(
                r'(\$[\d,]+(?:\.\d+)?(?:\s*[-–—to/]+\s*\$[\d,]+(?:\.\d+)?)?'
                r'(?:\s*/\s*(?:yr|hr|year|hour|mo|month|week|annual))?)',
                line
            )
            if sal_match:
                current["salary_raw"] = sal_match.group(1).strip()

        # Company name (often plain text after title)
        if "employer" not in current:
            # Skip lines that are dates, salaries, or navigation
            if (not line.startswith(("http", "[", "!", "#", "$"))
                    and "ago" not in line.lower()
                    and not re.match(r'^\d', line)
                    and len(line) > 2):
                current["employer"] = _clean_text(line)
                continue

        # Location
        if "location_raw" not in current:
            loc_match = re.search(
                r'([\w\s]+,\s*[A-Z]{2}(?:\s+\d{5})?)',
                line
            )
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
            date_match = re.search(r'(\d+[+]?\s*(?:day|week|hour|month)s?\s+ago)', line, re.I)
            if date_match:
                current["post_date"] = date_match.group(1).strip()

    if current and current.get("title"):
        results.append(current)

    return results


def store_results(db_path: str, results: list[dict], role_id: int, run_id: int) -> dict:
    """Store parsed ZipRecruiter results in SQLite."""
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
                    ) VALUES (?, 'ziprecruiter', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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


def _clean_text(text: str) -> str:
    """Clean up extracted text."""
    text = re.sub(r'\[([^\]]*)\]\([^\)]*\)', r'\1', text)
    text = re.sub(r'[*_`]', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--store", action="store_true", help="Store results in DB")
    parser.add_argument("--parse-only", action="store_true", help="Parse and print JSON")
    parser.add_argument("--role-id", type=int, required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--db", required=True, help="Path to SQLite database")
    args = parser.parse_args()

    snapshot_text = sys.stdin.read()
    results = parse_snapshot(snapshot_text)

    if args.parse_only:
        print(json.dumps(results, indent=2))
        sys.exit(0)

    if args.store:
        stats = store_results(args.db, results, args.role_id, args.run_id)
        print(json.dumps(stats))
