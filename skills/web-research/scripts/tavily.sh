#!/bin/sh
# Tavily API wrapper: paid search + extract with clean text output.
# Requires TAVILY_API_KEY in the environment. NEVER hardcode a key in this file.
#
# Usage:
#   tavily.sh search "your query"
#   tavily.sh extract <url> ["what you're looking for"]
#
# extract with a query pipes the page through focus.py so only the passages
# that match come back (short pages come back whole). Without one, the whole
# page is printed with a one-line hint on stderr.

set -eu

usage() {
  echo "Usage: $0 search \"query\" | $0 extract <url> [\"what you're looking for\"]" >&2
  exit 64
}

[ $# -lt 2 ] && usage
MODE="$1"
ARG="$2"
QUERY="${3:-}"
# A blank query means no query.
case "$QUERY" in *[![:space:]]*) ;; *) QUERY="" ;; esac

if [ -z "${TAVILY_API_KEY:-}" ]; then
  echo "TAVILY_API_KEY is not set. Tavily is the paid tier; without a key, use the free fallbacks instead:" >&2
  echo "  search: python3 scripts/ddg_search.py \"query\"" >&2
  echo "  fetch:  scripts/jina_fetch.sh <url> [\"what you're looking for\"]" >&2
  exit 1
fi

# focus.py lives next to this script. Resolved through python3 (already a
# dependency past this point) so a symlinked or relative invocation still
# finds it.
FOCUS="$(python3 -c 'import os,sys; print(os.path.join(os.path.dirname(os.path.realpath(sys.argv[1])), "focus.py"))' "$0")"

OUT="$(mktemp)"
TEXT="$(mktemp)"
trap 'rm -f "$OUT" "$TEXT"' EXIT

case "$MODE" in
  search)
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1], "include_answer": True, "max_results": 5}))' "$ARG")
    ENDPOINT="https://api.tavily.com/search"
    ;;
  extract)
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"urls": [sys.argv[1]]}))' "$ARG")
    ENDPOINT="https://api.tavily.com/extract"
    ;;
  *)
    usage
    ;;
esac

STATUS=$(curl -s --max-time 60 -o "$OUT" -w '%{http_code}' \
  -X POST "$ENDPOINT" \
  -H "Authorization: Bearer $TAVILY_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY") || STATUS=000

if [ "$STATUS" != "200" ]; then
  echo "Tavily $MODE failed (HTTP $STATUS)." >&2
  case "$STATUS" in
    401|403) echo "Key rejected or unauthorized. Check TAVILY_API_KEY." >&2 ;;
    429)     echo "Rate/credit limited. Fall back to ddg_search.py / jina_fetch.sh." >&2 ;;
    000)     echo "Network error or timeout." >&2 ;;
  esac
  # Surface the API's own error message if it returned JSON
  python3 -m json.tool < "$OUT" >&2 2>/dev/null || head -c 500 "$OUT" >&2
  echo >&2
  exit 1
fi

# Readable output: pull the useful fields. The response file is passed by
# path: with `python3 -` the heredoc already owns stdin, so a `< "$OUT"`
# redirect would be silently overridden and the JSON never read.
python3 - "$MODE" "$OUT" > "$TEXT" <<'PYEOF'
import json, sys
mode = sys.argv[1]
with open(sys.argv[2], encoding="utf-8", errors="replace") as fh:
    raw = fh.read()
try:
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("top level is not an object")
except ValueError as e:
    # HTTP 200 with a non-JSON body: captive portal, proxy page, outage HTML.
    print(f"Tavily {mode}: response was not JSON ({e}). First bytes: {raw[:200]!r}", file=sys.stderr)
    sys.exit(1)
results = data.get("results") or []
if mode == "search":
    if data.get("answer"):
        print("ANSWER:", data["answer"], "\n")
    for i, r in enumerate(results, 1):
        print(f"{i}. {r.get('title','')}")
        print(f"   {r.get('url','')}")
        content = str(r.get("content") or "").strip()
        if content:
            print(f"   {content[:500]}")
        print()
else:
    for r in results:
        body = str(r.get("raw_content") or r.get("content") or "").strip()
        if not body:
            # An empty result must leave stdout empty so the shell's
            # empty-page check below fires instead of a bare "URL:" line.
            print("FAILED: no content for", r.get("url", ""), file=sys.stderr)
            continue
        print("URL:", r.get("url", ""))
        print(body)
        print()
    for f in data.get("failed_results", []):
        print("FAILED:", f, file=sys.stderr)
PYEOF

# LC_ALL=C: BSD tr aborts on non-UTF-8 bytes in a UTF-8 locale, which would
# make a real page look empty.
if [ "$MODE" = "extract" ] && [ -z "$(LC_ALL=C tr -d '[:space:]' < "$TEXT" | head -c 1)" ]; then
  echo "Tavily extract returned an empty page for: $ARG (no results). Try scripts/jina_fetch.sh, or the URL in a browser." >&2
  exit 1
fi

if [ "$MODE" = "extract" ] && [ -n "$QUERY" ]; then
  # --query= form so a query that starts with '-' is still a query, not a flag
  python3 "$FOCUS" --query="$QUERY" < "$TEXT"
else
  if [ "$MODE" = "extract" ]; then
    echo "tavily.sh: returning the whole page. Add a third argument (\"what you're looking for\") to keep only the matching passages and cut tokens." >&2
  fi
  cat "$TEXT"
fi
