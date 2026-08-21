"""Tests for deduplication."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from dedupe import make_dedup_hash


class TestExactDuplicates:
    def test_identical(self):
        h1 = make_dedup_hash("Case Manager", "Good Samaritan", "Santa Barbara County")
        h2 = make_dedup_hash("Case Manager", "Good Samaritan", "Santa Barbara County")
        assert h1 == h2

    def test_case_insensitive(self):
        h1 = make_dedup_hash("Case Manager", "Good Samaritan", "Santa Barbara County")
        h2 = make_dedup_hash("case manager", "good samaritan", "Santa Barbara County")
        assert h1 == h2

    def test_whitespace(self):
        h1 = make_dedup_hash("Case Manager", "Good Samaritan", "Santa Barbara County")
        h2 = make_dedup_hash("Case  Manager ", " Good Samaritan", "Santa Barbara County")
        assert h1 == h2

    def test_cross_board(self):
        """Same job on Indeed and Glassdoor should hash the same."""
        h1 = make_dedup_hash("Case Manager", "Cottage Health", "Santa Barbara County")
        h2 = make_dedup_hash("Case Manager", "Cottage Health", "Santa Barbara County")
        assert h1 == h2


class TestCorporateSuffixes:
    def test_inc(self):
        h1 = make_dedup_hash("Cook", "ACME", "Santa Barbara County")
        h2 = make_dedup_hash("Cook", "ACME Inc.", "Santa Barbara County")
        assert h1 == h2

    def test_llc(self):
        h1 = make_dedup_hash("Cook", "ACME", "Santa Barbara County")
        h2 = make_dedup_hash("Cook", "ACME LLC", "Santa Barbara County")
        assert h1 == h2

    def test_the(self):
        h1 = make_dedup_hash("Cook", "Rescue Mission", "Santa Barbara County")
        h2 = make_dedup_hash("Cook", "The Rescue Mission", "Santa Barbara County")
        assert h1 == h2


class TestNotDuplicates:
    def test_different_title(self):
        h1 = make_dedup_hash("Case Manager", "Cottage Health", "Santa Barbara County")
        h2 = make_dedup_hash("RN Case Manager", "Cottage Health", "Santa Barbara County")
        assert h1 != h2

    def test_different_employer(self):
        h1 = make_dedup_hash("Case Manager", "Cottage Health", "Santa Barbara County")
        h2 = make_dedup_hash("Case Manager", "Good Samaritan", "Santa Barbara County")
        assert h1 != h2

    def test_different_location(self):
        h1 = make_dedup_hash("Case Manager", "Cottage Health", "Santa Barbara County")
        h2 = make_dedup_hash("Case Manager", "Cottage Health", "Other California")
        assert h1 != h2
