"""Tests for relevance scoring."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from score_relevance import (
    check_exclude_keywords,
    score_to_match_status,
    match_status_to_score,
    filter_postings_by_keywords,
)


class TestExcludeKeywords:
    def test_no_match(self):
        assert check_exclude_keywords(
            "Case Manager - Shelter Services",
            ["RN", "registered nurse", "hospital"]
        ) is None

    def test_match_rn(self):
        assert check_exclude_keywords(
            "RN Case Manager - Hospital",
            ["RN", "registered nurse", "hospital"]
        ) == "RN"

    def test_match_hospital(self):
        assert check_exclude_keywords(
            "Case Manager at Memorial Hospital",
            ["RN", "registered nurse", "hospital"]
        ) == "hospital"

    def test_case_insensitive(self):
        assert check_exclude_keywords(
            "REGISTERED NURSE Case Manager",
            ["registered nurse"]
        ) == "registered nurse"

    def test_word_boundary(self):
        """'RN' should not match 'learning' or 'returning'."""
        assert check_exclude_keywords(
            "Case Manager - Learning Center",
            ["RN"]
        ) is None

    def test_empty_keywords(self):
        assert check_exclude_keywords("anything", []) is None

    def test_empty_text(self):
        assert check_exclude_keywords("", ["RN"]) is None

    def test_none_text(self):
        assert check_exclude_keywords(None, ["RN"]) is None


class TestScoreMapping:
    def test_good(self):
        assert score_to_match_status(0.85) == "Good"
        assert score_to_match_status(0.7) == "Good"
        assert score_to_match_status(1.0) == "Good"

    def test_close(self):
        assert score_to_match_status(0.55) == "Close"
        assert score_to_match_status(0.4) == "Close"
        assert score_to_match_status(0.69) == "Close"

    def test_almost_bad(self):
        assert score_to_match_status(0.39) == "Almost Bad"
        assert score_to_match_status(0.0) == "Almost Bad"
        assert score_to_match_status(0.1) == "Almost Bad"

    def test_round_trip(self):
        """Status -> score -> status should be stable."""
        for status in ["Good", "Close", "Almost Bad"]:
            score = match_status_to_score(status)
            assert score_to_match_status(score) == status


class TestFilterPostings:
    def test_splits_correctly(self):
        postings = [
            {"title": "Case Manager", "employer": "Shelter"},
            {"title": "RN Case Manager", "employer": "Hospital"},
            {"title": "Social Worker", "employer": "Clinic"},
        ]
        clean, excluded = filter_postings_by_keywords(
            postings, ["RN", "hospital"]
        )
        assert len(clean) == 2
        assert clean[0]["title"] == "Case Manager"
        assert clean[1]["title"] == "Social Worker"
        assert len(excluded) == 1
        assert excluded[0]["title"] == "RN Case Manager"

    def test_no_keywords_all_clean(self):
        postings = [{"title": "Case Manager", "employer": "Shelter"}]
        clean, excluded = filter_postings_by_keywords(postings, [])
        assert len(clean) == 1
        assert len(excluded) == 0

    def test_excluded_has_reason(self):
        postings = [{"title": "RN Case Manager", "employer": "Hospital"}]
        _, excluded = filter_postings_by_keywords(postings, ["RN"])
        assert excluded[0]["_exclude_reason"] == "RN"
