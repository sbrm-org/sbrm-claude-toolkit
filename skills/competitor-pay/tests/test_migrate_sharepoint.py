"""Tests for the migration's write-safety helpers.

These guard the three ways this migration could quietly corrupt HR's list:
a scalar write dropping a second label, a forbidden write to `JobPosting`, and
a read-back compare that returns "matched" when it did not.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from migrate_sharepoint import (  # noqa: E402
    _assert_no_forbidden,
    _matches,
    _patch_body,
    _url_of,
)


class TestPatchBody:
    def test_multi_select_gets_the_odata_annotation(self):
        body = _patch_body({"SBRMEquivalent": ["Shelter Operator", "Residential Coordinator"]})
        fields = body["body"]["fields"]
        assert fields["SBRMEquivalent@odata.type"] == "Collection(Edm.String)"
        assert fields["SBRMEquivalent"] == ["Shelter Operator", "Residential Coordinator"]

    def test_single_label_still_goes_as_an_array(self):
        """A one-element list must stay a list, or the column type is wrong."""
        body = _patch_body({"SBRMEquivalent": ["Custodian"]})
        fields = body["body"]["fields"]
        assert fields["SBRMEquivalent"] == ["Custodian"]
        assert "SBRMEquivalent@odata.type" in fields

    def test_scalars_are_not_annotated(self):
        fields = _patch_body({"PayUnit": "Hourly"})["body"]["fields"]
        assert fields == {"PayUnit": "Hourly"}

    def test_fields_are_nested_under_body(self):
        body = _patch_body({"Source": "Indeed"})
        assert set(body) == {"body"}
        assert set(body["body"]) == {"fields"}

    def test_mixed_payload(self):
        fields = _patch_body({
            "PayUnit": "Annual",
            "SBRMEquivalent": ["Market Reference - No SBRM Equivalent"],
            "Credential": "N/A",
        })["body"]["fields"]
        assert fields["PayUnit"] == "Annual"
        assert fields["Credential"] == "N/A"
        assert fields["SBRMEquivalent@odata.type"] == "Collection(Edm.String)"


class TestForbiddenFields:
    def test_jobposting_is_refused(self):
        plan = [{"id": "1", "changes": {"JobPosting": {"Url": "https://x"}}, "flags": []}]
        with pytest.raises(SystemExit):
            _assert_no_forbidden(plan)

    def test_jobposting_refused_even_alongside_valid_fields(self):
        plan = [{"id": "1", "changes": {"PayUnit": "Hourly", "JobPosting": "x"}, "flags": []}]
        with pytest.raises(SystemExit):
            _assert_no_forbidden(plan)

    def test_clean_plan_passes(self):
        plan = [{"id": "1", "changes": {"PayUnit": "Hourly", "Source": "Indeed"}, "flags": []}]
        _assert_no_forbidden(plan)

    def test_url_column_is_allowed(self):
        """`URL` is writable; only the `JobPosting` hyperlink column is not."""
        _assert_no_forbidden([{"id": "1", "changes": {"URL": "https://x"}, "flags": []}])


class TestReadBackCompare:
    def test_scalar_match(self):
        assert _matches("Hourly", "Hourly")
        assert not _matches("Hourly", "Annual")

    def test_silently_discarded_value_is_a_mismatch(self):
        """The JobPosting failure mode: 200 OK, field still null."""
        assert not _matches("Hourly", None)
        assert not _matches(["Custodian"], None)

    def test_array_order_does_not_matter(self):
        assert _matches(["A", "B"], ["B", "A"])

    def test_dropped_second_label_is_caught(self):
        """The exact corruption a scalar write would cause on 16 rows."""
        assert not _matches(["Shelter Operator", "Residential Coordinator"],
                            ["Shelter Operator"])

    def test_extra_stored_label_is_caught(self):
        assert not _matches(["Custodian"], ["Custodian", "Manager"])

    def test_empty_array_vs_value(self):
        assert not _matches(["Custodian"], [])

    def test_numeric_tolerance(self):
        assert _matches(18.0, "18")
        assert _matches(18, 18.0)
        assert not _matches(18, "19")

    def test_non_numeric_stored_against_numeric_expected(self):
        assert not _matches(18.0, "n/a")


class TestUrlExtraction:
    def test_reads_jobposting_even_though_it_is_not_writable(self):
        urls = _url_of({"JobPosting": {"Url": "https://indeed.com/x"}})
        assert urls == ["https://indeed.com/x"]

    def test_reads_both_link_columns(self):
        urls = _url_of({"JobPosting": {"Url": "https://a"}, "URL": "https://b"})
        assert urls == ["https://a", "https://b"]

    def test_string_jobposting(self):
        assert _url_of({"JobPosting": "https://a"}) == ["https://a"]

    def test_no_links(self):
        assert _url_of({"Title": "x"}) == []


class TestSchemaBlockerScope:
    """The live schema check must demand only the values actually written.

    Medium-confidence crosswalk rows carry a guessed role, but those rows go to
    model judgment and the guess never reaches SharePoint. Requiring them as
    column choices would block the migration on a value nothing writes.
    """

    def test_judgment_only_guesses_are_not_required_choices(self):
        from crosswalk import CROSSWALK, MECHANICAL
        mech = {r[0] for r in CROSSWALK.values() if r[0] and r[2] in MECHANICAL}
        assert "Program Manager" not in mech
        assert "Program Manager - Treatment Services" not in mech

    def test_every_mechanical_target_is_a_real_canonical_role(self):
        """A mechanical target with no home in roles.json would be written as
        fill-in text and recreate the drift this migration removes."""
        import json
        from pathlib import Path
        from crosswalk import CROSSWALK, MARKET_REFERENCE, MECHANICAL
        roles = json.loads(
            (Path(__file__).parent.parent / "roles" / "roles.json").read_text())
        allowed = ({r["title"] for r in roles["roles"]}
                   | {c["value"] for c in roles["sbrm_equivalent_extra_choices"]})
        mech = {r[0] for r in CROSSWALK.values()
                if r[0] and r[2] in MECHANICAL} | {MARKET_REFERENCE}
        assert not (mech - allowed), sorted(mech - allowed)


class TestMultiSelectDetection:
    """Graph does not expose a `multipleValues` flag on choice columns.

    An earlier version of this check looked for one, never found it, and
    reported the live SBRM Equivalent column as single-select. Acting on that
    would have meant scalar writes, destroying the second label on 16 rows.
    SharePoint renders multi-choice as check boxes, so `displayAs` is the signal
    that is actually in the payload.
    """

    def test_checkboxes_means_multi_select(self):
        from migrate_sharepoint import _is_multi_select
        assert _is_multi_select({"choice": {"displayAs": "checkBoxes"}})

    def test_dropdown_is_single_select(self):
        from migrate_sharepoint import _is_multi_select
        assert not _is_multi_select({"choice": {"displayAs": "dropDownMenu"}})

    def test_the_live_sbrm_equivalent_shape_reads_as_multi(self):
        """Verbatim shape returned by Graph for this list on 2026-08-21."""
        from migrate_sharepoint import _is_multi_select
        live = {
            "displayName": "SBRM Equivalent", "name": "SBRMEquivalent",
            "choice": {"allowTextEntry": True, "displayAs": "checkBoxes",
                       "choices": ["Custodian", "Manager"]},
        }
        assert _is_multi_select(live)

    def test_explicit_flag_still_honoured_when_present(self):
        from migrate_sharepoint import _is_multi_select
        assert _is_multi_select({"multipleValues": True})
        assert _is_multi_select({"allowMultipleValues": True})

    def test_absent_choice_block_does_not_crash(self):
        from migrate_sharepoint import _is_multi_select
        assert not _is_multi_select({})
