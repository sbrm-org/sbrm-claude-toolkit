"""Generate markdown summary report from competitor pay database.

Usage:
    python3 report.py --db data/comp_research.db [--run-id N]
"""

import json
import sqlite3
import sys
from pathlib import Path


def _money_range(low, high):
    """Format a pay range that may be missing either end.

    Postings often list only a floor ("From $48,000"), so MAX(salary_high)
    comes back NULL for any role where no posting stated a ceiling. Formatting
    that directly raised TypeError and took the whole report down.
    """
    if low is None and high is None:
        return "—"
    if high is None:
        return f"${low:,.0f}+"
    if low is None:
        return f"up to ${high:,.0f}"
    if low == high:
        return f"${low:,.0f}"
    return f"${low:,.0f}\u2013${high:,.0f}"


def generate_report(db_path: str, run_id: int = None) -> str:
    """Generate a markdown report for the given run (or latest)."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    try:
        # Get run info
        if run_id:
            run = conn.execute(
                "SELECT * FROM search_runs WHERE id = ?", (run_id,)
            ).fetchone()
        else:
            run = conn.execute(
                "SELECT * FROM search_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()

        if not run:
            return "No search runs found in the database."

        run_id = run["id"]
        lines = []
        lines.append(f"# Competitor Pay Report — Run #{run_id}")
        lines.append(f"**Date:** {run['run_date']}  ")
        lines.append(f"**Status:** {run['status']}  ")
        lines.append("")

        # Board summary
        board_stats = conn.execute("""
            SELECT board,
                   COUNT(*) as total,
                   COUNT(salary_low) as with_salary,
                   ROUND(100.0 * COUNT(salary_low) / COUNT(*), 1) as salary_pct
            FROM job_postings
            WHERE search_run_id = ?
            GROUP BY board
            ORDER BY total DESC
        """, (run_id,)).fetchall()

        lines.append("## Board Summary")
        lines.append("")
        lines.append("| Board | Postings | With Salary | Coverage |")
        lines.append("|-------|----------|-------------|----------|")
        total_postings = 0
        total_with_salary = 0
        for row in board_stats:
            lines.append(
                f"| {row['board'].title()} | {row['total']} | "
                f"{row['with_salary']} | {row['salary_pct']}% |"
            )
            total_postings += row["total"]
            total_with_salary += row["with_salary"]

        overall_pct = round(100.0 * total_with_salary / total_postings, 1) if total_postings else 0
        lines.append(
            f"| **Total** | **{total_postings}** | "
            f"**{total_with_salary}** | **{overall_pct}%** |"
        )
        lines.append("")

        # Role summary with market data
        role_stats = conn.execute("""
            SELECT r.title as role_title, r.department,
                   COUNT(jp.id) as postings,
                   COUNT(jp.salary_low) as with_salary,
                   MIN(jp.salary_low) as market_low,
                   MAX(jp.salary_high) as market_high,
                   ROUND(AVG(jp.salary_low), 0) as avg_low,
                   ROUND(AVG(jp.salary_high), 0) as avg_high
            FROM roles r
            LEFT JOIN job_postings jp ON jp.matched_role_id = r.id
                AND jp.search_run_id = ?
            WHERE r.active = 1
            GROUP BY r.id
            ORDER BY r.department, r.title
        """, (run_id,)).fetchall()

        lines.append("## Market Data by Role")
        lines.append("")
        lines.append("| Role | Dept | Postings | Salary Range | Market Avg |")
        lines.append("|------|------|----------|--------------|------------|")

        for row in role_stats:
            postings = row["postings"]
            if row["with_salary"] > 0:
                sal_range = _money_range(row["market_low"], row["market_high"])
                avg_range = _money_range(row["avg_low"], row["avg_high"])
            else:
                sal_range = "—"
                avg_range = "—"

            lines.append(
                f"| {row['role_title']} | {row['department'] or '—'} | "
                f"{postings} | {sal_range} | {avg_range} |"
            )

        lines.append("")

        # Location breakdown
        loc_stats = conn.execute("""
            SELECT location_bucket, COUNT(*) as cnt
            FROM job_postings
            WHERE search_run_id = ?
            GROUP BY location_bucket
            ORDER BY cnt DESC
        """, (run_id,)).fetchall()

        lines.append("## Location Distribution")
        lines.append("")
        for row in loc_stats:
            lines.append(f"- **{row['location_bucket']}:** {row['cnt']} postings")
        lines.append("")

        # Match status distribution
        match_stats = conn.execute("""
            SELECT
                CASE
                    WHEN relevance_score >= 0.7 THEN 'Good'
                    WHEN relevance_score >= 0.4 THEN 'Close'
                    WHEN relevance_score IS NOT NULL THEN 'Almost Bad'
                    ELSE 'Unscored'
                END as match_status,
                COUNT(*) as cnt
            FROM job_postings
            WHERE search_run_id = ?
            GROUP BY match_status
            ORDER BY cnt DESC
        """, (run_id,)).fetchall()

        if match_stats:
            lines.append("## Match Status Distribution")
            lines.append("")
            for row in match_stats:
                lines.append(f"- **{row['match_status']}:** {row['cnt']} postings")
            lines.append("")

        # Data quality warnings
        warnings = _check_data_quality(conn, run_id, total_postings, total_with_salary)
        if warnings:
            lines.append("## Data Quality Warnings")
            lines.append("")
            for w in warnings:
                lines.append(f"- {w}")
            lines.append("")

        # Top employers
        top_employers = conn.execute("""
            SELECT employer, COUNT(*) as cnt,
                   COUNT(salary_low) as with_salary
            FROM job_postings
            WHERE search_run_id = ?
            GROUP BY employer
            ORDER BY cnt DESC
            LIMIT 15
        """, (run_id,)).fetchall()

        lines.append("## Top Employers")
        lines.append("")
        for row in top_employers:
            lines.append(f"- {row['employer']}: {row['cnt']} postings ({row['with_salary']} with salary)")
        lines.append("")

        return "\n".join(lines)

    finally:
        conn.close()


def _check_data_quality(conn, run_id: int, total_postings: int, total_with_salary: int) -> list[str]:
    """Run data quality checks and return warning messages."""
    warnings = []

    if total_postings == 0:
        warnings.append("No postings found in this run.")
        return warnings

    # Salary coverage
    salary_pct = 100.0 * total_with_salary / total_postings
    if salary_pct < 20:
        warnings.append(
            f"Low salary coverage: only {salary_pct:.0f}% of postings have salary data."
        )

    # Check for boards with zero results
    boards_checked = conn.execute("""
        SELECT DISTINCT board FROM search_log WHERE search_run_id = ?
    """, (run_id,)).fetchall()
    boards_with_results = conn.execute("""
        SELECT DISTINCT board FROM job_postings WHERE search_run_id = ?
    """, (run_id,)).fetchall()
    checked = {r["board"] for r in boards_checked}
    with_results = {r["board"] for r in boards_with_results}
    failed_boards = checked - with_results
    if failed_boards:
        warnings.append(
            f"Boards returned zero results: {', '.join(sorted(failed_boards))}"
        )

    # Roles with zero results
    zero_roles = conn.execute("""
        SELECT r.title FROM roles r
        LEFT JOIN job_postings jp ON jp.matched_role_id = r.id
            AND jp.search_run_id = ?
        WHERE r.active = 1
        GROUP BY r.id
        HAVING COUNT(jp.id) = 0
    """, (run_id,)).fetchall()
    if zero_roles:
        names = [r["title"] for r in zero_roles]
        if len(names) <= 5:
            warnings.append(f"Roles with zero results: {', '.join(names)}")
        else:
            warnings.append(f"{len(names)} roles had zero results (check search keywords)")

    # Location bucketing quality
    unknown_pct = conn.execute("""
        SELECT ROUND(100.0 * COUNT(CASE WHEN location_bucket = 'Unknown' THEN 1 END)
                     / COUNT(*), 1) as pct
        FROM job_postings WHERE search_run_id = ?
    """, (run_id,)).fetchone()["pct"] or 0
    if unknown_pct > 30:
        warnings.append(
            f"High unknown locations: {unknown_pct}% of postings have unknown location."
        )

    # Salary sanity
    suspicious = conn.execute("""
        SELECT COUNT(*) as cnt FROM job_postings
        WHERE search_run_id = ?
          AND (salary_low < 20000 OR salary_high > 500000)
          AND salary_low IS NOT NULL
    """, (run_id,)).fetchone()["cnt"]
    if suspicious > 0:
        warnings.append(
            f"{suspicious} postings have suspicious salary values (<$20K or >$500K)."
        )

    # Minimum viable run check
    boards_with_salary = conn.execute("""
        SELECT COUNT(DISTINCT board) as cnt FROM job_postings
        WHERE search_run_id = ? AND salary_low IS NOT NULL
    """, (run_id,)).fetchone()["cnt"]
    if len(with_results) < 2:
        warnings.append(
            "Less than 2 boards returned results — consider retrying failed boards."
        )
    if boards_with_salary < 1:
        warnings.append(
            "No boards returned salary data — this run may not be usable for benchmarking."
        )

    return warnings


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--run-id", type=int, default=None)
    args = parser.parse_args()

    report = generate_report(args.db, args.run_id)
    print(report)
