"""Archive job posting pages using SingleFile CLI.

Optional module — skipped if SingleFile is not installed or --skip-archive flag is used.

Usage:
    python3 archive_page.py --run-id 1 --db data/comp_research.db [--archive-dir archive/]
"""

import os
import re
import sqlite3
import subprocess
import sys
from datetime import date
from pathlib import Path


def archive_run(db_path: str, run_id: int, archive_dir: str = None) -> dict:
    """Archive all postings with source URLs from a given run.

    Returns:
        {"archived": N, "skipped": N, "errors": N}
    """
    # Check SingleFile is available
    if not _singlefile_available():
        return {"archived": 0, "skipped": 0, "errors": 0,
                "note": "SingleFile CLI not installed — skipping archive"}

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    if not archive_dir:
        archive_dir = str(Path(db_path).parent.parent / "archive")

    # Create month subfolder
    month_dir = Path(archive_dir) / date.today().strftime("%Y-%m")
    month_dir.mkdir(parents=True, exist_ok=True)

    stats = {"archived": 0, "skipped": 0, "errors": 0}

    try:
        rows = conn.execute("""
            SELECT id, board, title, employer, source_url, archive_path
            FROM job_postings
            WHERE search_run_id = ?
              AND source_url IS NOT NULL
              AND archive_path IS NULL
        """, (run_id,)).fetchall()

        for row in rows:
            try:
                url = row["source_url"]
                if not url or not url.startswith("http"):
                    stats["skipped"] += 1
                    continue

                # Build filename
                safe_title = _safe_filename(row["title"])
                safe_employer = _safe_filename(row["employer"])
                filename = f"{row['board']}_{safe_title}_{safe_employer}.html"
                filepath = month_dir / filename

                if filepath.exists():
                    stats["skipped"] += 1
                    continue

                # Run SingleFile
                result = subprocess.run(
                    ["single-file", url, str(filepath)],
                    capture_output=True, text=True, timeout=60
                )

                if result.returncode == 0 and filepath.exists():
                    # Update DB with archive path
                    conn.execute(
                        "UPDATE job_postings SET archive_path = ? WHERE id = ?",
                        (str(filepath), row["id"])
                    )
                    stats["archived"] += 1
                else:
                    stats["errors"] += 1

            except subprocess.TimeoutExpired:
                stats["errors"] += 1
            except Exception as e:
                stats["errors"] += 1
                print(f"Archive error for {row['id']}: {e}", file=sys.stderr)

        conn.commit()
    finally:
        conn.close()

    return stats


def _singlefile_available() -> bool:
    """Check if SingleFile CLI is installed."""
    try:
        result = subprocess.run(
            ["which", "single-file"], capture_output=True, text=True
        )
        return result.returncode == 0
    except Exception:
        return False


def _safe_filename(text: str, max_len: int = 40) -> str:
    """Convert text to a safe filename component."""
    if not text:
        return "unknown"
    safe = re.sub(r'[^\w\s-]', '', text.lower())
    safe = re.sub(r'\s+', '_', safe).strip('_')
    return safe[:max_len]


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--db", required=True)
    parser.add_argument("--archive-dir", default=None)
    args = parser.parse_args()

    stats = archive_run(args.db, args.run_id, args.archive_dir)
    print(json.dumps(stats, indent=2))
