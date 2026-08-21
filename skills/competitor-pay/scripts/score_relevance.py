"""Relevance scoring for competitor pay database.

Filters postings by exclude_keywords and provides helpers for
match status mapping. Semantic scoring is done by Claude during
orchestration (batch-style, not per-posting).

Match Status values (maps to SharePoint MatchStatus choice):
- "Good"       (score >= 0.7): Title matches, similar duties, no exclude keywords
- "Close"      (score 0.4-0.69): Related role but different scope/setting
- "Almost Bad" (score < 0.4): Same title but clearly different job
"""

import json
import re
from typing import Optional


def check_exclude_keywords(
    text: str,
    exclude_keywords: list[str],
) -> Optional[str]:
    """Check if text contains any exclude keywords.

    Args:
        text: Combined title + description + employer text to check
        exclude_keywords: List of disqualifying terms

    Returns:
        The matched keyword if found, None if clean.
    """
    if not text or not exclude_keywords:
        return None

    text_lower = text.lower()
    for kw in exclude_keywords:
        # Word boundary match to avoid false positives
        # e.g., "RN" shouldn't match "learning" but should match "RN Case Manager"
        pattern = r'\b' + re.escape(kw.lower()) + r'\b'
        if re.search(pattern, text_lower):
            return kw

    return None


def score_to_match_status(score: float) -> str:
    """Map a numeric relevance score to a SharePoint MatchStatus value.

    Args:
        score: Float between 0.0 and 1.0

    Returns:
        "Good", "Close", or "Almost Bad"
    """
    if score >= 0.7:
        return "Good"
    if score >= 0.4:
        return "Close"
    return "Almost Bad"


def match_status_to_score(status: str) -> float:
    """Map a MatchStatus string back to a representative score.

    Useful when Claude assigns a status directly rather than a number.
    """
    return {
        "Good": 0.85,
        "Close": 0.55,
        "Almost Bad": 0.2,
    }.get(status, 0.5)


def load_role_exclude_keywords(roles_file: str) -> dict[str, list[str]]:
    """Load exclude_keywords for all roles from roles.json.

    Returns:
        Dict mapping role title -> list of exclude keywords
    """
    with open(roles_file) as f:
        data = json.load(f)

    result = {}
    for role in data.get("roles", []):
        title = role.get("title", "")
        keywords = role.get("exclude_keywords", [])
        if title and keywords:
            result[title] = keywords
    return result


def filter_postings_by_keywords(
    postings: list[dict],
    exclude_keywords: list[str],
) -> tuple[list[dict], list[dict]]:
    """Split postings into clean and excluded based on keywords.

    Args:
        postings: List of posting dicts with 'title', 'employer', 'description_snippet'
        exclude_keywords: List of disqualifying terms

    Returns:
        (clean_postings, excluded_postings) — excluded ones get auto-scored "Almost Bad"
    """
    if not exclude_keywords:
        return postings, []

    clean = []
    excluded = []

    for p in postings:
        text = " ".join(filter(None, [
            p.get("title", ""),
            p.get("employer", ""),
            p.get("description_snippet", ""),
        ]))
        matched = check_exclude_keywords(text, exclude_keywords)
        if matched:
            p["_exclude_reason"] = matched
            excluded.append(p)
        else:
            clean.append(p)

    return clean, excluded
