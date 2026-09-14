---
name: wrapture
description: Zero-code call tracing for Python scripts with the `wrapture` library. Shows, without editing the script, which of its functions ran, in what order, nested how, and how long each took, plus the sqlite3 / requests / httpx calls underneath. Also a strict stand-in for unittest.mock in tests. Diagnostic use only. Triggers on "script is slow", "why is this slow", "what is this script actually doing", "trace this", "trace this script", "why did the job do that", "what did the nightly run call", "where does the time go", "mock this API in tests", "stub this call in a test", "wrapture".
---

# wrapture
## Overview
`wrapture` (by Graham Dumpleton, version 1.0.0b1, needs Python 3.12 or newer) watches a Python program while it runs and writes down every call to the functions you name, as an indented tree. The script itself is not edited. A small TOML file lists the functions to watch, and a launcher runs the script under it. This skill covers two uses:

1. **Watch mode**: run one of the user's scripts once and read what it did and where the time went.
2. **Test mode**: in a pytest file, record calls on a timeline or stub one method, as a stricter replacement for `unittest.mock`.

Verified 2026-09-14 against a real project (one read-only CLI subcommand and its full 455-test suite) and re-verified against the installed library during review.
## What watch mode shows
Each function call becomes two lines. The first line, indented by how deep the call is, says which function started and what kind of arguments it got. The second line says what it returned (`->`) or what error it raised (`!!`), and the time it took in square brackets. Indentation is the call stack: a line indented under another was called by it. So the output answers three questions at once: what ran, who called it, and how long each piece took. Time on a parent line that its children do not account for is the parent's own work.
## Recipe: watch a script
Nothing is installed permanently. `uv run --with` builds a throwaway overlay on top of the project venv and discards it. The starter config ships with this skill at `templates/wrapture.toml` (relative to the skill folder). Copy it into the project, then run from the project folder.

```bash
command -v uv >/dev/null 2>&1 || { echo "Error: uv not found"; exit 1; }
cp templates/wrapture.toml /path/to/myproject/wrapture.toml   # from the skill folder; edit targets, see below
cd /path/to/myproject
uv run --with wrapture --with wrapture-instrumentation \
  python -m wrapture --config wrapture.toml <script.py> <safe args> 2> trace.log
rm wrapture.toml   # leave nothing behind unless the user wants it kept
```

Rules that came out of the trial:

- `python -m wrapture` takes `SCRIPT` or `-m MODULE`; everything after the target belongs to the target, so wrapture's own flags go first.
- Functions defined in the script file itself (`__main__`) cannot be observed from the TOML. With `match` they bind nothing and give no warning; with `name` the launch fails outright (`no member named ...`, exit 1), because at that moment `__main__` is still wrapture's own launcher. Observe importable modules only. If the entry point is a package function with no `__main__` guard (a `cli.py` exposing `main()` is the usual case), write a 2-line launcher: `from myproject.cli import main; main()` and pass that as the script.
- Use a safe command: a `--dry-run`, a read-only subcommand, or a scratch copy of the config and database. In the trial a read-only subcommand ran against a copied sqlite file via a copied config file. Never trace a command that sends notifications, writes to shared documents, or hits a production API.
- Keep `capture = "types"` in the TOML for anything touching client, financial, or health data. It prints `'<str>'` and `'<dict>'` instead of values. `capture = "summary"` prints bounded values and is fine for non-sensitive scripts. Accepted levels: `none`, `reference`, `snapshot`, `summary`, `types`.
- Output goes to stderr; the recipe redirects it to `trace.log`.
- Any `path` or `report` in a `[[sink]]` or `[[window]]` is resolved relative to the TOML file's folder, not the working directory. With the TOML in the project root that is the same place, but do not pass a `--config` from another folder and expect the log next to the script.
- `uv run` syncs the project's own venv first. In a project without a lockfile it creates `uv.lock`; check `git status` afterwards.
## Picking targets
Each `[[observe]]` entry names one exact module or class (`target`), then members by `name` (exact) or `match` (glob). `match` selects functions and methods the target itself defines, one level down: no submodules, no nested classes, no inherited methods, no properties. `name` binds anything, properties included, but every listed name must exist. Start with the entry point, the stage functions, and the data-access class:

```toml
[[observe]]
target = "myproject.cli"
match = "cmd_*"

[[observe]]
target = "myproject.db:Database"
name = ["init_schema", "get_appointments", "get_claims"]
```

Find candidates fast: `grep -nE '^def |^    def ' src/<pkg>/*.py`. Three to five entries is the right size for a first look. `match = "*"` on a module is fine but pair it with `exclude` or a `depth` gate on the sink or tiny helpers will flood the tree (74 `_fmt_cents` lines in the trial before `depth = 2`).

Built-in instrumentation covers libraries by name: `[[instrument]] name = "sqlite3"` (also `requests`, `httpx`, `urllib3`, `http.client`, `sqlalchemy`, `flask`, `fastapi`, `django`, and more). List what is available with `uv run --with wrapture --with wrapture-instrumentation python -m wrapture.tools instrumentation`; add `--toml` to print ready-to-paste disabled entries. SQL text is off by default (`statement = false`); leave it off on client or financial data.

Misspelled keys anywhere in the TOML fail loudly at load with `ConfigError` (checked: `targt`, `mach`, `dept`, `captur`, `statment` all rejected). Misspelled values do not, see the next section.
## Reading the tree
```text
myproject.cli:cmd_worklist(cfg='<Config>', args='<Namespace>')
  sqlite3:connect('<PosixPath>')
  sqlite3:connect -> '<Connection>' [139us]
  myproject.db:Database.init_schema()
    sqlite3:Connection.executescript(sql_script='<5299 chars>')
    sqlite3:Connection.executescript -> '<Cursor>' [109us]
  myproject.db:Database.init_schema -> '<NoneType>' [323us]
  myproject.stages.worklist:build_worklist(db='<Database>')
    myproject.stages.worklist:_load_appointments(db='<Database>', run_id='<int>')
      sqlite3:Connection.execute(sql='<133 chars>', parameters='<1 values>')
      sqlite3:Connection.execute -> '<Cursor>' [22us]
    myproject.stages.worklist:_load_appointments -> '<list>' [951us]
  myproject.stages.worklist:build_worklist -> '<dict>' [1.1ms]
myproject.cli:cmd_worklist -> '<int>' [2.6ms]
```

- `module:function(args)` opens a call; the matching `module:function -> result [time]` closes it. `!!` in place of `->` means it raised, followed by the exception class name, for example `mylib:boom !! ValueError [2us]`. A property read shows as `get module:Class.prop`.
- Units adapt: `us`, `ms`, `s`. Compare a parent's bracket with the sum of its children: `build_worklist` took 1.1ms, of which `_load_appointments` was 0.95ms, so the query dominates, not the Python.
- A function you named that never appears either was not called on this path or its module was never imported. A misspelled `target` module is not an error up front; it surfaces as `sys:1: ConfigWarning: observe targets never bound: ...` at exit. Always read the last line of the trace.
- A misspelled member in `name` is worse: when the module is imported wrapture warns `ConfigWarning: observe target '...' failed to bind ... no member named '...'` and drops the entire entry, including the correctly spelled names next to it. Grep the trace for `ConfigWarning` before trusting a missing function. If the module was already imported before the script started (`os.path`, `sqlite3`, `__main__`), the same misspelling is a hard error at launch instead: `wrapture: observe target ... no member named ...`, exit 1.
- Too noisy: add `depth = 2` to the `[[sink]]` (only the top two levels of each tree), or `filter = { path = "myproject.stages.*" }` (keeps only events whose path matches; nesting of the survivors is preserved).
- Long or repeated runs: swap the printer for a `[[sink]]` with `type = "jsonlines"` and `path = "trace-{date}.jsonl"`, and add the commented `[[window]]` block from the template (`[[window.collect]] type = "aggregate"`) for a per-function totals table written at exit instead of a line per call. Writing `type = "aggregate"` directly under `[[window]]` is rejected.
## Under pytest
Run the suite with the same TOML: `uv run --with wrapture --with wrapture-instrumentation python -m wrapture --config wrapture.toml -m pytest tests -q`. Two things bite:

- pytest captures stderr, so a stderr printer shows nothing while every test passes. Either pass `-s` or set `path = "trace.log"` on the printer sink. The trial's first pytest run produced zero lines for this reason; with `path` it recorded about 13,000 calls (26,004 lines).
- Overhead was within noise on the 20-second suite (455 tests, 20.45s traced). On a 50ms CLI run the traced wall clock roughly doubled (about 0.05s bare vs 0.10s traced across three runs each) because wrapture's own import cost dominates. Do not read absolute wall-clock deltas on tiny scripts; read the per-call brackets.
## Test mode: timeline and stubs vs unittest.mock
Record real calls and assert on them. `binding.events` is an `EventLog` and is readable only inside the `with` block (outside it raises):

```python
import wrapture
from myproject.db import Database

def test_summary_follows_log(db):
    log_time = wrapture.binding(Database, "log_time")
    summary = wrapture.binding(Database, "timelog_summary")
    with wrapture.timeline(log_time, summary) as tape:
        db.log_time(None, actor="alice", event="manual_review", minutes=5)
        db.timelog_summary()
        log_time.events.with_args(actor="alice").assert_once()
        tape.assert_order(log_time, summary)
    print(tape.tree(times=True))   # one line per call, real argument values, [time]
```

Other `EventLog` filters and checks that exist: `with_args(**kw)`, `with_instance`, `returning`, `raising`, `assert_once()`, `assert_never()`, `assert_times(n)`, `assert_at_least(n)`, `assert_at_most(n)`, `count`, `first`, `last`.

Stub one method, leave everything else real. With `unittest.mock` this is `patch.object(Database, "timelog_summary", return_value=fake)`. With wrapture, same effect, strict signature:

```python
with wrapture.binding(Database, "timelog_summary").on_call.returns(fake):
    ...
```

Why prefer it over `unittest.mock` here: the binding is strict by default. A misspelled method name raises at creation (wrapt's `PathResolutionError`, a subclass of `AttributeError`), and a stubbed call with a wrong argument raises `TypeError` against the real signature (verified in the trial and again in review). `MagicMock` passes both silently. Failure injection is `.on_call.raises(TimeoutError("down"))`. Keep `unittest.mock` when a test genuinely needs a spec-less object invented on the fly, or when adding a dependency to a repo is not wanted.

Optional: wrapture ships an opt-in pytest plugin (`-p wrapture.pytest_plugin`, not auto-loaded) that fails tests which leak an applied binding and provides a `tape` fixture spanning the test. Not used in the trial.
## Known limitations that matter
- **Python 3.12 or newer.** For a project whose `pyproject.toml` declares `>=3.11`, run it with `uv run --python 3.12 ...` only if its dependencies allow it, otherwise skip.
- **Threads and `run_in_executor` record nothing on a timeline.** On 3.12/3.13 a new thread starts with an empty context. Watch mode (a `[[sink]]`) still hears thread calls; a test timeline does not, and raises `RecordingGapWarning` once and counts `binding.missed_calls`. Fix in a test with `threading.Thread(target=wrapture.propagate(fn))`. Treat `loop.run_in_executor` work as unrecorded. asyncio tasks are fine. The warning and the count fire only when no global `[[sink]]` is active: run the same test under `python -m wrapture` with a sink configured and the thread call goes to the sink instead, the tape still misses it, and nothing warns (checked in review).
- **C extensions cannot be patched.** `list`, `dict`, `str`, and extension-module attributes fail at apply. The `sqlite3` instrumentation works because it wraps the Python-level module; observe the Python call sites that use C objects, not the objects.
- **Targets must be importable by the script.** Config entries wait for the import, so a module the script never imports is silently unobserved until the exit-time `ConfigWarning`. Functions in the script file itself (`__main__`) are never observed from config (`match` is silent, `name` fails the launch). In-code `wrapture.binding()` needs the module imported first.
- **`match` selects functions and methods the target itself defines, one level deep**, no inherited methods, no properties, no nested classes. Use `name` for those.
- **Attribute bindings on a module-level constant swap the module's type** while applied (call bindings on functions do not); harmless in practice, `isinstance` still passes, but `type(mod) is ModuleType` is False for that span.
- Beta software (1.0.0b1). Pin the version if it ever moves past ad-hoc use.
## Rule: diagnostic use only
wrapture is a scalpel for one session, not part of any deployed job. Do not wire it into production services or scheduled jobs yet (cron, launchd, systemd timers, CI pipelines, container entrypoints), and do not add it to any project's `pyproject.toml` dependencies without the user's explicit OK in that conversation. The reason: it is pre-1.0 software with a single maintainer. The `uv run --with` recipe exists so no trace of it remains afterwards; delete the `wrapture.toml` and any `trace*.log` from the project folder when done, or move them to a scratch folder outside the project if the user wants them kept. Traces of scripts that touch client or financial data stay in scratch, never in shared or synced folders.
## Before delivering
Grep the trace for `ConfigWarning` (exit-time unbound targets and import-time dropped `name` entries), confirm `capture` was `"types"` on any sensitive script, confirm the project's `git status` shows no new files from the trace (`wrapture.toml`, `trace*.log`, `trace-*.jsonl`, a new `uv.lock`), and state timings with the caveat above.
