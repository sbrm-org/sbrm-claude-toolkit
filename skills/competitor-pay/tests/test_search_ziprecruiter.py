"""Tests for ZipRecruiter search module."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from search_ziprecruiter import parse_snapshot, build_search_url


def test_parse_basic():
    """Parse a snapshot with job cards."""
    snapshot = """
[Case Manager](https://www.ziprecruiter.com/c/Good-Samaritan/job/Case-Manager/123)
Good Samaritan Shelter
Santa Barbara, CA
$45,000 - $55,000/yr
Full-time
2 days ago

[Social Worker](https://www.ziprecruiter.com/c/County-SB/job/Social-Worker/456)
County of Santa Barbara
Santa Barbara, CA 93101
$50,000 - $65,000/yr
Full-time
1 week ago
"""
    results = parse_snapshot(snapshot)
    assert len(results) == 2
    assert results[0]["title"] == "Case Manager"
    assert results[0]["employer"] == "Good Samaritan Shelter"
    assert "$45,000" in results[0]["salary_raw"]
    assert results[0]["employment_type"] == "full-time"


def test_parse_no_salary():
    """Parse results without salary."""
    snapshot = """
[Cook](https://www.ziprecruiter.com/c/SBRM/job/Cook/789)
Santa Barbara Rescue Mission
Santa Barbara, CA
Full-time
3 days ago
"""
    results = parse_snapshot(snapshot)
    assert len(results) == 1
    assert results[0]["title"] == "Cook"
    assert "salary_raw" not in results[0] or results[0].get("salary_raw") == ""


def test_parse_empty():
    """Handle empty snapshot."""
    results = parse_snapshot("")
    assert results == []


def test_build_search_url():
    """Build correct search URL."""
    url = build_search_url("case manager")
    assert "ziprecruiter.com" in url
    assert "case+manager" in url or "case%20manager" in url
    assert "Santa" in url
