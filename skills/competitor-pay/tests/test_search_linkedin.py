"""Tests for LinkedIn search module."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from search_linkedin import (
    parse_jina_linkedin_results,
    parse_detail_snapshot,
    build_jina_url,
)


def test_parse_jina_basic():
    """Parse a simple Jina markdown response with job links."""
    markdown = """
# Jobs in Santa Barbara

[Case Manager](https://www.linkedin.com/jobs/view/12345)
Good Samaritan
Santa Barbara, CA
2 days ago

[Social Worker](https://www.linkedin.com/jobs/view/67890)
County of Santa Barbara
Goleta, CA
1 week ago
"""
    results = parse_jina_linkedin_results(markdown)
    assert len(results) == 2
    assert results[0]["title"] == "Case Manager"
    assert results[0]["source_url"] == "https://www.linkedin.com/jobs/view/12345"
    assert results[0]["employer"] == "Good Samaritan"
    assert results[1]["title"] == "Social Worker"


def test_parse_jina_with_salary():
    """Parse response that includes salary info."""
    markdown = """
[Case Manager](https://www.linkedin.com/jobs/view/12345)
SBRM
Santa Barbara, CA
$22 - $28 per hour
3 days ago
"""
    results = parse_jina_linkedin_results(markdown)
    assert len(results) == 1
    assert results[0]["salary_raw"] == "$22 - $28 per hour"


def test_parse_jina_empty():
    """Handle empty response."""
    results = parse_jina_linkedin_results("")
    assert results == []


def test_parse_jina_no_jobs():
    """Handle response with no job links."""
    markdown = """
# LinkedIn

Sign in to see results.
No jobs found matching your criteria.
"""
    results = parse_jina_linkedin_results(markdown)
    assert results == []


def test_parse_detail_with_salary():
    """Parse detail page snapshot with salary data."""
    snapshot = """
Case Manager
Good Samaritan Shelter
Santa Barbara, CA

Salary: $45,000 - $55,000/yr
Full-time

About the job
We are looking for a compassionate case manager to join our team.
Must have Bachelor's degree in Social Work or related field.
"""
    detail = parse_detail_snapshot(snapshot)
    assert "salary_raw" in detail
    assert "$45,000" in detail["salary_raw"]
    assert detail["employment_type"] == "full-time"
    assert "description_snippet" in detail
    assert "education_req" in detail
    assert "bachelor" in detail["education_req"].lower()


def test_parse_detail_hourly():
    """Parse detail page with hourly salary."""
    snapshot = """
Cook
Salary: $18 - $22 Per Hour
Part-time
Job Description
Prepare meals for shelter residents.
"""
    detail = parse_detail_snapshot(snapshot)
    assert "salary_raw" in detail
    assert detail["employment_type"] == "part-time"


def test_parse_detail_no_salary():
    """Parse detail page with no salary info."""
    snapshot = """
Case Manager
Some Company
Santa Barbara, CA

About the job
Looking for experienced case manager.
"""
    detail = parse_detail_snapshot(snapshot)
    assert "salary_raw" not in detail


def test_build_jina_url():
    """Build correct Jina URL."""
    url = build_jina_url("case manager")
    assert url.startswith("https://r.jina.ai/")
    assert "case%20manager" in url
    assert "linkedin.com/jobs/search" in url


def test_build_jina_url_special_chars():
    """Build URL with special characters."""
    url = build_jina_url("cook/chef")
    assert "cook" in url
    assert "linkedin.com" in url
