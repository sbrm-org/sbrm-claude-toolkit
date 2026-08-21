"""Tests for the historical-row migration logic.

These cover the two rules that touch HR's live list — the PayUnit backfill and
the role crosswalk — plus the multi-select handling that is the easiest way to
silently destroy data on the 16 dual-labelled rows.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from crosswalk import (  # noqa: E402
    CRED_LICENSED,
    CRED_NA,
    CRED_NOT_REQUIRED,
    CM_UNLICENSED_TS,
    CROSSWALK,
    EXPECTED_LABEL_INSTANCES,
    JUDGMENT,
    MARKET_REFERENCE,
    MECHANICAL,
    UnknownLabel,
    classify_label,
    classify_row_labels,
    pay_unit_for,
    source_for_url,
)


class TestPayUnitBackfill:
    def test_typical_hourly(self):
        assert pay_unit_for(17) == "Hourly"
        assert pay_unit_for(16.00) == "Hourly"
        assert pay_unit_for(40.19) == "Hourly"

    def test_typical_annual(self):
        assert pay_unit_for(53900) == "Annual"
        assert pay_unit_for(110000) == "Annual"

    def test_boundaries(self):
        assert pay_unit_for(199.99) == "Hourly"
        assert pay_unit_for(200) is None
        assert pay_unit_for(19999) is None
        assert pay_unit_for(20000) == "Annual"

    def test_middle_band_is_review_not_a_guess(self):
        """A weekly rate lands here. Guessing either way misreads it badly."""
        assert pay_unit_for(2000) is None
        assert pay_unit_for(2826) is None

    def test_missing_pay_is_never_defaulted(self):
        assert pay_unit_for(None) is None
        assert pay_unit_for("") is None
        assert pay_unit_for(0) is None

    def test_numeric_strings_parse(self):
        assert pay_unit_for("17.50") == "Hourly"
        assert pay_unit_for("65000") == "Annual"

    def test_garbage_is_review_not_a_crash(self):
        assert pay_unit_for("n/a") is None
        assert pay_unit_for(object()) is None

    def test_negative_is_review(self):
        assert pay_unit_for(-5) is None


class TestCrosswalkTable:
    def test_matches_the_live_census(self):
        """37 labels, 216 instances. Drift means the list changed under us."""
        assert len(CROSSWALK) == 37
        assert sum(row[3] for row in CROSSWALK.values()) == EXPECTED_LABEL_INSTANCES

    def test_every_confidence_is_known(self):
        for label, (_role, _cred, confidence, _n) in CROSSWALK.items():
            assert confidence in MECHANICAL | JUDGMENT, label

    def test_judgment_rows_carry_no_mechanical_role(self):
        """A REVIEW row must not smuggle in a default the model never saw."""
        for label, (role, _cred, confidence, _n) in CROSSWALK.items():
            if confidence == "REVIEW":
                assert role is None, label

    def test_mechanical_rows_all_resolve(self):
        for label, (role, _cred, confidence, _n) in CROSSWALK.items():
            if confidence in MECHANICAL:
                assert role, label


class TestClassifyLabel:
    def test_exact_passthrough(self):
        role, cred, conf, needs = classify_label("Custodian")
        assert (role, cred, conf, needs) == ("Custodian", CRED_NA, "exact", False)

    def test_decided_rename_of_the_unlicensed_tier(self):
        role, cred, _conf, needs = classify_label("RTS no license")
        assert role == CM_UNLICENSED_TS
        assert cred == CRED_NOT_REQUIRED
        assert needs is False

    def test_licensed_counterpart(self):
        role, cred, _conf, _needs = classify_label("RTS with license")
        assert role == "Case Manager - Treatment Services"
        assert cred == CRED_LICENSED

    def test_program_tech_and_tech_both_retire_into_residential_coordinator(self):
        for label in ("Program Tech", "Tech"):
            role, cred, _conf, needs = classify_label(label)
            assert role == "Residential Coordinator", label
            assert cred == CRED_NOT_REQUIRED, label
            assert needs is False, label

    def test_the_four_homeless_labels_become_market_reference(self):
        for label in ("Development Director", "Director",
                      "Director of Development and Constituent Relations",
                      "Clinical Supervisor"):
            role, _cred, _conf, needs = classify_label(label)
            assert role == MARKET_REFERENCE, label
            assert needs is False, label

    def test_clinical_supervisor_keeps_its_licence_signal(self):
        _role, cred, _conf, _needs = classify_label("Clinical Supervisor")
        assert cred == CRED_LICENSED

    def test_case_manager_goes_to_judgment(self):
        role, _cred, conf, needs = classify_label("Case Manager")
        assert needs is True
        assert conf == "REVIEW"
        assert role is None

    def test_program_director_goes_to_judgment(self):
        _role, _cred, _conf, needs = classify_label("Program Director")
        assert needs is True

    def test_medium_rows_go_to_judgment(self):
        for label in ("HR Manager", "Treatment Program Manager", "Program Manager",
                      "Finance and Data Associate", "Shelter Manager", "Facilities"):
            _role, _cred, _conf, needs = classify_label(label)
            assert needs is True, label

    def test_whitespace_tolerated(self):
        assert classify_label("  Custodian  ")[0] == "Custodian"

    def test_unknown_label_raises_rather_than_defaulting(self):
        with pytest.raises(UnknownLabel):
            classify_label("Grant Writer")
        with pytest.raises(UnknownLabel):
            classify_label("")


class TestMultiSelectRows:
    def test_single_label_row(self):
        out = classify_row_labels(["Custodian"])
        assert out["canonical"] == ["Custodian"]
        assert out["needs_judgment"] is False
        assert out["empty"] is False

    def test_dual_label_row_keeps_both(self):
        """Item 1 on the live list. Dropping either half loses real signal."""
        out = classify_row_labels(["Shelter Operator", "Program Tech"])
        assert out["canonical"] == ["Shelter Operator", "Residential Coordinator"]
        assert out["needs_judgment"] is False

    def test_dual_label_row_item_50(self):
        out = classify_row_labels(["Tech", "RTS no license"])
        assert out["canonical"] == ["Residential Coordinator", CM_UNLICENSED_TS]
        assert out["credential"] == CRED_NOT_REQUIRED

    def test_dual_labels_collapsing_to_one_role_deduplicate(self):
        out = classify_row_labels(["Shelter Operator", "Shelter Operations"])
        assert out["canonical"] == ["Shelter Operator"]

    def test_licence_signal_wins_over_na(self):
        out = classify_row_labels(["RTS with license", "Shelter Operator"])
        assert out["credential"] == CRED_LICENSED

    def test_not_required_beats_na(self):
        out = classify_row_labels(["Program Tech", "Shelter Operator"])
        assert out["credential"] == CRED_NOT_REQUIRED

    def test_empty_row_is_flagged_not_defaulted(self):
        """Items 43 and 57 carry no label at all."""
        out = classify_row_labels([])
        assert out["empty"] is True
        assert out["needs_judgment"] is True
        assert out["canonical"] == []

    def test_none_is_treated_as_empty(self):
        assert classify_row_labels(None)["empty"] is True

    def test_blank_strings_are_not_labels(self):
        assert classify_row_labels(["", "   "])["empty"] is True

    def test_mixed_mechanical_and_judgment_row(self):
        """The mechanical half resolves; the row still goes to the model."""
        out = classify_row_labels(["Custodian", "Case Manager"])
        assert out["canonical"] == ["Custodian"]
        assert out["needs_judgment"] is True
        assert out["judgment_labels"] == ["Case Manager"]

    def test_unknown_label_is_surfaced(self):
        out = classify_row_labels(["Custodian", "Grant Writer"])
        assert out["unknown"] == ["Grant Writer"]
        assert out["canonical"] == ["Custodian"]


class TestSourceBackfill:
    def test_board_domains(self):
        assert source_for_url("https://www.indeed.com/viewjob?jk=abc") == "Indeed"
        assert source_for_url("https://linkedin.com/jobs/view/123") == "LinkedIn"
        assert source_for_url("https://www.ziprecruiter.com/c/x/Job/y") == "ZipRecruiter"
        assert source_for_url("https://www.glassdoor.com/job-listing/x") == "Glassdoor"
        assert source_for_url("https://app.joinhandshake.com/jobs/1") == "Handshake"

    def test_case_insensitive(self):
        assert source_for_url("HTTPS://WWW.INDEED.COM/viewjob?jk=1") == "Indeed"

    def test_org_career_page_is_left_blank(self):
        """A hand-entered 2023 org link is not evidence of a scraper run."""
        assert source_for_url("https://goodsamaritanshelter.org/careers") is None
        assert source_for_url("https://www.sbcity.org/jobs") is None

    def test_missing_url(self):
        assert source_for_url(None) is None
        assert source_for_url("") is None
        assert source_for_url("   ") is None
