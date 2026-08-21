"""Parse organisation career-page postings and store them in SQLite.

Job boards cover the large employers and miss the rest. Most Santa Barbara
nonprofits post openings only on their own careers page, and director-level and
development roles almost never reach a board at all — which is why the boards
alone cannot answer "what does the market pay".

Claude does the searching (the toolkit's web-research skill: Tavily, then
DuckDuckGo and Jina as keyless fallbacks) and pipes what it found to this
script, exactly like the board scrapers. This script parses and stores; it does
no fetching of its own.

Accepts either JSON:
    {"results": [{"title": ..., "employer": ..., "salary_raw": ..., ...}]}
or the same **Field:** block format the other scrapers use.

Usage:
    echo '{"results": [...]}' | python3 search_org_website.py --store \
        --role-id 1 --run-id 1 --db path/to/db
"""

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from extract_salary import normalize_salary
from location_bucket import bucket_location
from dedupe import make_dedup_hash

BOARD = "org_website"

# Field labels accepted in block format. Career pages are not consistent, so
# several spellings map to the same field.
_FIELD_ALIASES = {
    "job title": "title",
    "title": "title",
    "position": "title",
    "company": "employer",
    "employer": "employer",
    "organization": "employer",
    "organisation": "employer",
    "location": "location_raw",
    "compensation": "salary_raw",
    "salary": "salary_raw",
    "pay": "salary_raw",
    "pay range": "salary_raw",
    "job type": "employment_type",
    "employment type": "employment_type",
    "posted on": "post_date",
    "posted": "post_date",
    "date posted": "post_date",
    "url": "source_url",
    "view job url": "source_url",
    "link": "source_url",
    "apply": "source_url",
}


def _clean(value):
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def parse_org_results(raw: str) -> list[dict]:
    """Parse either JSON or **Field:** blocks into posting records."""
    raw = (raw or "").strip()
    if not raw:
        return []

    # JSON first — that is what web-research hands back most of the time.
    if raw[0] in "[{":
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = None
        if data is not None:
            if isinstance(data, dict):
                data = data.get("results", data.get("postings", []))
            if isinstance(data, list):
                out = []
                for entry in data:
                    if not isinstance(entry, dict):
                        continue
                    rec = {}
                    for key, val in entry.items():
                        field = _FIELD_ALIASES.get(str(key).strip().lower(),
                                                   str(key).strip().lower())
                        rec[field] = _clean(val)
                    if rec.get("title"):
                        out.append(rec)
                return out

    # Block format fallback.
    results = []
    current = {}
    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            if current.get("title"):
                results.append(current)
            current = {}
            continue
        if not line.startswith("**") or ":**" not in line:
            continue
        label, value = line[2:].split(":**", 1)
        field = _FIELD_ALIASES.get(label.strip().lower())
        if not field:
            continue
        if field == "title" and current.get("title"):
            results.append(current)
            current = {}
        current[field] = _clean(value)

    if current.get("title"):
        results.append(current)
    return results


def store_results(db_path: str, results: list[dict], role_id: int,
                  run_id: int) -> dict:
    """Store parsed career-page results.

    Returns {"stored": N, "updated": N, "skipped": N, "errors": N}.

    'stored' counts genuinely new postings and 'updated' counts re-sightings.
    The board scrapers report both as 'stored' because their IntegrityError
    counter is unreachable under ON CONFLICT — the progress output overstates
    how much is new.
    """
    conn = sqlite3.connect(db_path)
    stats = {"stored": 0, "updated": 0, "skipped": 0, "errors": 0}

    try:
        for r in results:
            try:
                title = _clean(r.get("title"))
                employer = _clean(r.get("employer"))
                if not title or not employer:
                    stats["skipped"] += 1
                    continue

                location_raw = r.get("location_raw")
                loc_bucket = bucket_location(location_raw)
                dedup = make_dedup_hash(title, employer, loc_bucket)

                salary_raw = r.get("salary_raw")
                sal_low = sal_high = sal_type = orig_low = orig_high = None
                if salary_raw:
                    sal_low, sal_high, sal_type, orig_low, orig_high = \
                        normalize_salary(salary_raw)

                emp_type = (r.get("employment_type") or "").lower()
                if "full" in emp_type:
                    emp_type = "full-time"
                elif "part" in emp_type:
                    emp_type = "part-time"
                elif "contract" in emp_type:
                    emp_type = "contract"
                else:
                    emp_type = None

                existed = conn.execute(
                    "SELECT 1 FROM job_postings WHERE dedup_hash = ?",
                    (dedup,)).fetchone() is not None

                conn.execute("""
                    INSERT INTO job_postings (
                        dedup_hash, board, source_url, search_run_id,
                        title, employer, location_raw, location_bucket,
                        salary_low, salary_high, salary_raw, salary_type,
                        original_rate_low, original_rate_high,
                        post_date, employment_type,
                        matched_role_id
                    ) VALUES (?, 'org_website', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                              ?, ?, ?, ?, ?)
                    ON CONFLICT(dedup_hash) DO UPDATE SET
                        last_seen_date = date('now'),
                        last_run_id = excluded.search_run_id,
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

                if existed:
                    stats["updated"] += 1
                else:
                    stats["stored"] += 1

            except Exception as e:  # noqa: BLE001
                stats["errors"] += 1
                print(f"Error storing result: {e}", file=sys.stderr)

        conn.commit()
    finally:
        conn.close()

    return stats


def log_search(db_path: str, run_id: int, role_id: int, org: str,
               count: int, error: str = None) -> None:
    """Record the attempt so --resume can skip completed work."""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO search_log (search_run_id, role_id, board, "
            "keyword_used, results_count, error) VALUES (?, ?, ?, ?, ?, ?)",
            (run_id, role_id, BOARD, org, count, error),
        )
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--store", action="store_true")
    parser.add_argument("--parse-only", action="store_true")
    parser.add_argument("--role-id", type=int, required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--db", required=True)
    parser.add_argument("--org", default=None,
                        help="organisation searched, recorded in search_log")
    parser.add_argument("--data", default=None)
    args = parser.parse_args()

    raw = args.data if args.data else sys.stdin.read()
    results = parse_org_results(raw)

    if args.parse_only:
        print(json.dumps(results, indent=2))
        sys.exit(0)

    if args.store:
        stats = store_results(args.db, results, args.role_id, args.run_id)
        if args.org:
            log_search(args.db, args.run_id, args.role_id, args.org,
                       stats["stored"] + stats["updated"])
        print(json.dumps(stats))
