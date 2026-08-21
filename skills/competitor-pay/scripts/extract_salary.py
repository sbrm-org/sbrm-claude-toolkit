"""Salary string normalization for competitor pay database.

Parses messy salary strings into normalized annual (low, high) values.
Hourly rates x 2080, monthly x 12, weekly x 52, biweekly x 26.

Returns 5-tuple: (annual_low, annual_high, salary_type, original_low, original_high)
where original_low/high are the raw parsed amounts before annualization.
"""

import re
from typing import Optional

# Magnitude thresholds for period detection when the string carries no keyword.
# HOURLY_CEILING matches crosswalk.HOURLY_CEILING deliberately: the historical
# backfill and the live extractor must not disagree about what $150 means.
HOURLY_CEILING = 200
AMBIGUOUS_CEILING = 20000


def normalize_salary(
    raw: str,
) -> tuple[Optional[float], Optional[float], str, Optional[float], Optional[float]]:
    """Parse a salary string into (annual_low, annual_high, salary_type, original_low, original_high).

    Returns:
        (low, high, type, orig_low, orig_high) where type is 'annual', 'hourly',
        'monthly', 'weekly', 'biweekly', or 'not_listed'.
        'not_listed' covers both "no pay given" and "pay given but the period is
        undeterminable"; the two are distinguishable by orig_low being set.
        low/high are always annual floats, or None if not parseable.
        orig_low/orig_high are the raw dollar amounts before annualization.
    """
    if not raw or not isinstance(raw, str):
        return (None, None, "not_listed", None, None)

    text = raw.strip().lower()

    # Quick exit for non-salary strings
    skip_patterns = [
        "doe", "d.o.e", "competitive", "negotiable", "commensurate",
        "depends on experience", "based on experience", "not listed",
        "not specified", "n/a", "tbd", "open",
    ]
    for pat in skip_patterns:
        if pat in text:
            return (None, None, "not_listed", None, None)

    # Extract all dollar amounts from the string
    amounts = _extract_amounts(text)
    if not amounts:
        return (None, None, "not_listed", None, None)

    # Determine period type
    period = _detect_period(text)

    # An undeterminable period cannot be annualized. Keep the raw figures so the
    # posting still records what it said, and report the type as "not_listed" so
    # the SharePoint push writes PayUnit "Not listed" rather than inventing one.
    if period == "unknown":
        if len(amounts) == 1:
            return (None, None, "not_listed", amounts[0], amounts[0])
        return (None, None, "not_listed",
                min(amounts[0], amounts[1]), max(amounts[0], amounts[1]))

    # Convert to annual
    multiplier = {
        "annual": 1,
        "hourly": 2080,
        "monthly": 12,
        "weekly": 52,
        "biweekly": 26,
    }.get(period, 1)

    if len(amounts) == 1:
        annual = round(amounts[0] * multiplier, 2)
        orig_low = amounts[0]
        orig_high = amounts[0]
        # "Up to X" or "to X" -> (None, X)
        if re.search(r"up\s+to|max(imum)?", text):
            low, high = None, annual
            orig_low = None
        # "From X" or "starting at X" -> (X, None)
        elif re.search(r"from|starting\s+at|minimum|at\s+least", text):
            low, high = annual, None
            orig_high = None
        else:
            low, high = annual, annual
    elif len(amounts) >= 2:
        raw_low = min(amounts[0], amounts[1])
        raw_high = max(amounts[0], amounts[1])
        low = round(raw_low * multiplier, 2)
        high = round(raw_high * multiplier, 2)
        orig_low = raw_low
        orig_high = raw_high
    else:
        return (None, None, "not_listed", None, None)

    # Sanity check: flag but still return suspicious values
    salary_type = period if period != "annual" else "annual"

    return (low, high, salary_type, orig_low, orig_high)


# Retirement plan names look exactly like abbreviated salaries: "401k" reads as
# $401,000 under the [kK] pattern below, and it matches before any real dollar
# figure is seen. Strip them before any amount extraction happens.
_RETIREMENT_TOKENS = re.compile(
    r'\b4\s?0\s?1\s?\(?\s*k\s*\)?|\b40\d\s?\(?\s*[bk]\s*\)?|\b457\s?\(?\s*b\s*\)?',
    re.IGNORECASE,
)


def _strip_retirement_tokens(text: str) -> str:
    return _RETIREMENT_TOKENS.sub(" ", text)


def _extract_amounts(text: str) -> list[float]:
    """Extract numeric dollar amounts from text."""
    text = _strip_retirement_tokens(text)
    amounts = []

    # Match patterns like: $55,000  $55K  $55.5K  55,000  55k
    pattern = r'\$?\s*([\d,]+(?:\.\d+)?)\s*[kK]'
    for m in re.finditer(pattern, text):
        val = float(m.group(1).replace(",", "")) * 1000
        amounts.append(val)

    if amounts:
        return amounts

    # Match plain dollar amounts: $55,000  $55,000.00  $22.50
    pattern = r'\$\s*([\d,]+(?:\.\d+)?)'
    for m in re.finditer(pattern, text):
        val = float(m.group(1).replace(",", ""))
        amounts.append(val)

    if amounts:
        return amounts

    # Last resort: bare numbers that look like salaries (only if $ was in original)
    if "$" not in text:
        return []

    pattern = r'([\d,]+(?:\.\d+)?)'
    for m in re.finditer(pattern, text):
        val = float(m.group(1).replace(",", ""))
        if val > 0:
            amounts.append(val)

    return amounts


def _detect_period(text: str) -> str:
    """Detect the pay period from text context."""
    hourly = r'(?:per\s+hour|/\s*h(?:ou)?r|an?\s+hour|hourly|\bhr\b)'
    if re.search(hourly, text):
        return "hourly"

    # Biweekly must be tested BEFORE weekly: "bi-weekly" contains "weekly", so
    # the weekly pattern matches it and annualizes at 52x instead of 26x.
    biweekly = r'(?:bi-?weekly|every\s+(?:two|2)\s+weeks|per\s+pay\s+period)'
    if re.search(biweekly, text):
        return "biweekly"

    weekly = r'(?:per\s+week|/\s*w(?:ee)?k|a\s+week|weekly)'
    if re.search(weekly, text):
        return "weekly"

    monthly = r'(?:per\s+month|/\s*mo(?:nth)?|a\s+month|monthly)'
    if re.search(monthly, text):
        return "monthly"

    annual = r'(?:per\s+year|/\s*y(?:ea)?r|a\s+year|annual|yearly|per\s+annum)'
    if re.search(annual, text):
        return "annual"

    # No keyword. Fall back on magnitude, but only where magnitude is actually
    # decisive.
    #
    # Under $200 is safe: nobody's ANNUAL salary is $150, and the live list bears
    # this out with 174 hourly rows spanning $16.00 to $40.19 and no annual row
    # below $53,900. This is the same threshold the historical backfill uses.
    #
    # The old rule also returned "monthly" for anything under $10,000, and that
    # was wrong. That band holds weekly, biweekly AND monthly figures, so
    # "monthly" was one guess out of three recorded as fact. A real example: the
    # Indeed connector returns "$2,826 a week", which the old rule annualized at
    # x12 to $33,912 instead of x52 to $146,952, and would now write to
    # SharePoint as PayUnit "Monthly". A wrong unit in a column HR sorts and
    # averages on is worse than an absent one, so say "unknown" instead.
    amounts = _extract_amounts(text)
    if amounts:
        avg = sum(amounts) / len(amounts)
        if avg < HOURLY_CEILING:
            return "hourly"
        if avg < AMBIGUOUS_CEILING:
            return "unknown"

    return "annual"
