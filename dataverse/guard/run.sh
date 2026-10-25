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

# SPEED (10/25/26): this runs before EVERY tool call, and on Windows each helper process (cat, dirname, a `$(...)`
# subshell, a pipe) costs ~50-100 ms: the launcher took 470-650 ms around a guard that decides in ~100-160 ms. So
# the happy path below is bash builtins + node only (guard_launcher.test.js runs it with PATH = node's folder).
# The fallback further down may still use helpers: it runs only when node is missing or crashed.
SRC="${BASH_SOURCE[0]}"
case "$SRC" in
  */*|*\\*) DIR="${SRC%[/\\]*}" ;;     # the hook passes an absolute path, slashes of either kind on Windows
  *) DIR=. ;;
esac
# All of stdin, NUL bytes dropped as `$(cat)` dropped them (one `read -d ''` would stop at the first; review F3).
INPUT=""
while IFS= read -r -d '' CHUNK; do INPUT+="$CHUNK"; done
INPUT+="$CHUNK"

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
  # `hash` finds node on PATH with no subshell (BASH_CMDS needs bash 4; on macOS's bash 3.2 it reads empty and the
  # full search runs, as before).
  NODE=""
  if hash node 2>/dev/null; then NODE="${BASH_CMDS[node]:-}"; fi
  [ -n "$NODE" ] || NODE="$(find_node)"
  if [ -n "$NODE" ]; then
    "$NODE" "$DIR/guard.js" <<< "$INPUT"
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
# 1.11.23 (review F1 + F2 of 1.11.20): this step matches with bash builtins, never `grep` (a machine without node
# may lack it too, and a missing grep read as "no match": everything allowed), and matches the input BOTH as sent
# and with its \u00XX escapes decoded (JSON may spell any character that way, so a name could hide from the match).
# Classification still reads the raw input, so a decoded copy can only ever add a match: never fewer blocks.
shopt -s nocasematch
TOOL=""
RE_TOOL='"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"'
if [[ $INPUT =~ $RE_TOOL ]]; then TOOL="${BASH_REMATCH[0]}"; fi
RAW_INPUT="$INPUT"   # the MCP case below narrows INPUT to the tool name; keep the whole input for the decoded read
decode() { printf -v DECODED '%b' "${1//\\u00/\\x}"; }

# 1.11.6 (DESIGN.md §11): the guard did not run, so nothing else records it. Leave one plain line (time, why,
# tool) that the next engine run sends as an OPEN item and removes. Bash only (there may be no node), every
# write allowed to fail, and capped so a long outage cannot grow the file without bound.
STORE="${SBRM_DV_HOME:-$HOME/.sbrm-dataverse}"
DOWN="$STORE/events/guard_down.log"
if mkdir -p "$STORE/events" 2>/dev/null; then
  SIZE="$(wc -c < "$DOWN" 2>/dev/null || echo 0)"
  if [ $(( SIZE + 0 )) -lt 1000000 ]; then
    NAME="${TOOL%\"}"; NAME="${NAME##*\"}"
    printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" "$REASON" "$NAME" >> "$DOWN" 2>/dev/null
  fi
fi
case "$TOOL" in
  *'"Read"'*|*'"Grep"'*) PATTERN='sbrm-dataverse' ;;
  *'"mcp__'*) INPUT="$TOOL"; PATTERN='dataverse|dynamics|power.?platform|crm' ;;
  *) PATTERN='dataverse|crm[0-9]*\.dynamics\.com|sbrm-dataverse|sbrm-claude-toolkit' ;;
esac
decode "$INPUT"
BLOCK=no
if [[ $INPUT =~ $PATTERN ]] || [[ $DECODED =~ $PATTERN ]]; then BLOCK=yes; fi
# Review 1.11.23: an escaped "mcp__" PREFIX hides the call from the MCP case above, whose words ("dynamics", "crm")
# the generic pattern does not have. So a tool name that is MCP once decoded is ALSO held to the MCP rule.
# (round 2: the tool name is also read from the DECODED input, for a key spelled with escapes too)
decode "$TOOL"
if [ -z "$TOOL" ]; then
  decode "$RAW_INPUT"
  if [[ $DECODED =~ $RE_TOOL ]]; then DECODED="${BASH_REMATCH[0]}"; else DECODED=""; fi
fi
case "$DECODED" in
  *'"mcp__'*) if [[ $DECODED =~ dataverse|dynamics|power.?platform|crm ]]; then BLOCK=yes; fi ;;
esac
if [ "$BLOCK" = yes ]; then
  echo "BLOCKED by the SBRM toolkit Dataverse guard: it could not run ($REASON), so anything that touches Dataverse is blocked until it can. Tell the person; the fix is /dataverse-setup (or start Claude Code from a terminal where node works). Do not look for another way." >&2
  exit 2
fi
exit 0
