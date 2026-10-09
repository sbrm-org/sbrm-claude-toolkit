#!/usr/bin/env bash
# SBRM toolkit: launcher for the Dataverse guard (hooks/hooks.json runs THIS, not node directly).
#
# Why it exists (tested 10/7/26): Claude Code treats a hook that cannot START as a non-blocking error and
# lets the tool call through. A guard run as bare `node` therefore fails OPEN wherever node is not on
# Claude Code's PATH (Node from nvm with Claude Code opened from the Dock, say). So:
#   1. find node: PATH, else the usual nvm / Homebrew / system / Windows locations;
#   2. run guard.js; its exit 2 = block, 0 = allow. Anything else means the guard itself crashed, and a
#      crash is not an allow: fall through to step 3;
#   3. no working node: block anything that touches Dataverse (by its text), let unrelated calls through.
#      Without node the engine and the read connections cannot run either, so what is left to stop is the
#      CLI, raw HTTP, the store and the plugin, and all of those name Dataverse in their text.
# SBRM_GUARD_TEST_NO_NODE=1 skips step 1-2 (tests only; the hook's environment is Claude Code's, which a
# session cannot set, and step 3 only ever blocks MORE Dataverse calls than it allows).

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT="$(cat)"

find_node() {
  local n
  n="$(command -v node 2>/dev/null)"
  if [ -n "$n" ]; then printf '%s' "$n"; return; fi
  n="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  if [ -n "$n" ] && [ -x "$n" ]; then printf '%s' "$n"; return; fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "/c/Program Files/nodejs/node.exe"; do
    if [ -x "$c" ]; then printf '%s' "$c"; return; fi
  done
}

if [ "$SBRM_GUARD_TEST_NO_NODE" != "1" ]; then
  NODE="$(find_node)"
  if [ -n "$NODE" ]; then
    printf '%s' "$INPUT" | "$NODE" "$DIR/guard.js"
    STATUS=$?
    if [ "$STATUS" = "0" ] || [ "$STATUS" = "2" ]; then exit "$STATUS"; fi
    REASON="the guard crashed (exit $STATUS)"
  else
    REASON="Node was not found"
  fi
else
  REASON="Node was not found (test)"
fi

# Step 3: fail closed for anything that touches Dataverse. A Read or Grep is blocked only near the engine's
# store (the plan signing key); an MCP tool only when its own NAME says Dataverse (1.10.1: the wider hook
# matcher would otherwise block every file or note that merely mentions the word).
TOOL="$(printf '%s' "$INPUT" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1)"

# 1.11.6 (DESIGN.md §11): the guard did not run, so nothing else records it. Leave one plain line (time, why,
# tool) that the next engine run sends as an OPEN item and removes. Bash only (there may be no node), every
# write allowed to fail, and capped so a long outage cannot grow the file without bound.
STORE="${SBRM_DV_HOME:-$HOME/.sbrm-dataverse}"
DOWN="$STORE/events/guard_down.log"
if mkdir -p "$STORE/events" 2>/dev/null; then
  SIZE="$(wc -c < "$DOWN" 2>/dev/null || echo 0)"
  if [ $(( SIZE + 0 )) -lt 1000000 ]; then
    printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REASON" "$(printf '%s' "$TOOL" | sed -E 's/.*"([^"]*)"$/\1/')" >> "$DOWN" 2>/dev/null
  fi
fi
case "$TOOL" in
  *'"Read"'*|*'"Grep"'*) PATTERN='sbrm-dataverse' ;;
  *'"mcp__'*) INPUT="$TOOL"; PATTERN='dataverse|dynamics|power.?platform|crm' ;;
  *) PATTERN='dataverse|crm[0-9]*\.dynamics\.com|sbrm-dataverse|sbrm-claude-toolkit' ;;
esac
if printf '%s' "$INPUT" | grep -qiE "$PATTERN"; then
  echo "BLOCKED by the SBRM toolkit Dataverse guard: it could not run ($REASON), so anything that touches Dataverse is blocked until it can. Tell the person; the fix is /dataverse-setup (or start Claude Code from a terminal where node works). Do not look for another way." >&2
  exit 2
fi
exit 0
