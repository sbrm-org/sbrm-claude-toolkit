"""Export competitor pay data to CSV.

Usage:
    python3 export_csv.py --db data/comp_research.db [--run-id N] [--output path]
"""

import csv
import sqlite3
import sys
from datetime import date
from pathlib import Path


def export_csv(db_path: str, run_id: int = None, output_path: str = None) -> str:
    """Export job postings to CSV.

    Returns the path to the written CSV file.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    try:
        # Determine run
        if not run_id:
            row = conn.execute(
                "SELECT id FROM search_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if not row:
                print("No search runs found.", file=sys.stderr)
                sys.exit(1)
            run_id = row["id"]

        # Default output path
        if not output_path:
            data_dir = Path(db_path).parent
            output_path = str(data_dir / f"comp_report_{date.today().strftime('%Y-%m')}.csv")

        # Query all postings for this run, joined with role info
        rows = conn.execute("""
            SELECT
                r.title as sbrm_role,
                r.department,
                jp.board,
                jp.title as posting_title,
                jp.employer,
                jp.location_raw,
                jp.location_bucket,
                jp.salary_low,
                jp.salary_high,
                jp.salary_raw,
                jp.salary_type,
                jp.original_rate_low,
                jp.original_rate_high,
                jp.employment_type,
                jp.post_date,
                jp.source_url,
                jp.description_snippet,
                jp.education_req,
                jp.sector,
                jp.relevance_score
            FROM job_postings jp
            LEFT JOIN roles r ON jp.matched_role_id = r.id
            WHERE jp.search_run_id = ?
            ORDER BY r.department, r.title, jp.salary_high DESC NULLS LAST
        """, (run_id,)).fetchall()

        # Write CSV
        fieldnames = [
            "SBRM Role", "Department",
            "Board", "Posting Title", "Employer",
            "Location (Raw)", "Location Bucket",
            "Salary Low (Annual)", "Salary High (Annual)",
            "Salary (Original)", "Salary Type",
            "Original Rate Low", "Original Rate High",
            "Match Status",
            "Employment Type", "Post Date",
            "Source URL", "Description Snippet",
            "Education", "Sector"
        ]

        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for row in rows:
                # Map relevance score to match status
                score = row["relevance_score"]
                if score is not None:
                    if score >= 0.7:
                        match_status = "Good"
                    elif score >= 0.4:
                        match_status = "Close"
                    else:
                        match_status = "Almost Bad"
                else:
                    match_status = ""

                writer.writerow({
                    "SBRM Role": row["sbrm_role"] or "",
                    "Department": row["department"] or "",
                    "Board": row["board"] or "",
                    "Posting Title": row["posting_title"] or "",
                    "Employer": row["employer"] or "",
                    "Location (Raw)": row["location_raw"] or "",
                    "Location Bucket": row["location_bucket"] or "",
                    "Salary Low (Annual)": row["salary_low"] or "",
                    "Salary High (Annual)": row["salary_high"] or "",
                    "Salary (Original)": row["salary_raw"] or "",
                    "Salary Type": row["salary_type"] or "",
                    "Original Rate Low": row["original_rate_low"] or "",
                    "Original Rate High": row["original_rate_high"] or "",
                    "Match Status": match_status,
                    "Employment Type": row["employment_type"] or "",
                    "Post Date": row["post_date"] or "",
                    "Source URL": row["source_url"] or "",
                    "Description Snippet": row["description_snippet"] or "",
                    "Education": row["education_req"] or "",
                    "Sector": row["sector"] or "",
                })

        return output_path

    finally:
        conn.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--run-id", type=int, default=None)
    parser.add_argument("--output", default=None, help="Output CSV path")
    args = parser.parse_args()

    path = export_csv(args.db, args.run_id, args.output)
    print(f"CSV exported to: {path}")
