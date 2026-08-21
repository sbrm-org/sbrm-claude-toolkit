#!/usr/bin/env python3
"""One-time migration of the 202 historical `Competitor's Pay` rows.

This is NOT part of a normal `/comp-search` run. It repairs three years of rows
written before the skill enforced a vocabulary: backfilling `PayUnit`, mapping
37 drifted `SBRM Equivalent` labels onto the canonical set, and filling `Source`
where the posting URL identifies the board.

Decision record: REMEDIATION.md, "Execution order" steps 7-9, revived 2026-08-21.
The classification rules live in `crosswalk.py` and are tested in
`tests/test_crosswalk.py`. This file is only I/O and safety.

Four stages, in order. Each writes a file the next one reads, so the whole thing
is inspectable and resumable, and nothing is held only in memory.

    1. snapshot   fetch all rows to disk. This is the undo.
    2. plan       compute the diff. Writes plan.json and judgments-todo.json.
    3. (judge)    a human or model fills judgments-todo.json in. No code here.
    4. apply      PATCH, then READ BACK and compare. Gated on --i-have-approval.

Why the read-back is not optional
---------------------------------
Graph returns HTTP 200 with a full success payload while silently discarding a
value it will not accept. This was proven on this exact list on 2026-08-17
against the `JobPosting` column. A script that trusts the status code reports a
clean run and writes nothing. So `apply` re-reads every item it touched and
compares field by field, and any mismatch is a failure, not a warning.

Usage:
    python3 migrate_sharepoint.py snapshot --out-dir ./migration
    python3 migrate_sharepoint.py plan     --dir ./migration
    python3 migrate_sharepoint.py apply    --dir ./migration --i-have-approval
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from crosswalk import (  # noqa: E402
    CROSSWALK,
    EXPECTED_TOTAL_ROWS,
    MARKET_REFERENCE,
    MECHANICAL,
    UnknownLabel,
    classify_row_labels,
    pay_unit_for,
    source_for_url,
)

import sharepoint_target  # noqa: E402

DEFAULT_ACCOUNT = "sbrmappadmin@sbrm.org"

# Internal names of the columns this migration touches. `JobPosting` is
# deliberately absent and must stay that way.
FIELD_LABELS = "SBRMEquivalent"
FIELD_PAY_UNIT = "PayUnit"
FIELD_CREDENTIAL = "Credential"
FIELD_SOURCE = "Source"
FIELD_LOW = "Low_x002f_Only"

FORBIDDEN_FIELDS = {"JobPosting"}

WRITABLE = (FIELD_LABELS, FIELD_PAY_UNIT, FIELD_CREDENTIAL, FIELD_SOURCE)


def _fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def ms365(*args):
    """Run the ms365 wrapper and return parsed JSON.

    The wrapper exits 0 and puts auth/Graph failures in the payload, so an
    expired token looks exactly like an empty list. On this task that would mean
    "no rows to migrate, all done" against a list that is actually fine. Refuse
    loudly instead of treating an error payload as data.
    """
    proc = subprocess.run(["ms365", *args], capture_output=True, text=True)

    # Not every subcommand accepts --account; the column tools reject it and
    # argparse fails the whole call. The wrapper's default account is asserted
    # by assert_default_account() at startup, so dropping the flag targets the
    # same identity rather than silently switching users.
    if proc.returncode != 0 and "unrecognized arguments: --account" in proc.stderr:
        trimmed, skip = [], False
        for a in args:
            if skip:
                skip = False
                continue
            if a == "--account":
                skip = True
                continue
            trimmed.append(a)
        proc = subprocess.run(["ms365", *trimmed], capture_output=True, text=True)

    if proc.returncode != 0:
        _fail(f"ms365 {args[0]} exited {proc.returncode}: {proc.stderr[-400:]}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        _fail(f"ms365 {args[0]} returned non-JSON: {proc.stdout[:300]}")
    if isinstance(data, dict) and "error" in data:
        _fail(f"ms365 {args[0]} failed: {data['error']}\n"
              f"If this mentions a token, re-authenticate with: ms365 login")
    return data


def assert_default_account(expected):
    """Refuse to run if the wrapper's default account is not the expected one.

    Some subcommands reject --account, so those calls run as whatever the
    wrapper defaults to. Writing 202 rows to HR's list as the wrong identity is
    not something to discover afterwards.
    """
    data = ms365("list-accounts")
    accounts = data.get("accounts", []) if isinstance(data, dict) else []
    default = next((a.get("email") for a in accounts if a.get("isDefault")), None)
    if default != expected:
        _fail(f"default ms365 account is {default!r}, expected {expected!r}. "
              f"Some subcommands ignore --account and would run as {default!r}. "
              f"Fix with: ms365 select-account")
    return default


# --- stage 1: snapshot ---------------------------------------------------

def cmd_snapshot(args):
    print(f"Acting as: {assert_default_account(args.account)}")
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    print("Fetching list columns...")
    columns = ms365(
        "list-sharepoint-list-columns",
        "--site-id", args.site_id, "--list-id", args.list_id,
        "--account", args.account, "--fetch-all-pages",
    )
    (out / "columns.json").write_text(json.dumps(columns, indent=2))

    print("Fetching list items...")
    items = ms365(
        "list-sharepoint-site-list-items",
        "--site-id", args.site_id, "--list-id", args.list_id,
        "--expand", '["fields"]', "--fetch-all-pages", "--top", "100",
        "--account", args.account,
    )
    values = items.get("value", items if isinstance(items, list) else [])
    if not values:
        _fail("Snapshot returned 0 items. Auth or the list ID is wrong; "
              "migrating on top of that would be meaningless.")

    (out / "snapshot.json").write_text(json.dumps(items, indent=2))
    print(f"Snapshot: {len(values)} items -> {out / 'snapshot.json'}")
    if len(values) != EXPECTED_TOTAL_ROWS:
        print(f"NOTE: expected {EXPECTED_TOTAL_ROWS} rows, found {len(values)}. "
              f"The list changed since the 2026-08-14 census. Reconcile before applying.")
    _report_schema(columns)


def _choice_values(column):
    choice = column.get("choice") or {}
    return choice.get("choices") or []


def _is_multi_select(column):
    """Whether a choice column accepts more than one value.

    Graph's columnDefinition does NOT expose a `multipleValues` flag for choice
    columns, so an earlier version of this check looked for one, never found it,
    and reported every multi-select column as single-select. On this list that
    was a false alarm that would have argued for scalar writes and silently
    destroyed the second label on 16 rows.

    SharePoint renders a multi-choice column as check boxes and a single-choice
    one as a dropdown, so `displayAs` is the signal actually present in the
    payload. `Location` on this list is the control: checkBoxes, and its live
    data is arrays.
    """
    choice = column.get("choice") or {}
    if choice.get("displayAs") == "checkBoxes":
        return True
    # Fall back to whatever the payload says, for columns Graph describes
    # differently, rather than assuming single.
    return bool(column.get("multipleValues") or column.get("allowMultipleValues"))


def _report_schema(columns):
    """Check the prerequisites REMEDIATION steps 1, 5 and 6 were meant to set up."""
    cols = columns.get("value", columns if isinstance(columns, list) else [])
    by_name = {}
    for c in cols:
        for key in (c.get("name"), c.get("displayName")):
            if key:
                by_name[key] = c

    print("\n--- live schema check ---")
    for name in (FIELD_PAY_UNIT, FIELD_CREDENTIAL):
        col = by_name.get(name)
        if not col:
            print(f"  MISSING: {name} column does not exist. "
                  f"It is a prerequisite (REMEDIATION step 1) and must be created first.")
        else:
            print(f"  OK: {name} exists, choices={_choice_values(col)}")

    labels = by_name.get(FIELD_LABELS) or by_name.get("SBRM Equivalent")
    if not labels:
        print(f"  MISSING: {FIELD_LABELS} column not found.")
        return
    choices = _choice_values(labels)
    choice_block = labels.get("choice") or {}
    allow_text = choice_block.get("allowTextEntry")
    multi = _is_multi_select(labels)
    print(f"  {FIELD_LABELS}: multi={multi} allowTextEntry={allow_text} "
          f"({len(choices)} choices)")
    if not multi:
        print("  WARNING: column does not look multi-select. 16 rows carry two "
              "labels and a single-select write would discard one.")
    if allow_text:
        print("  NOTE: allowTextEntry is still on (REMEDIATION step 6 not applied).")

    # The migration can only write values the column actually offers. Anything
    # it targets that is not a choice would be rejected or, worse, accepted as
    # fill-in text and recreate the drift this is cleaning up.
    #
    # Only MECHANICAL targets count. The medium-confidence rows carry a guessed
    # role in the table ('Program Manager', 'Program Manager - Treatment
    # Services'), but those rows go to model judgment and the guess is never
    # written, so requiring them as choices would be a false blocker.
    targets = {row[0] for row in CROSSWALK.values()
               if row[0] and row[2] in MECHANICAL} | {MARKET_REFERENCE}
    missing = sorted(t for t in targets if t not in choices)
    if missing:
        print("\n  BLOCKER: crosswalk targets that are not choices on the live column:")
        for m in missing:
            print(f"    - {m}")
        print("  Add these as choices (REMEDIATION step 5) before applying.")
    else:
        print("  OK: every crosswalk target exists as a choice.")


# --- stage 2: plan -------------------------------------------------------

def _fields(item):
    return item.get("fields") or {}


def _labels_of(fields):
    raw = fields.get(FIELD_LABELS)
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw]
    return list(raw)


def _url_of(fields):
    """Every link on the row. `JobPosting` is read-only to us but readable."""
    urls = []
    posting = fields.get("JobPosting")
    if isinstance(posting, dict):
        urls.append(posting.get("Url") or posting.get("url"))
    elif isinstance(posting, str):
        urls.append(posting)
    if fields.get("URL"):
        urls.append(fields["URL"])
    return [u for u in urls if u]


def cmd_plan(args):
    d = Path(args.dir)
    snapshot = json.loads((d / "snapshot.json").read_text())
    items = snapshot.get("value", snapshot if isinstance(snapshot, list) else [])

    judgments = {}
    jpath = d / "judgments.json"
    if jpath.exists():
        judgments = json.loads(jpath.read_text())

    plan, todo, unknown_labels = [], [], set()
    counts = {"pay_unit": 0, "labels": 0, "credential": 0, "source": 0,
              "no_change": 0, "needs_judgment": 0, "pay_review": 0}

    for item in items:
        item_id = str(item.get("id"))
        f = _fields(item)
        changes, flags = {}, []

        # --- PayUnit ---
        if not f.get(FIELD_PAY_UNIT):
            unit = pay_unit_for(f.get(FIELD_LOW))
            if unit:
                changes[FIELD_PAY_UNIT] = unit
                counts["pay_unit"] += 1
            else:
                flags.append(f"pay_unit_unresolved(Low/Only={f.get(FIELD_LOW)!r})")
                counts["pay_review"] += 1

        # --- SBRM Equivalent + Credential ---
        raw_labels = _labels_of(f)
        try:
            res = classify_row_labels(raw_labels)
        except UnknownLabel as exc:
            res = None
            flags.append(f"unknown_label({exc})")
        if res:
            unknown_labels.update(res["unknown"])
            if res["unknown"]:
                flags.append(f"unknown_label({','.join(res['unknown'])})")

            resolved = list(res["canonical"])
            credential = res["credential"]

            if res["needs_judgment"]:
                verdict = judgments.get(item_id)
                if verdict and verdict.get("roles"):
                    for r in verdict["roles"]:
                        if r not in resolved:
                            resolved.append(r)
                    if verdict.get("credential"):
                        credential = verdict["credential"]
                elif verdict and verdict.get("flag"):
                    flags.append(f"judged_unresolvable({verdict['flag']})")
                    resolved = []
                else:
                    counts["needs_judgment"] += 1
                    todo.append({
                        "id": item_id,
                        "current_labels": raw_labels,
                        "judgment_labels": res["judgment_labels"],
                        "resolved_so_far": res["canonical"],
                        "empty": res["empty"],
                        "evidence": {
                            "Title": f.get("Title"),
                            "Organization": f.get("Organization"),
                            "Notes": f.get("Notes"),
                            "urls": _url_of(f),
                            "Low_x002f_Only": f.get(FIELD_LOW),
                            "High": f.get("High"),
                        },
                        # fill ONE of these in:
                        "roles": [],
                        "credential": None,
                        "flag": None,
                    })
                    resolved = []

            if resolved and sorted(resolved) != sorted(raw_labels):
                changes[FIELD_LABELS] = resolved
                counts["labels"] += 1
            if credential and not f.get(FIELD_CREDENTIAL):
                changes[FIELD_CREDENTIAL] = credential
                counts["credential"] += 1

        # --- Source ---
        if not f.get(FIELD_SOURCE):
            for url in _url_of(f):
                src = source_for_url(url)
                if src:
                    changes[FIELD_SOURCE] = src
                    counts["source"] += 1
                    break

        if changes:
            plan.append({
                "id": item_id,
                "before": {k: f.get(k) for k in WRITABLE},
                "changes": changes,
                "flags": flags,
            })
        else:
            counts["no_change"] += 1
            if flags:
                plan.append({"id": item_id, "before": {k: f.get(k) for k in WRITABLE},
                             "changes": {}, "flags": flags})

    _assert_no_forbidden(plan)

    (d / "plan.json").write_text(json.dumps(plan, indent=2))
    (d / "judgments-todo.json").write_text(json.dumps(todo, indent=2))

    print(f"Rows in snapshot:            {len(items)}")
    print(f"Rows with pending changes:   {sum(1 for p in plan if p['changes'])}")
    print(f"  PayUnit backfills:         {counts['pay_unit']}")
    print(f"  SBRMEquivalent rewrites:   {counts['labels']}")
    print(f"  Credential fills:          {counts['credential']}")
    print(f"  Source fills:              {counts['source']}")
    print(f"Rows needing model judgment: {counts['needs_judgment']}  -> judgments-todo.json")
    print(f"Rows with unresolvable pay:  {counts['pay_review']}")
    print(f"Rows with no change:         {counts['no_change']}")
    if unknown_labels:
        print(f"\nUNKNOWN LABELS (not in the crosswalk): {sorted(unknown_labels)}")
    flagged = [p for p in plan if p["flags"]]
    if flagged:
        print(f"\n{len(flagged)} rows carry flags. Review them before applying.")


def _assert_no_forbidden(plan):
    """`JobPosting` is unwritable through Graph and stays HR's column."""
    for row in plan:
        bad = FORBIDDEN_FIELDS & set(row["changes"])
        if bad:
            _fail(f"Plan touches forbidden field(s) {bad} on item {row['id']}. "
                  f"JobPosting cannot be written through Graph and must not be attempted.")


# --- stage 4: apply ------------------------------------------------------

def _patch_body(changes):
    """Build the PATCH body, annotating multi-select arrays.

    `SBRMEquivalent` MUST go as a full array with the Collection(Edm.String)
    annotation. 16 rows carry two labels; a scalar write silently drops one.
    """
    fields = {}
    for key, value in changes.items():
        if isinstance(value, list):
            fields[f"{key}@odata.type"] = "Collection(Edm.String)"
            fields[key] = value
        else:
            fields[key] = value
    return {"body": {"fields": fields}}


def _stdin_call(tool, payload):
    """Invoke a tool with every argument on stdin.

    Flag spellings differ per tool (`--list-item-id` here,
    `--column-definition-id` there) and several reject `--account` outright, so
    a flag-based call fails at argument parsing rather than reaching Graph. The
    stdin form takes the MCP tool's own camelCase parameter names and works
    uniformly. Argument-parse failures are indistinguishable from "no write
    happened", which is safe but silent, so this raises instead.
    """
    proc = subprocess.run(["ms365", tool, "--stdin"],
                          input=json.dumps(payload), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"{tool} exit {proc.returncode}: {proc.stderr[-300:]}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"{tool} non-JSON: {proc.stdout[:200]}")
    if isinstance(data, dict) and "error" in data:
        raise RuntimeError(str(data["error"])[:300])
    return data


def _read_back(args, item_id):
    item = _stdin_call("get-sharepoint-site-list-item", {
        "siteId": args.site_id,
        "listId": args.list_id,
        "listItemId": str(item_id),
        "expand": ["fields"],
    })
    return _fields(item)


def _matches(expected, actual):
    if isinstance(expected, list):
        return sorted(str(x) for x in (actual or [])) == sorted(str(x) for x in expected)
    if isinstance(expected, (int, float)):
        try:
            return float(actual) == float(expected)
        except (TypeError, ValueError):
            return False
    return str(actual) == str(expected)


def cmd_apply(args):
    if not args.i_have_approval:
        _fail("apply writes to HR's live list. Re-run with --i-have-approval "
              "only after Tim has seen the plan diff.")

    d = Path(args.dir)
    plan = json.loads((d / "plan.json").read_text())
    todo = json.loads((d / "judgments-todo.json").read_text())
    if todo and not args.allow_unjudged:
        _fail(f"{len(todo)} rows still need judgment (judgments-todo.json). "
              f"Fill them in, re-run `plan`, or pass --allow-unjudged to migrate "
              f"only the mechanical rows.")

    _assert_no_forbidden(plan)
    work = [p for p in plan if p["changes"]]
    if args.limit:
        work = work[: args.limit]

    applied, failed = [], []
    log = (d / "apply-log.jsonl").open("a")

    for n, row in enumerate(work, 1):
        item_id = row["id"]
        changes = row["changes"]
        try:
            _do_patch(args, item_id, changes)
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001
            failed.append({"id": item_id, "error": f"patch raised: {exc}"})
            log.write(json.dumps({"id": item_id, "ok": False, "error": str(exc)}) + "\n")
            continue

        # The whole point. A 200 proves nothing.
        time.sleep(args.delay)
        actual = _read_back(args, item_id)
        mismatched = {
            k: {"sent": v, "stored": actual.get(k)}
            for k, v in changes.items() if not _matches(v, actual.get(k))
        }
        ok = not mismatched
        (applied if ok else failed).append(
            {"id": item_id, "changes": changes, "mismatched": mismatched or None})
        log.write(json.dumps({"id": item_id, "ok": ok, "changes": changes,
                              "mismatched": mismatched or None}) + "\n")
        log.flush()
        print(f"[{n}/{len(work)}] item {item_id}: "
              f"{'verified' if ok else 'MISMATCH ' + json.dumps(mismatched)}")
        time.sleep(args.delay)

    log.close()
    (d / "apply-result.json").write_text(json.dumps(
        {"applied": applied, "failed": failed}, indent=2))
    print(f"\nVerified: {len(applied)}   Failed/mismatched: {len(failed)}")
    if failed:
        print("See apply-result.json. A mismatch means Graph accepted the call and "
              "did not store the value; nothing here retries automatically.")
        sys.exit(2)


def _do_patch(args, item_id, changes):
    payload = {
        "siteId": args.site_id,
        "listId": args.list_id,
        "listItemId": str(item_id),
        **_patch_body(changes),
    }
    return _stdin_call("update-sharepoint-list-item", payload)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site-id", default=None)
    ap.add_argument("--list-id", default=None)
    ap.add_argument("--account", default=DEFAULT_ACCOUNT)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("snapshot", help="fetch all rows and the schema to disk")
    s.add_argument("--out-dir", required=True)
    s.set_defaults(func=cmd_snapshot)

    p = sub.add_parser("plan", help="compute the diff; writes plan.json")
    p.add_argument("--dir", required=True)
    p.set_defaults(func=cmd_plan)

    a = sub.add_parser("apply", help="write, then read back and verify")
    a.add_argument("--dir", required=True)
    a.add_argument("--i-have-approval", action="store_true")
    a.add_argument("--allow-unjudged", action="store_true",
                   help="apply only the mechanical rows, leaving judgment rows alone")
    a.add_argument("--limit", type=int, default=0, help="stop after N rows (batching)")
    a.add_argument("--delay", type=float, default=0.3)
    a.set_defaults(func=cmd_apply)

    args = ap.parse_args()
    # Resolved late so --site-id still wins, and so a missing ID fails with an
    # instruction rather than a Graph 400 forty rows in.
    args.site_id = sharepoint_target.require("site_id", args.site_id)
    args.list_id = sharepoint_target.require("list_id", args.list_id)
    args.func(args)


if __name__ == "__main__":
    main()
