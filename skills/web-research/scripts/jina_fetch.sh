#!/bin/sh
# Fetch a web page as clean markdown via Jina Reader (https://r.jina.ai/).
# Works keyless at low rate limits. If JINA_API_KEY is set in the environment
# (the org may provide a shared key), it is sent for higher limits.
# NEVER hardcode a key in this file.
#
# Usage: jina_fetch.sh <url>

set -eu

if [ $# -lt 1 ]; then
  echo "Usage: $0 <url>" >&2
  exit 64
fi

URL="$1"
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
  cat "$OUT"
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
