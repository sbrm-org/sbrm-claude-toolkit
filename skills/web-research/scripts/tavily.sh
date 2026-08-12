#!/bin/sh
# Tavily API wrapper: paid search + extract with clean text output.
# Requires TAVILY_API_KEY in the environment. NEVER hardcode a key in this file.
#
# Usage:
#   tavily.sh search "your query"
#   tavily.sh extract <url>

set -eu

usage() {
  echo "Usage: $0 search \"query\" | $0 extract <url>" >&2
  exit 64
}

[ $# -lt 2 ] && usage
MODE="$1"
ARG="$2"

if [ -z "${TAVILY_API_KEY:-}" ]; then
  echo "TAVILY_API_KEY is not set. Tavily is the paid tier; without a key, use the free fallbacks instead:" >&2
  echo "  search: python3 scripts/ddg_search.py \"query\"" >&2
  echo "  fetch:  scripts/jina_fetch.sh <url>" >&2
  exit 1
fi

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

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

# Readable output: pull the useful fields
python3 - "$MODE" < "$OUT" <<'PYEOF'
import json, sys
data = json.load(sys.stdin)
mode = sys.argv[1]
if mode == "search":
    if data.get("answer"):
        print("ANSWER:", data["answer"], "\n")
    for i, r in enumerate(data.get("results", []), 1):
        print(f"{i}. {r.get('title','')}")
        print(f"   {r.get('url','')}")
        content = (r.get("content") or "").strip()
        if content:
            print(f"   {content[:500]}")
        print()
else:
    for r in data.get("results", []):
        print("URL:", r.get("url", ""))
        print(r.get("raw_content") or r.get("content") or "")
        print()
    for f in data.get("failed_results", []):
        print("FAILED:", f, file=sys.stderr)
PYEOF
