"""LinkedIn job search: Jina Reader discovery + Playwright detail pages.

Phase 2a (--discover): Uses Jina Reader to fetch public LinkedIn search results.
  No auth needed. Gets titles, companies, locations, posting URLs.

Phase 2b (--detail): Uses Playwright CLI with persistent session to visit
  individual posting pages and extract salary data.
  Requires LinkedIn login via Playwright persistent session.

Usage:
    # Discovery (Jina)
    python3 search_linkedin.py --discover --keyword "case manager" \
        --db data/comp_research.db --role-id 1 --run-id 1

    # Detail page extraction (outputs playwright-cli commands for Claude)
    python3 search_linkedin.py --detail --db data/comp_research.db \
        --role-id 1 --run-id 1

    # Parse a Playwright snapshot passed via stdin
    python3 search_linkedin.py --parse-detail --db data/comp_research.db \
        --role-id 1 --run-id 1 --posting-id 42
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


JINA_BASE = "https://r.jina.ai/"
LINKEDIN_SEARCH_URL = (
    "https://www.linkedin.com/jobs/search/"
    "?keywords={keywords}&location=Santa%20Barbara%20County"
)


def parse_jina_linkedin_results(markdown_text: str) -> list[dict]:
    """Parse Jina Reader markdown of LinkedIn public search results.

    Jina returns the page as markdown. LinkedIn's public guest search page
    shows job cards with:
    - Job title (as a link)
    - Company name
    - Location
    - Posted date (e.g., "2 days ago")
    - Sometimes a salary snippet

    The markdown varies, but common patterns:
    - Links: [Job Title](https://www.linkedin.com/jobs/view/...)
    - Company and location on subsequent lines
    """
    results = []
    lines = markdown_text.strip().split("\n")
    current = {}

    for i, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue

        # Look for job links: [Title](URL)
        link_match = re.search(
            r'\[([^\]]+)\]\((https://www\.linkedin\.com/jobs/view/[^\)]+)\)',
            line
        )
        if link_match:
            if current and current.get("title"):
                results.append(current)
            current = {
                "title": link_match.group(1).strip(),
                "source_url": link_match.group(2).strip(),
            }
            # Sometimes company/location on same line after the link
            remainder = line[link_match.end():].strip()
            if remainder:
                _parse_company_location(remainder, current)
            continue

        # If we have a current posting, look for company/location info
        if current and current.get("title"):
            # Company name often appears right after title
            if "employer" not in current and not line.startswith(("http", "[", "!", "#")):
                # Check if it looks like a company name (not a date or location)
                if not re.match(r'^\d', line) and "ago" not in line.lower():
                    current["employer"] = _clean_text(line)
                    continue

            # Location patterns
            if "location_raw" not in current:
                loc_match = re.search(
                    r'(?:Santa Barbara|Goleta|Carpinteria|Lompoc|Remote|California|CA)',
                    line, re.IGNORECASE
                )
                if loc_match:
                    current["location_raw"] = _clean_text(line)
                    continue

            # Date patterns
            if "post_date" not in current and re.search(r'\d+\s+(?:day|week|hour|month)s?\s+ago', line, re.I):
                current["post_date"] = _clean_text(line)
                continue

            # Salary patterns on public page (rare but possible)
            if "salary_raw" not in current and "$" in line:
                current["salary_raw"] = _clean_text(line)

    if current and current.get("title"):
        results.append(current)

    return results


def parse_detail_snapshot(snapshot_text: str) -> dict:
    """Parse a Playwright snapshot of a LinkedIn job detail page.

    Extracts salary, description snippet, education, employment type
    from the authenticated detail view.
    """
    result = {}

    # Salary: LinkedIn shows it in various formats
    # "Salary: $X - $Y/yr" or "$X/hr - $Y/hr" etc.
    salary_patterns = [
        r'(\$[\d,]+(?:\.\d+)?\s*[-–—to]+\s*\$[\d,]+(?:\.\d+)?(?:\s*/\s*\w+)?)',
        r'(\$[\d,]+(?:\.\d+)?(?:\s*/\s*(?:yr|hr|year|hour|mo|month|week)))',
        r'(?:salary|pay|compensation)[:\s]*(\$[\d,]+[^\n]{0,50})',
    ]
    for pattern in salary_patterns:
        match = re.search(pattern, snapshot_text, re.IGNORECASE)
        if match:
            result["salary_raw"] = match.group(1).strip()
            break

    # Employment type
    emp_patterns = [
        (r'\bfull[- ]?time\b', "full-time"),
        (r'\bpart[- ]?time\b', "part-time"),
        (r'\bcontract\b', "contract"),
        (r'\btemporary\b', "contract"),
        (r'\binternship\b', "internship"),
    ]
    for pattern, emp_type in emp_patterns:
        if re.search(pattern, snapshot_text, re.IGNORECASE):
            result["employment_type"] = emp_type
            break

    # Description snippet (first ~500 chars of description)
    desc_match = re.search(
        r'(?:About the (?:job|role|position)|Job [Dd]escription|Description)\s*\n(.*)',
        snapshot_text, re.DOTALL
    )
    if desc_match:
        desc = desc_match.group(1).strip()
        # Clean up and truncate
        desc = re.sub(r'\s+', ' ', desc)
        result["description_snippet"] = desc[:500]

    # Education requirements
    edu_patterns = [
        r"(?:bachelor'?s?|master'?s?|associate'?s?|doctorate|ph\.?d)",
        r"(?:degree|diploma|certification|licensed|lcsw|mft|lmft|lpc)",
    ]
    for pattern in edu_patterns:
        match = re.search(pattern, snapshot_text, re.IGNORECASE)
        if match:
            # Get surrounding context
            start = max(0, match.start() - 50)
            end = min(len(snapshot_text), match.end() + 100)
            result["education_req"] = snapshot_text[start:end].strip()
            break

    return result


def store_discovery_results(
    db_path: str, results: list[dict], role_id: int, run_id: int
) -> dict:
    """Store Jina discovery results in SQLite.

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
                if not title:
                    stats["errors"] += 1
                    continue
                if not employer:
                    employer = "Unknown"

                location_raw = r.get("location_raw", "")
                loc_bucket = bucket_location(location_raw)

                salary_raw = r.get("salary_raw", "")
                sal_low, sal_high, sal_type, orig_low, orig_high = normalize_salary(salary_raw)

                dedup = make_dedup_hash(title, employer, loc_bucket)

                conn.execute("""
                    INSERT INTO job_postings (
                        dedup_hash, board, source_url, search_run_id,
                        title, employer, location_raw, location_bucket,
                        salary_low, salary_high, salary_raw, salary_type,
                        original_rate_low, original_rate_high,
                        post_date, matched_role_id
                    ) VALUES (?, 'linkedin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    r.get("post_date"),
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


def update_posting_detail(db_path: str, posting_id: int, detail: dict) -> bool:
    """Update an existing posting with detail page data (salary, description, etc.)."""
    conn = sqlite3.connect(db_path)
    try:
        updates = []
        values = []

        if detail.get("salary_raw"):
            sal_low, sal_high, sal_type, orig_low, orig_high = normalize_salary(detail["salary_raw"])
            updates.extend([
                "salary_raw = ?", "salary_low = ?",
                "salary_high = ?", "salary_type = ?",
                "original_rate_low = ?", "original_rate_high = ?"
            ])
            values.extend([detail["salary_raw"], sal_low, sal_high, sal_type, orig_low, orig_high])

        if detail.get("employment_type"):
            updates.append("employment_type = ?")
            values.append(detail["employment_type"])

        if detail.get("description_snippet"):
            updates.append("description_snippet = ?")
            values.append(detail["description_snippet"])

        if detail.get("education_req"):
            updates.append("education_req = ?")
            values.append(detail["education_req"])

        if not updates:
            return False

        values.append(posting_id)
        sql = f"UPDATE job_postings SET {', '.join(updates)} WHERE id = ?"
        conn.execute(sql, values)
        conn.commit()
        return True
    finally:
        conn.close()


def get_postings_needing_detail(db_path: str, role_id: int, run_id: int, limit: int = 10) -> list[dict]:
    """Get LinkedIn postings from this run that don't have salary data yet.

    Returns up to `limit` postings ordered by relevance (most recent first).
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("""
            SELECT id, title, employer, source_url, location_bucket
            FROM job_postings
            WHERE board = 'linkedin'
              AND matched_role_id = ?
              AND search_run_id = ?
              AND salary_low IS NULL
              AND source_url IS NOT NULL
            ORDER BY id DESC
            LIMIT ?
        """, (role_id, run_id, limit)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def build_jina_url(keyword: str) -> str:
    """Build the Jina Reader URL for a LinkedIn search."""
    encoded_kw = urllib.parse.quote(keyword)
    linkedin_url = LINKEDIN_SEARCH_URL.format(keywords=encoded_kw)
    return f"{JINA_BASE}{linkedin_url}"


def _clean_text(text: str) -> str:
    """Clean up extracted text."""
    text = re.sub(r'\[([^\]]*)\]\([^\)]*\)', r'\1', text)  # Remove markdown links
    text = re.sub(r'[*_`]', '', text)  # Remove markdown formatting
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def _parse_company_location(text: str, record: dict):
    """Try to extract company and location from a text fragment."""
    parts = [p.strip() for p in text.split("·") if p.strip()]
    if not parts:
        parts = [p.strip() for p in text.split("–") if p.strip()]
    if len(parts) >= 2:
        record["employer"] = _clean_text(parts[0])
        record["location_raw"] = _clean_text(parts[1])
    elif len(parts) == 1:
        record["employer"] = _clean_text(parts[0])


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--discover", action="store_true",
                        help="Parse Jina discovery results from stdin and store")
    parser.add_argument("--detail", action="store_true",
                        help="List postings needing detail page visits")
    parser.add_argument("--parse-detail", action="store_true",
                        help="Parse a detail page snapshot from stdin and update DB")
    parser.add_argument("--keyword", default=None,
                        help="Search keyword (for --discover)")
    parser.add_argument("--role-id", type=int, required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--posting-id", type=int, default=None,
                        help="Posting ID to update (for --parse-detail)")
    parser.add_argument("--db", required=True, help="Path to SQLite database")
    parser.add_argument("--limit", type=int, default=10,
                        help="Max detail pages per role")
    args = parser.parse_args()

    if args.discover:
        jina_text = sys.stdin.read()
        results = parse_jina_linkedin_results(jina_text)
        if results:
            stats = store_discovery_results(args.db, results, args.role_id, args.run_id)
            print(json.dumps(stats))
        else:
            print(json.dumps({"stored": 0, "duplicates": 0, "errors": 0,
                              "note": "No results parsed from Jina response"}))

    elif args.detail:
        postings = get_postings_needing_detail(
            args.db, args.role_id, args.run_id, args.limit
        )
        # Output as JSON — Claude reads this and issues playwright-cli commands
        print(json.dumps(postings, indent=2))

    elif args.parse_detail:
        if not args.posting_id:
            print("Error: --posting-id required for --parse-detail", file=sys.stderr)
            sys.exit(1)
        snapshot_text = sys.stdin.read()
        detail = parse_detail_snapshot(snapshot_text)
        if detail:
            updated = update_posting_detail(args.db, args.posting_id, detail)
            print(json.dumps({"updated": updated, "fields": list(detail.keys())}))
        else:
            print(json.dumps({"updated": False, "note": "No data extracted from snapshot"}))
