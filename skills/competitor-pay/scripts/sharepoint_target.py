#!/usr/bin/env python3
"""Where the SharePoint target IDs come from.

One place, because they were previously duplicated as module constants in every
script that talks to Graph, which meant sanitizing the public repo would have
had to find all of them.

Resolution order, first hit wins:

    1. an explicit CLI argument            (--site-id / --list-id)
    2. environment                         (CP_SITE_ID / CP_LIST_ID)
    3. a local, uncommitted override       ($COMPETITOR_PAY_HOME/config.local.json)
    4. the committed config.json

`sbrm-claude-toolkit` is a public repository whose README promises "no internal
paths, credentials, or personal infrastructure references". A tenant site ID is
not a credential and Graph still requires auth, but it is internal
infrastructure detail. Layer 3 exists so the committed config can hold
placeholders without breaking a real install: drop the real values into
`config.local.json`, which lives beside the database, outside the skill
directory, and is therefore never committed and never destroyed by a plugin
update.
"""

import json
import os
from pathlib import Path

PLACEHOLDERS = {"", None, "REPLACE_ME", "<site_id>", "<list_id>"}


def _data_home():
    return Path(os.environ.get("COMPETITOR_PAY_HOME",
                               Path.home() / ".competitor-pay"))


def _config_path():
    return Path(__file__).resolve().parent.parent / "config.json"


def _read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}


def _from_file(path, key):
    value = (_read_json(path).get("sharepoint") or {}).get(key)
    return None if value in PLACEHOLDERS else value


def resolve(key, cli_value=None):
    """Resolve one of 'site_id' / 'list_id'. Returns None if nothing is set."""
    if cli_value not in PLACEHOLDERS:
        return cli_value

    env = os.environ.get(f"CP_{key.upper()}")
    if env not in PLACEHOLDERS:
        return env

    local = _from_file(_data_home() / "config.local.json", key)
    if local:
        return local

    return _from_file(_config_path(), key)


def site_id(cli_value=None):
    return resolve("site_id", cli_value)


def list_id(cli_value=None):
    return resolve("list_id", cli_value)


def require(key, cli_value=None):
    """Resolve or explain how to fix it. Callers that cannot proceed use this."""
    value = resolve(key, cli_value)
    if value:
        return value
    raise SystemExit(
        f"ERROR: no {key} configured.\n"
        f"Set it one of these ways:\n"
        f"  --{key.replace('_', '-')} <value>\n"
        f"  CP_{key.upper()}=<value>\n"
        f"  {_data_home() / 'config.local.json'} -> {{\"sharepoint\": {{\"{key}\": \"...\"}}}}\n"
        f"  {_config_path()} -> sharepoint.{key}"
    )


def _main():
    """Shell entry point, so SKILL.md's bash blocks resolve the same way the
    Python does instead of reading config.json directly and getting a
    placeholder.

        SITE=$(python3 scripts/sharepoint_target.py site_id)
    """
    import sys as _sys
    if len(_sys.argv) != 2 or _sys.argv[1] not in ("site_id", "list_id"):
        raise SystemExit("usage: sharepoint_target.py site_id|list_id")
    print(require(_sys.argv[1]))


if __name__ == "__main__":
    _main()
