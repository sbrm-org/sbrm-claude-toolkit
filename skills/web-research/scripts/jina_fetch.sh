#!/bin/sh
# Fetch a web page as clean markdown via Jina Reader (https://r.jina.ai/).
# Works keyless at low rate limits. If JINA_API_KEY is set in the environment
# (the org may provide a shared key), it is sent for higher limits.
# NEVER hardcode a key in this file.
#
# Usage: jina_fetch.sh <url> ["what you're looking for"]
#
# With a query, the page is piped through focus.py so only the passages that
# match come back (short pages come back whole). Without one, the whole page
# is printed with a one-line hint on stderr.

set -eu

if [ $# -lt 1 ]; then
  echo "Usage: $0 <url> [\"what you're looking for\"]" >&2
  exit 64
fi

URL="$1"
QUERY="${2:-}"
# A blank query means no query.
case "$QUERY" in *[![:space:]]*) ;; *) QUERY="" ;; esac
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

if [ -n "${JINA_API_KEY:-}" ]; then
  STATUS=$(curl -sL --max-time 60 -o "$OUT" -w '%{http_code}' \
    -H "Authorization: Bearer $JINA_API_KEY" \
    "https://r.jina.ai/$URL") || STATUS=000
else
  STATUS=$(curl -sL --max-time 60 -o "$OUT" -w '%{http_code}' \
    "https://r.jina.ai/$URL") || STATUS=000
fi

if [ "$STATUS" = "200" ]; then
  # LC_ALL=C: BSD tr aborts on non-UTF-8 bytes in a UTF-8 locale, which would
  # make a real (Latin-1) page look empty.
  if [ -z "$(LC_ALL=C tr -d '[:space:]' < "$OUT" | head -c 1)" ]; then
    echo "Jina Reader returned an empty page for: $URL (HTTP 200, no content). Try the URL in a browser, or another fetch tier." >&2
    exit 1
  fi
  if [ -n "$QUERY" ]; then
    # focus.py lives next to this script. Resolved through python3 (needed
    # for focusing anyway) so a symlinked or relative invocation still finds
    # it. Whole-page mode above stays curl-only.
    FOCUS="$(python3 -c 'import os,sys; print(os.path.join(os.path.dirname(os.path.realpath(sys.argv[1])), "focus.py"))' "$0")"
    # --query= form so a query that starts with '-' is still a query, not a flag
    python3 "$FOCUS" --query="$QUERY" < "$OUT"
  else
    echo "jina_fetch.sh: returning the whole page. Add a second argument (\"what you're looking for\") to keep only the matching passages and cut tokens." >&2
    cat "$OUT"
  fi
  exit 0
fi

echo "Jina Reader failed (HTTP $STATUS) for: $URL" >&2
case "$STATUS" in
  401|403) echo "Anonymous access blocked or key invalid. Set JINA_API_KEY (free key at https://jina.ai/reader) and retry." >&2 ;;
  429)     echo "Rate limited. Wait a minute, or set JINA_API_KEY for higher limits." >&2 ;;
  000)     echo "Network error or timeout." >&2 ;;
  *)       head -c 500 "$OUT" >&2; echo >&2 ;;
esac
exit 1
