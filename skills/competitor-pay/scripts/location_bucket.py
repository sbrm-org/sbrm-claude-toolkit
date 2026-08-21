"""Location bucketing for competitor pay database.

Categorizes job locations into:
- "Santa Barbara County"
- "Ventura County"
- "Other California"
- "Remote"
- "Out of State" (excluded from analysis by default)
- "Unknown"
"""

import re
from typing import Optional

# Santa Barbara County cities and communities
SB_COUNTY_PLACES = {
    "santa barbara", "goleta", "carpinteria", "lompoc", "santa maria",
    "solvang", "buellton", "guadalupe", "santa ynez", "montecito",
    "summerland", "isla vista", "los olivos", "orcutt", "vandenberg",
    "gaviota", "los alamos", "new cuyama", "casmalia", "nipomo",
    "arroyo grande",  # border area, included for broader coverage
    "sb county", "santa barbara county",
}

# Ventura County cities and communities
VENTURA_COUNTY_PLACES = {
    "ventura", "oxnard", "thousand oaks", "simi valley", "camarillo",
    "moorpark", "ojai", "fillmore", "santa paula", "port hueneme",
    "newbury park", "westlake village", "agoura hills", "oak park",
    "somis", "piru", "saticoy", "meiners oaks",
    "ventura county",
}

# Ventura County zip codes (non-overlapping with SB County)
# 93001-93009: Ventura city
# 93010-93012: Camarillo
# 93015-93016: Fillmore
# 93020-93024: Moorpark, Ojai, etc.
# 93030-93036: Oxnard
# 93040-93044: Santa Paula, Simi Valley, Somis
# 93060-93066: Santa Paula, Saticoy, Somis, Simi Valley
# 91320, 91360-91362: Thousand Oaks
VENTURA_ZIPS_EXACT = {"91320", "91360", "91361", "91362"}

# Remote work indicators
REMOTE_INDICATORS = {
    "remote", "work from home", "anywhere", "telecommute", "wfh",
    "virtual", "distributed", "work remotely", "fully remote",
    "100% remote",
}

# California state indicators (used when city isn't in SB/Ventura County)
CA_INDICATORS = {
    "california", ", ca", ",ca", " ca ", " ca,",
}

# Map our bucket names to SharePoint Location choice values
SHAREPOINT_LOCATION_MAP = {
    "Santa Barbara County": "SB County",
    "Ventura County": "Ventura County",
    "Other California": "Other CA",
    # These don't have SharePoint equivalents — skip when pushing
    "Remote": None,
    "Out of State": None,
    "Unknown": None,
}


def bucket_location(location_raw: Optional[str]) -> str:
    """Categorize a location string into one of the standard buckets.

    Args:
        location_raw: Raw location string from job posting

    Returns:
        One of: "Santa Barbara County", "Ventura County", "Other California",
        "Remote", "Out of State", "Unknown"
    """
    if not location_raw or not isinstance(location_raw, str):
        return "Unknown"

    text = location_raw.strip().lower()

    if not text:
        return "Unknown"

    # Check for remote first
    for indicator in REMOTE_INDICATORS:
        if indicator in text:
            # "Hybrid remote in Santa Barbara" -> SB County, not Remote
            if _mentions_sb_county(text):
                return "Santa Barbara County"
            if _mentions_ventura_county(text):
                return "Ventura County"
            return "Remote"

    # Check for Santa Barbara County (before Ventura to handle 931xx overlap)
    if _mentions_sb_county(text):
        return "Santa Barbara County"

    # Check for Ventura County
    if _mentions_ventura_county(text):
        return "Ventura County"

    # Check for California
    if _is_california(text):
        return "Other California"

    # Check for US states (not CA) -> Out of State
    if _has_us_state(text):
        return "Out of State"

    # "United States" with no state -> probably Remote
    if "united states" in text or text == "us" or text == "usa":
        return "Remote"

    return "Unknown"


def to_sharepoint_location(bucket: str) -> Optional[str]:
    """Map our bucket name to the SharePoint Location choice value.

    Returns None if the bucket has no SharePoint equivalent.
    """
    return SHAREPOINT_LOCATION_MAP.get(bucket)


def _mentions_sb_county(text: str) -> bool:
    """Check if text mentions a Santa Barbara County location."""
    for place in SB_COUNTY_PLACES:
        if place in text:
            return True
    # SB County zips: 931xx and 934xx ranges
    if re.search(r'\b93[14]\d{2}\b', text):
        return True
    return False


def _mentions_ventura_county(text: str) -> bool:
    """Check if text mentions a Ventura County location."""
    for place in VENTURA_COUNTY_PLACES:
        if place in text:
            return True
    # Check exact Ventura County zips (Thousand Oaks area)
    for z in VENTURA_ZIPS_EXACT:
        if z in text:
            return True
    # Ventura County zips: 930xx range (NOT 931xx, that's SB County)
    # 93001-93009, 93010-93066 — but only if NOT already matched SB
    if re.search(r'\b930[0-6]\d\b', text):
        return True
    return False


def _is_california(text: str) -> bool:
    """Check if text indicates California."""
    for indicator in CA_INDICATORS:
        if indicator in text:
            return True
    # Check for CA zip codes (9xxxx range, but not all)
    if re.search(r'\b9[0-6]\d{3}\b', text):
        return True
    return False


# Common US state abbreviations (excluding CA)
_US_STATES = {
    "al", "ak", "az", "ar", "co", "ct", "de", "fl", "ga", "hi",
    "id", "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma",
    "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm",
    "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd",
    "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
}


def _has_us_state(text: str) -> bool:
    """Check if text contains a non-CA US state abbreviation."""
    # Look for ", XX" or " XX " patterns where XX is a state
    match = re.search(r'[,\s]\s*([a-z]{2})\s*(?:\d{5})?$', text)
    if match and match.group(1) in _US_STATES:
        return True
    # Also check for full state names of common ones
    other_states = [
        "oregon", "washington", "nevada", "arizona", "texas",
        "new york", "florida", "colorado", "illinois",
    ]
    for state in other_states:
        if state in text:
            return True
    return False
