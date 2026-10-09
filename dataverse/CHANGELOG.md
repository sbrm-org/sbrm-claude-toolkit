# Dataverse write path: changelog

One line per release from 1.11.5. Earlier releases are described in their pull requests and squash commits
(`git log -- dataverse hooks`).

- **1.11.5** (2026-10-09) Guard: two text heuristics now judge what a command does instead of matching words.
  The keystroke/click injection rule matches only a call that sends input (a send-keys or Win32 input call
  with its parenthesis, an input library's action call, an input tool given an action, a hotkey or AU3
  script run); a lookup, an install, a grep and a non-executable file (.md, .txt, .json) are no longer
  read as injection. The home-folder rule blocks only a recursive command whose own target is the home
  folder, a folder above it or a drive root (a Python `except ... as e:` is no longer a drive, nor `.find(`
  the find command). The plugin-files rule counts a redirect only when it writes into the plugin, so a
  sed or one-liner that merely names the plugin path and writes elsewhere passes. A settings write is refused
  for a prompt-answering hook only when it adds or changes one (keeping one the person installed, such as
  iTerm2's status reporter, passes; an Edit changing that hook's command or a \u-escaped key is now caught). Block messages for the
  injection and home rules now name the rule and the matched token.
  Tests: `engine/test/guard_false_positives.test.js`.
