"""Cross-board deduplication for competitor pay database.

Uses MD5 hash of normalized (title | employer | location_bucket) to detect
when the same job appears on multiple boards.
"""

import hashlib
import re
from typing import Optional


def make_dedup_hash(title: str, employer: str, location_bucket: str) -> str:
    """Generate a deduplication hash for a job posting.

    Normalizes inputs before hashing to catch near-duplicates:
    - Lowercase
    - Strip whitespace and punctuation
    - Collapse multiple spaces
    - Remove common suffixes (Inc, LLC, Corp, etc.)

    Args:
        title: Job title
        employer: Company/organization name
        location_bucket: Already-bucketed location string

    Returns:
        MD5 hex digest string
    """
    norm_title = _normalize_text(title)
    norm_employer = _normalize_employer(employer)
    norm_location = (location_bucket or "unknown").strip().lower()

    key = f"{norm_title}|{norm_employer}|{norm_location}"
    return hashlib.md5(key.encode("utf-8")).hexdigest()


def _normalize_text(text: Optional[str]) -> str:
    """Normalize a text string for comparison."""
    if not text:
        return ""
    t = text.strip().lower()
    # Remove punctuation except hyphens
    t = re.sub(r"[^\w\s-]", "", t)
    # Collapse whitespace
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _normalize_employer(name: Optional[str]) -> str:
    """Normalize employer name, stripping common suffixes."""
    if not name:
        return ""
    t = _normalize_text(name)
    # Remove common corporate suffixes
    suffixes = [
        r"\b(?:inc|llc|ltd|corp|corporation|company|co|group|org)\b\.?",
        r"\b(?:the)\b",
    ]
    for suffix in suffixes:
        t = re.sub(suffix, "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def is_duplicate(existing_hash: str, new_hash: str) -> bool:
    """Check if two postings are duplicates based on their hashes."""
    return existing_hash == new_hash
