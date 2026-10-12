#!/usr/bin/env bash
# SBRM toolkit: launcher for the version nudge (1.11.9, DESIGN.md §12e; hooks/hooks.json runs THIS on
# UserPromptSubmit). Finds node the way the guard's run.sh does and runs nudge.js. Unlike the guard it FAILS
# QUIET: no node, a crash, anything at all = no output and exit 0, because a nudge must never touch a prompt.
# SBRM_NUDGE_TEST_NO_NODE=1 skips node (tests only).

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

if [ "$SBRM_NUDGE_TEST_NO_NODE" != "1" ]; then
  NODE="$(find_node)"
  if [ -n "$NODE" ]; then
    printf '%s' "$INPUT" | "$NODE" "$DIR/nudge.js" 2>/dev/null
  fi
fi
exit 0
