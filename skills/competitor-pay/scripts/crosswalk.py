#!/usr/bin/env python3
"""Migration logic for the 202 historical `Competitor's Pay` rows.

Pure functions only. No network, no database, no SharePoint. Everything here is
decided from the row's own fields, so it can be tested exhaustively before it is
allowed near HR's live list. `migrate_sharepoint.py` is the I/O half.

Source of truth for every mapping below:
`~/Claude/claude/03 Working/compost/2026-08-14T1500-competitor-pay-v3/REMEDIATION.md`
(the crosswalk table, the PayUnit backfill rule, and Tim's 2026-08-17 decisions).

Two things here are deliberately NOT automated:

1. Rows whose label is `medium` or `REVIEW` confidence. Tim's 2026-08-17
   decision replaced the drafted keyword-and-employer scheme with model
   judgment: the model reads Title, Organization, Notes and the Job Posting
   link and classifies. This module marks those rows MANUAL and hands them out;
   it does not guess.
2. Anything the crosswalk does not know. An unrecognised label is an error to
   surface, never a row to skip silently.
"""

# --- PayUnit backfill ----------------------------------------------------

# REMEDIATION Problem 1. Applied to the `Low/Only` column. The gap between the
# two buckets is wide and empty today (174 rows under $200, 28 rows over
# $20,000, nothing between), which is the only reason a threshold rule is safe.
# It is not safe forever: the Indeed connector returns weekly rates, so the
# middle band exists to catch them rather than silently mislabel them.
HOURLY_CEILING = 200
ANNUAL_FLOOR = 20000

PAY_UNIT_HOURLY = "Hourly"
PAY_UNIT_ANNUAL = "Annual"


def pay_unit_for(low_only):
    """Return the PayUnit for a historical row, or None if it needs a human.

    None means "in the ambiguous middle band, or no pay recorded" — both are
    review cases, never a default. Returning "Hourly" for a blank would invent
    a fact about a row that has no pay data at all.
    """
    if low_only is None:
        return None
    try:
        value = float(low_only)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    if value < HOURLY_CEILING:
        return PAY_UNIT_HOURLY
    if value >= ANNUAL_FLOOR:
        return PAY_UNIT_ANNUAL
    return None


# --- Credential ----------------------------------------------------------

CRED_LICENSED = "Licensed / Certified"
CRED_NOT_REQUIRED = "Not required"
CRED_NA = "N/A"


# --- Role crosswalk ------------------------------------------------------

MARKET_REFERENCE = "Market Reference - No SBRM Equivalent"
CM_UNLICENSED_TS = "Case Manager Unlicensed - Treatment Services"

# Confidence values carried straight from REMEDIATION's table.
#   exact   -> already a canonical value
#   high    -> unambiguous synonym
#   DECIDED -> Tim ruled on it 2026-08-17
#   medium  -> was my hand-assignment from the label alone
#   REVIEW  -> always meant for a human/model to read the row
#
# `exact`, `high` and `DECIDED` are applied mechanically.
# `medium` and `REVIEW` are routed to model judgment. Tim's decision was
# explicit that this applies to the whole crosswalk, not just `Case Manager`:
# the model reading the actual row beats a hand-assignment from the label.
MECHANICAL = frozenset({"exact", "high", "DECIDED"})
JUDGMENT = frozenset({"medium", "REVIEW"})

# label -> (canonical role, credential, confidence, instance count as counted
#           on the live list 2026-08-14)
CROSSWALK = {
    "Case Manager":                                      (None,                                    CRED_NA,           "REVIEW",  46),
    "RTS with license":                                  ("Case Manager - Treatment Services",     CRED_LICENSED,     "high",    20),
    "RTS no license":                                    (CM_UNLICENSED_TS,                        CRED_NOT_REQUIRED, "DECIDED", 16),
    "Shelter Operator":                                  ("Shelter Operator",                      CRED_NA,           "exact",   13),
    "HGS Case Manager":                                  ("Case Manager - Homeless Services",      CRED_NA,           "high",    13),
    "Shelter Operations":                                ("Shelter Operator",                      CRED_NA,           "high",    12),
    "Program Director":                                  (None,                                    CRED_NA,           "REVIEW",   9),
    "Receptionist":                                      ("Front Office Coordinator",              CRED_NA,           "high",     9),
    "Custodian":                                         ("Custodian",                             CRED_NA,           "exact",    8),
    "Program Tech":                                      ("Residential Coordinator",               CRED_NOT_REQUIRED, "DECIDED",  7),
    "Night Security":                                    ("Night Security",                        CRED_NA,           "exact",    7),
    "Administrative Associate":                          ("Associate - Administration",            CRED_NA,           "high",     7),
    "Tech":                                              ("Residential Coordinator",               CRED_NOT_REQUIRED, "DECIDED",  6),
    "Operations Associate":                              ("Associate - Administration",            CRED_NA,           "high",     6),
    "Residential Coordinator":                           ("Residential Coordinator",               CRED_NA,           "exact",    4),
    "Food Services Supervisor":                          ("Food Services Supervisor",              CRED_NA,           "exact",    3),
    "Manager":                                           ("Manager",                               CRED_NA,           "exact",    3),
    "HR Manager":                                        ("Manager",                               CRED_NA,           "medium",   2),
    "Database Coordinator":                              ("Database Coordinator",                  CRED_NA,           "exact",    2),
    "Development Director":                              (MARKET_REFERENCE,                        CRED_NA,           "DECIDED",  2),
    "Director":                                          (MARKET_REFERENCE,                        CRED_NA,           "DECIDED",  2),
    "Recovery Case Manager":                             ("Case Manager - Treatment Services",     CRED_NA,           "high",     2),
    "Treatment Program Manager":                         ("Program Manager - Treatment Services",  CRED_NA,           "medium",   2),
    "Program Director - Treatment Services":             ("Program Director - Treatment Services", CRED_NA,           "exact",    2),
    "Case Manager - Treatment Services":                 ("Case Manager - Treatment Services",     CRED_NA,           "exact",    1),
    "Bookkeeper":                                        ("Bookkeeper",                            CRED_NA,           "exact",    1),
    "Database":                                          ("Database Coordinator",                  CRED_NA,           "high",     1),
    "Director of Homeless Guest Services":               ("Program Director - Homeless Services",  CRED_NA,           "high",     1),
    "Director of Residential Treatment":                 ("Program Director - Treatment Services", CRED_NA,           "high",     1),
    "Director of Development and Constituent Relations": (MARKET_REFERENCE,                        CRED_NA,           "DECIDED",  1),
    "Program Manager":                                   ("Program Manager",                       CRED_NA,           "medium",   1),
    "Finance and Data Associate":                        ("Associate - Administration",            CRED_NA,           "medium",   1),
    "Clinical Supervisor":                               (MARKET_REFERENCE,                        CRED_LICENSED,     "DECIDED",  1),
    "Program Director - Homeless Services":              ("Program Director - Homeless Services",  CRED_NA,           "exact",    1),
    "Shelter Manager":                                   ("Manager",                               CRED_NA,           "medium",   1),
    "Case Manager - Homeless Services":                  ("Case Manager - Homeless Services",      CRED_NA,           "exact",    1),
    "Facilities":                                        ("Custodian",                             CRED_NA,           "medium",   1),
}

# The counts above are the 2026-08-14 census and are what the migration plan
# reconciles against. A drift means someone edited the list by hand since.
EXPECTED_LABEL_INSTANCES = 216
EXPECTED_LABELLED_ROWS = 200
EXPECTED_TOTAL_ROWS = 202
EXPECTED_DUAL_LABEL_ROWS = 16
EXPECTED_UNLABELLED_ROWS = 2


class UnknownLabel(KeyError):
    """A label on the live list that the crosswalk has never seen."""


def classify_label(label):
    """Map one raw `SBRM Equivalent` label.

    Returns (canonical_or_None, credential, confidence, needs_judgment).
    `needs_judgment` True means the row goes to the model, and `canonical` is
    whatever the table guessed, which the model is free to overrule.

    Raises UnknownLabel rather than returning a default. A label nobody has
    seen is new drift, and silently dropping it is exactly the failure the
    cleanup exists to stop.
    """
    key = (label or "").strip()
    if key not in CROSSWALK:
        raise UnknownLabel(label)
    canonical, credential, confidence, _count = CROSSWALK[key]
    return canonical, credential, confidence, confidence in JUDGMENT


def classify_row_labels(labels):
    """Map a row's whole `SBRM Equivalent` array.

    The column is multi-select: 16 rows carry two labels and 2 carry none.
    Every write must PATCH the full array, so this returns the full resolved
    list, deduplicated but order-preserving.

    Returns a dict with:
      canonical        list[str]  - resolved roles, may be short if judgment needed
      credential       str|None   - strongest credential signal across labels
      needs_judgment   bool       - at least one label needs the model to read the row
      judgment_labels  list[str]  - which labels those were
      unknown          list[str]  - labels not in the crosswalk
      empty            bool       - the row carries no labels at all
    """
    raw = [str(l).strip() for l in (labels or []) if str(l).strip()]
    if not raw:
        return {
            "canonical": [],
            "credential": None,
            "needs_judgment": True,
            "judgment_labels": [],
            "unknown": [],
            "empty": True,
        }

    canonical, judgment_labels, unknown = [], [], []
    credentials = set()

    for label in raw:
        try:
            role, credential, _confidence, needs = classify_label(label)
        except UnknownLabel:
            unknown.append(label)
            continue
        if needs:
            judgment_labels.append(label)
            # A judgment label contributes no role until the model rules on it.
            continue
        if role and role not in canonical:
            canonical.append(role)
        credentials.add(credential)

    return {
        "canonical": canonical,
        "credential": _strongest_credential(credentials),
        "needs_judgment": bool(judgment_labels),
        "judgment_labels": judgment_labels,
        "unknown": unknown,
        "empty": False,
    }


def _strongest_credential(credentials):
    """Collapse a row's credential signals to one value.

    Precedence is by information content, not alphabetical. A row labelled both
    `RTS with license` and something generic is a licensed row; `N/A` is the
    absence of a signal and must never outrank a real one.
    """
    if CRED_LICENSED in credentials:
        return CRED_LICENSED
    if CRED_NOT_REQUIRED in credentials:
        return CRED_NOT_REQUIRED
    if CRED_NA in credentials:
        return CRED_NA
    return None


# --- Source backfill -----------------------------------------------------

# Only board domains. A 2023 hand-entered link to some org's own careers page
# is not evidence the org_website scraper found it, so those stay blank rather
# than get a fabricated provenance.
SOURCE_DOMAINS = (
    ("indeed.com",        "Indeed"),
    ("linkedin.com",      "LinkedIn"),
    ("ziprecruiter.com",  "ZipRecruiter"),
    ("glassdoor.com",     "Glassdoor"),
    ("joinhandshake.com", "Handshake"),
)


def source_for_url(url):
    """Identify the job board from a posting URL, or None."""
    if not url:
        return None
    text = str(url).strip().lower()
    if not text:
        return None
    for domain, source in SOURCE_DOMAINS:
        if domain in text:
            return source
    return None
