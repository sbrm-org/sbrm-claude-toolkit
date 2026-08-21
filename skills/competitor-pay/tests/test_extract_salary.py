"""Tests for salary normalization."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from extract_salary import normalize_salary, _detect_period


class TestBasicAnnual:
    def test_range(self):
        low, high, t, orig_low, orig_high = normalize_salary("$45,000 - $55,000 a year")
        assert (low, high, t) == (45000, 55000, "annual")
        assert orig_low == 45000 and orig_high == 55000

    def test_range_no_spaces(self):
        low, high, t, orig_low, orig_high = normalize_salary("$45,000-$55,000")
        assert (low, high, t) == (45000, 55000, "annual")

    def test_single_value(self):
        low, high, t, orig_low, orig_high = normalize_salary("$60,000")
        assert low == 60000 and high == 60000
        assert orig_low == 60000 and orig_high == 60000

    def test_k_suffix(self):
        low, high, t, orig_low, orig_high = normalize_salary("$55K-$65K")
        assert (low, high, t) == (55000, 65000, "annual")

    def test_k_suffix_lower(self):
        low, high, t, orig_low, orig_high = normalize_salary("$55k - $65k a year")
        assert (low, high, t) == (55000, 65000, "annual")

    def test_up_to(self):
        low, high, t, orig_low, orig_high = normalize_salary("Up to $60,000")
        assert low is None and high == 60000
        assert orig_low is None and orig_high == 60000

    def test_from(self):
        low, high, t, orig_low, orig_high = normalize_salary("From $40,000")
        assert low == 40000 and high is None
        assert orig_low == 40000 and orig_high is None

    def test_starting_at(self):
        low, high, t, orig_low, orig_high = normalize_salary("Starting at $50,000")
        assert low == 50000 and high is None


class TestHourly:
    def test_range_per_hour(self):
        low, high, t, orig_low, orig_high = normalize_salary("$22 - $28 per hour")
        assert t == "hourly"
        assert low == 22 * 2080
        assert high == 28 * 2080
        assert orig_low == 22.0 and orig_high == 28.0

    def test_range_an_hour(self):
        low, high, t, orig_low, orig_high = normalize_salary("$22 - $28 an hour")
        assert low == 22 * 2080

    def test_range_slash_hr(self):
        low, high, t, orig_low, orig_high = normalize_salary("$18.50-$22.00/hr")
        assert t == "hourly"
        assert low == 18.50 * 2080
        assert high == 22.00 * 2080
        assert orig_low == 18.50 and orig_high == 22.00

    def test_single_hourly(self):
        low, high, t, orig_low, orig_high = normalize_salary("$24.00 per hour")
        assert low == 24.00 * 2080
        assert high == 24.00 * 2080
        assert orig_low == 24.00 and orig_high == 24.00

    def test_hourly_keyword(self):
        low, high, t, orig_low, orig_high = normalize_salary("$22.00 - $28.00 hourly")
        assert t == "hourly"


class TestMonthly:
    def test_per_month(self):
        low, high, t, orig_low, orig_high = normalize_salary("$3,800/month")
        assert low == 3800 * 12
        assert high == 3800 * 12
        assert t == "monthly"
        assert orig_low == 3800 and orig_high == 3800

    def test_a_month(self):
        low, high, t, orig_low, orig_high = normalize_salary("$4,500 a month")
        assert low == 4500 * 12


class TestWeekly:
    def test_per_week(self):
        low, high, t, orig_low, orig_high = normalize_salary("$3,000 - $3,060 a week")
        assert t == "weekly"
        assert low == 3000 * 52
        assert high == 3060 * 52
        assert orig_low == 3000 and orig_high == 3060


class TestNotListed:
    def test_doe(self):
        assert normalize_salary("DOE") == (None, None, "not_listed", None, None)

    def test_competitive(self):
        assert normalize_salary("Competitive salary") == (None, None, "not_listed", None, None)

    def test_negotiable(self):
        assert normalize_salary("Negotiable") == (None, None, "not_listed", None, None)

    def test_empty(self):
        assert normalize_salary("") == (None, None, "not_listed", None, None)

    def test_none(self):
        assert normalize_salary(None) == (None, None, "not_listed", None, None)

    def test_tbd(self):
        assert normalize_salary("TBD") == (None, None, "not_listed", None, None)


class TestEdgeCases:
    def test_with_benefits_text(self):
        low, high, t, orig_low, orig_high = normalize_salary("$55,000 - $65,000 a year plus benefits")
        assert low == 55000 and high == 65000

    def test_indeed_format(self):
        """Indeed MCP returns salary like this."""
        low, high, t, orig_low, orig_high = normalize_salary("$60.63 - $92.46 an hour")
        assert t == "hourly"
        assert abs(low - 60.63 * 2080) < 1
        assert abs(high - 92.46 * 2080) < 1
        assert abs(orig_low - 60.63) < 0.01
        assert abs(orig_high - 92.46) < 0.01

    def test_indeed_annual_format(self):
        low, high, t, orig_low, orig_high = normalize_salary("$90,986.61 - $126,382.74 a year")
        assert abs(low - 90986.61) < 1
        assert abs(high - 126382.74) < 1
        assert abs(orig_low - 90986.61) < 1
        assert abs(orig_high - 126382.74) < 1


class TestOriginalRates:
    """Test that original rates are preserved correctly for SharePoint."""

    def test_hourly_original_preserved(self):
        """SharePoint needs $22/hr, not $45,760."""
        _, _, _, orig_low, orig_high = normalize_salary("$22 - $26 per hour")
        assert orig_low == 22.0
        assert orig_high == 26.0

    def test_annual_original_same(self):
        """Annual: original == annualized."""
        low, high, _, orig_low, orig_high = normalize_salary("$50,000 - $60,000 a year")
        assert orig_low == 50000 and orig_high == 60000
        assert low == orig_low and high == orig_high

    def test_monthly_original_preserved(self):
        _, _, _, orig_low, orig_high = normalize_salary("$4,000 - $5,000 per month")
        assert orig_low == 4000 and orig_high == 5000


# --- v0.3.0 regression tests -------------------------------------------------

def test_401k_is_not_a_salary():
    """Retirement plan names must never be read as pay amounts.

    Reproduced live in v0.2.0: '$20 - $25 an hour plus 401k match' returned
    $834,080,000 because the [kK] pattern matched '401k' as $401,000 and
    returned before the real dollar amounts were seen.
    """
    low, high, stype, olow, ohigh = normalize_salary(
        "$20 - $25 an hour plus 401k match")
    assert (olow, ohigh) == (20.0, 25.0)
    assert stype == "hourly"
    assert (low, high) == (41600.0, 52000.0)


def test_other_retirement_plan_tokens_ignored():
    for text, expected in [
        ("$22/hr, 403b available", (22.0, 22.0)),
        ("$30 an hour with 457b plan", (30.0, 30.0)),
        ("$25/hr plus 401(k) match", (25.0, 25.0)),
        ("$18-$20 an hour, 401K after 90 days", (18.0, 20.0)),
    ]:
        _, _, _, olow, ohigh = normalize_salary(text)
        assert (olow, ohigh) == expected, text


def test_real_k_suffix_salaries_still_parse():
    """The fix must not break legitimate $55K style amounts."""
    low, high, stype, _, _ = normalize_salary("$55K - $65K per year")
    assert (low, high) == (55000.0, 65000.0)
    assert stype == "annual"


def test_biweekly_is_not_read_as_weekly():
    """'bi-weekly' contains 'weekly'; the weekly check ran first and won,
    annualizing at 52x instead of 26x — a clean 2x overstatement."""
    assert _detect_period("$2,000 bi-weekly") == "biweekly"
    assert _detect_period("$2,000 biweekly") == "biweekly"
    assert _detect_period("paid every two weeks") == "biweekly"
    assert _detect_period("$1,000 per week") == "weekly"


def test_biweekly_annualizes_at_26x():
    low, high, stype, _, _ = normalize_salary("$2,000 bi-weekly")
    assert stype == "biweekly"
    assert low == 52000.0


class TestAmbiguousPeriodIsNotGuessed:
    """Defect 8: the old rule read anything under $10,000 with no keyword as
    monthly, and recorded that guess as fact. That band holds weekly, biweekly
    and monthly figures, and the result feeds PayUnit on a list HR sorts on."""

    def test_the_indeed_weekly_case(self):
        """'$2,826 a week' with the keyword stripped must not become monthly."""
        assert _detect_period("$2,826") == "unknown"

    def test_ambiguous_band_returns_unknown(self):
        for text in ("$2,000", "$4,500", "$1,200", "$9,999"):
            assert _detect_period(text) == "unknown", text

    def test_keywords_still_win_over_magnitude(self):
        assert _detect_period("$2,826 a week") == "weekly"
        assert _detect_period("$2,000 bi-weekly") == "biweekly"
        assert _detect_period("$4,500 a month") == "monthly"

    def test_small_values_are_still_confidently_hourly(self):
        assert _detect_period("$17.50") == "hourly"
        assert _detect_period("$40") == "hourly"

    def test_large_values_are_still_confidently_annual(self):
        assert _detect_period("$65,000") == "annual"
        assert _detect_period("$110,000 - $125,000") == "annual"

    def test_unknown_period_refuses_to_annualize(self):
        low, high, t, orig_low, orig_high = normalize_salary("$2,826")
        assert t == "not_listed"
        assert low is None and high is None
        assert orig_low == 2826 and orig_high == 2826

    def test_unknown_period_preserves_a_range(self):
        low, high, t, orig_low, orig_high = normalize_salary("$2,000 - $2,500")
        assert t == "not_listed"
        assert (low, high) == (None, None)
        assert orig_low == 2000 and orig_high == 2500

    def test_no_pay_at_all_is_distinguishable_from_unknown_period(self):
        """Both report not_listed; only the undeterminable one keeps figures."""
        _, _, t_none, orig_none, _ = normalize_salary("competitive")
        _, _, t_unk, orig_unk, _ = normalize_salary("$2,826")
        assert t_none == t_unk == "not_listed"
        assert orig_none is None
        assert orig_unk == 2826

    def test_threshold_agrees_with_the_historical_backfill(self):
        """extract_salary and crosswalk must not disagree about what $150 is."""
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
        from crosswalk import HOURLY_CEILING as BACKFILL_CEILING
        from extract_salary import HOURLY_CEILING as EXTRACT_CEILING
        assert BACKFILL_CEILING == EXTRACT_CEILING
