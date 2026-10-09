#!/usr/bin/env node
'use strict';
// SBRM toolkit: the Dataverse guard (Claude Code PreToolUse hook). Ships WITH the engine, never after
// (design note F15): the approval only means something while a session cannot write around the engine
// and cannot answer the approval itself. The session itself RUNS plan and apply once the person has
// agreed in chat (ruled 10/7: nobody pastes an apply line); since 1.11.0 (ruled 10/8) the person's one step
// is Claude Code's own permission prompt, which this guard asks for (see "the approval" below).
//
// What a Claude session may NOT do (the person's own `!` lines are not tool calls and never reach it):
//   1. reach the engine's write side without the CLI: inline code or a script that loads the write
//      module or the apply functions (the bypass that skips the approval altogether, same hole as the
//      QBO guard's rule C). The CLI's `apply` / `resolve` on its own line is ASKED (1.11.0): Claude Code prompts the person;
//   2. write through the Dataverse CLI's own write verbs, or a Dataverse MCP tool that is not a known
//      read (ALLOW-LIST, both the old `mcp__dataverse-*__` and the plugin-namespaced names);
//   3. send a raw writing HTTP call (POST/PATCH/PUT/DELETE) at *.crm.dynamics.com;
//   4. inject keystrokes or clicks (so it cannot press Approve), ported from the QBO guard's rule D;
//   5. tamper: change the engine's store (plans, log, events, pending, tmp; `jobs` is where Claude
//      saves job files, so it stays writable), change this plugin's folder, or switch hooks off.
// Everything else passes: reads, `check`, `plan`, `show`, `apply`, `resolve`, `revert` (it only plans),
// `doctor`, `report`, `review`, `whoami`, the read connections.
//
// Every block is recorded on this machine and gives a block id the person's Claude can report (1.11.6,
// engine/lib/blocks.js, DESIGN.md §11).
//
// Fails CLOSED: an unreadable tool call is blocked. Self-test: node guard.js --selftest
// Trigger strings below are spelled with character classes so this file does not trip other guards.

const os = require('os');
const path = require('path');
const fs = require('fs');

// ---------- 2. MCP read allow-list + the CLI's write verbs (from dataverse-cli-guard.js, 10/1/26) ----------

const READ_TOOLS = new Set(['describe', 'read_query', 'search', 'search_data', 'file_download', 'list_tables', 'describe_table']);
// mcp__<server>__<tool>: a server whose name mentions Dataverse or the platform it runs on (any prefix: the
// plugin form, the claude.ai connector form `mcp__claude_ai_Dataverse__`, a hand-added one). 10/7 third pass.
function mcpParts(tool) {
  if (!/^mcp__/.test(tool)) return null;
  const i = tool.lastIndexOf('__');
  return i > 5 ? { server: tool.slice(5, i), name: tool.slice(i + 2) } : null;
}
const DV_SERVER = /dataverse|dynamics|power.?platform|powerapps|power.?automate|\bcrm\b|_crm_|-crm-|donorapp|d365|msdyn/i;
// The Dataverse MCP server's own write tools, under ANY server name (final re-verify: a server named
// "donorapp" or "d365" slipped the name test). No other installed server uses these names.
const DV_WRITE_TOOLS = /^(?:create_record|update_record|delete_record|upsert_record|create_table|update_table|delete_table|upsert_skill|delete_skill|init_file_upload|commit_file_upload|create_records|update_records|delete_records|execute_action|bulk_\w+)$/i;
// MCP tools that run a shell or code: their command text gets every shell rule.
const SHELL_MCP = /shell|powershell|terminal|run_command|execute_command|start_process|exec_command|run_script|bash|cmd_tool|interact_with_process/i;
// Tools whose input is CODE run against a page or a host (a browser's JavaScript, a fetch tool): only these
// get the "writing HTTP call from another tool" check; a mail, chat or notes tool merely MENTIONING the Web
// API is not a call (final re-verify false positives).
const CODE_MCP = /javascript|evaluate|execute_script|run_js|fetch|http_request|web_request|request_url/i;
// The model-driven app's own client API writes, from a browser tab on the app (no host or method in text).
const XRM_WRITE = /\bXrm\.WebApi\.(?:createRecord|updateRecord|deleteRecord|execute|executeMultiple|online\.\w+)|\b(?:Xrm\.Page|formContext)\.data\.(?:save|entity\.save|refresh\s*\(\s*true)|\.data\.save\s*\(|Xrm\.Utility\.invokeProcessAction/i;

// The TARGET of a request: the first URL on the line (curl, wget, Invoke-*, requests, fetch all take the
// URL first), or a relative /api/data path (a script on the app's own origin). A request to BookStack or
// Graph whose BODY merely mentions the app's URL is not a Dataverse write (final re-verify false positive).
const URL_RE = /https?:\/\/[^\s"'`)<>]+|(?<![\w.\/])\/api\/data\/v9[^\s"'`)<>]*/gi;
function targetsDataverse(text) {
  let elsewhere = false;
  for (const line of String(text).split(/[\n;|&]/)) {
    if (!MUTATING_HTTP.test(line)) continue;
    URL_RE.lastIndex = 0;
    const m = URL_RE.exec(line);
    if (!m) continue;
    if (/\.crm\d*\.dynamics\.com|^\/api\/data\/v9/i.test(m[0])) return true;
    elsewhere = true; // a write whose target is another service
  }
  // A write whose URL is in a variable (`url = "https://x.crm..."` then `requests.patch(url, ...)`): Dataverse
  // and a write method in the same text, and no write line aimed anywhere else.
  return !elsewhere && DV_HOST.test(text) && MUTATING_HTTP.test(text);
}
// While an approval is waiting, no tool may drive the screen, mouse or keyboard (it could press Yes).
const SCREEN_TOOL = /computer|mouse|keyboard|left_click|right_click|double_click|key_press|type_text|cua\b|screen_control|click|shortcut|hotkey|keystroke|press_key|type-tool|type_tool|drag|scroll-tool|automation/i;

// The CLI as a shell word (dataverse, dataverse.exe, dataverse.cmd, npx @microsoft/dataverse). Its
// arguments are parsed past its GLOBAL options (`dataverse --help` lists exactly three: --log-level <v>,
// --log-file, --context <v>), so a write verb cannot hide behind a leading flag; any OTHER leading flag is
// unknown and fails closed (10/7 re-verify: `dataverse --env x data create` was allowed).
const CLI_RE = /(?:^|[\s"'`&|;(\/\\])(?:npx\s+(?:-y\s+)?@microsoft\/)?dataverse(?:cli)?(?:@[\w.^~-]+)?(?:\.exe|\.cmd|\.ps1|\.js)?["'`]?(?=\s)/gi;
const GLOBAL_WITH_VALUE = new Set(['--log-level', '--context']);
const GLOBAL_FLAG = new Set(['--log-file']);

function cliWords(rest) {
  return (rest.match(/"[^"]*"|'[^']*'|[^\s"';|&<>]+/g) || []).map((w) => w.replace(/^["']|["']$/g, ''));
}

// Words that run the next word as a command.
const CMD_WRAPPERS = new Set(['time', 'env', 'sudo', 'nice', 'ionice', 'nohup', 'command', 'exec', 'xargs', 'npx', 'pnpm', 'yarn', 'bunx', 'call', 'start',
  'timeout', 'gtimeout', 'caffeinate', 'stdbuf', 'watch', 'retry', 'chronic', 'unbuffer', 'dlx', 'x']);
// Shell grammar that can stand before a command in a loop, a conditional or a block (final re-verify: a
// bulk update written as `for ...; do dataverse data update ...; done` was read as the command "do").
const CONTROL_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(', '((', '&', 'begin', 'process', 'end']);
const CLI_WORD = /^(?:@microsoft\/)?dataverse(?:cli)?(?:@[\w.^~-]+)?(?:\.exe|\.cmd|\.ps1|\.js)?$/i;
const base = (w) => String(w || '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop();

// The CLI's arguments when this simple command RUNS the Dataverse CLI (as its command word, past env
// settings and wrappers like npx/time/xargs, or as the script node runs: the npm shim's bin/dataverse.js),
// else null. Prose that merely mentions "dataverse" (a commit message, an echo, a job file's reason in a
// heredoc) is not a CLI run (10/7 review false positives).
function cliCallArgs(seg) {
  // `$(which dataverse)` / `` `command -v dataverse` `` run the CLI as surely as its name does.
  const s = seg.replace(/\$\(\s*(?:which|command\s+-v|where|Get-Command)\s+([^\s)]+)[^)]*\)|`\s*(?:which|command\s+-v)\s+([^\s`]+)\s*`/gi, (m, a, b) => a || b)
    // PowerShell blocks: `foreach ($x in $y) { dataverse ... }`, `$list | ForEach-Object { dataverse ... }`
    .replace(/^[\s\S]*?\{\s*/, (m) => (/\b(?:foreach|ForEach-Object|%|if|while|for|try|else)\b[\s\S]*\{\s*$/i.test(m) ? '' : m));
  let words = cliWords(s);
  let afterWrapper = false;
  for (;;) {
    if (!words.length) return null;
    const w = words[0];
    const b0 = base(w).toLowerCase();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || CONTROL_WORDS.has(w)) { words = words.slice(1); continue; }
    // `(dataverse ...)`, `{dataverse ...`, `!dataverse ...`: the grouping character sits on the word.
    if (/^[({!]+./.test(w)) { words = [w.replace(/^[({!]+/, ''), ...words.slice(1)]; continue; }
    // A wrapper's own options and arguments (`timeout 30s`, `xargs -I{} -n1`, `npm exec --`): skipped.
    if (afterWrapper && (/^-/.test(w) || /^\d+[smhd]?$/.test(w) || w === '--')) { words = words.slice(1); continue; }
    if (CMD_WRAPPERS.has(b0) || ((b0 === 'npm' || b0 === 'pnpm' || b0 === 'yarn') && ['exec', 'dlx', 'x'].includes((words[1] || '').toLowerCase()))) {
      words = words.slice(b0 === 'npm' || b0 === 'pnpm' || b0 === 'yarn' ? 2 : 1);
      afterWrapper = true;
      continue;
    }
    break;
  }
  const b = base(words[0]);
  if (CLI_WORD.test(b) || /^@microsoft\/dataverse/i.test(words[0])) return words.slice(1);
  if (/^node(?:\.exe)?$/i.test(b) && words[1] && /^dataverse(?:\.js)?$/i.test(base(words[1]))) return words.slice(2);
  return null;
}

// Remove heredoc / here-string BODIES (data handed to a command, e.g. a job file's JSON), keeping the
// command line itself. Used only for the CLI rule: a body run by an interpreter is still read by the others.
function stripHeredocs(text) {
  // A body handed to a SHELL is commands, not data: kept (`bash <<EOF ... EOF` runs every line).
  let out = text.replace(/([^\n]*)<<-?\s*(['"]?)(\w+)\2[^\n]*\n[\s\S]*?\n\s*\3\s*(?=\n|$)/g, (m, before) => {
    const segs = segments(before);
    const cmd = firstWord(segs[segs.length - 1] || '');
    return ['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'source', '.'].includes(cmd) ? m : m.split('\n')[0];
  });
  out = out.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, '@\'\'@');
  return out;
}

function cliVerdict(command) {
  const stripped = stripHeredocs(command);
  for (const seg of segments(stripped).filter((s) => !isEngineRun(s))) {
    // A string handed to a shell (bash -c "...", os.system(...)) is a command too: scan it anywhere.
    const found = SHELL_WRAPPER.test(seg) ? scanAnywhere(seg) : null;
    if (found) return found;
    const args = cliCallArgs(seg);
    if (args) {
      const v = judgeCli(args);
      if (v) return v;
    }
  }
  return null;
}

function scanAnywhere(text) {
  CLI_RE.lastIndex = 0;
  let m;
  while ((m = CLI_RE.exec(text)) !== null) {
    if (/--target\s*$/.test(text.slice(0, m.index + 1))) continue; // `--target dataverse` is an argument
    const end = text.slice(m.index + m[0].length).search(/[;|&\n"']/);
    const v = judgeCli(cliWords(text.slice(m.index + m[0].length, end < 0 ? undefined : m.index + m[0].length + end)));
    if (v) return v;
  }
  return null;
}

// The verdict on the CLI's own arguments (past the CLI word): null = a read, else what it would write.
function judgeCli(words) {
  {
    let i = 0;
    while (i < words.length && /^-/.test(words[i])) {
      const w = words[i].toLowerCase().split('=')[0];
      if (GLOBAL_WITH_VALUE.has(w)) i += words[i].includes('=') ? 1 : 2;
      else if (GLOBAL_FLAG.has(w)) i += 1;
      else if (['--version', '-v', '--help', '-h'].includes(w)) { i = -1; break; }
      else return `the Dataverse CLI with the unknown option "${words[i]}"`;
    }
    if (i < 0 || i >= words.length) return null; // version/help, or the word alone
    const sub = words[i].toLowerCase();
    const sub2 = (words[i + 1] || '').toLowerCase();
    const after = words.slice(i + 1).join(' ');
    let ok;
    if (['org', 'env', 'help'].includes(sub)) ok = true;
    // A session never needs the raw bearer token: with it any HTTP tool writes around the approval.
    else if (sub === 'auth') ok = !['token', 'get-token', 'access-token'].includes(sub2);
    else if (sub === 'data') ok = ['query', 'get', 'count', 'describe', '--help', '-h', ''].includes(sub2); // describe: a read, new in 1.0.81
    else if (sub === 'api' && sub2 === 'request') {
      const method = after.match(/(?:--method|-X)(?:\s+|=)["']?([A-Za-z]+)/);
      ok = !(method && method[1].toUpperCase() !== 'GET') && !/--body/.test(after);
    } else if (sub === 'api') ok = ['list', 'describe', '--help', '-h', ''].includes(sub2);
    else if (sub === 'mcp') ok = sub2 !== 'allow';
    else if (/^[a-z][a-z-]*$/.test(sub)) ok = false; // erp, skill, install, or a verb this list does not know
    else return null; // not a CLI call (e.g. a path or a word that only contains "dataverse")
    if (!ok) return `the Dataverse CLI's "${sub}${sub2 ? ' ' + sub2 : ''}"`;
  }
  return null;
}

// ---------- 1. the engine's own writes ----------

// Code that reaches the write side directly: the write connection, the apply functions, or the engine
// entry point loaded as a module (to call runCli with a write verb).
// applySchema / applyComponent: the app development kinds (DESIGN.md §10f), same rule as the rest. Each
// module that holds an apply is named by path too, because a name can be built from pieces at run time
// (10/7 review: `require('.../lib/schema')['apply'+'Schema'](...)` and `path.join(E, 'lib', 'write')`).
const ENGINE_MODULES = '(?:write|apply|schema|component|merge|dialog)';
const ENGINE_INTERNALS = new RegExp(
  '\\b(?:writeConnection|applyPlan|applyMerge|applyUnmerge|applySchema|applyComponent)\\b'
  + `|lib[\\\\/]+${ENGINE_MODULES}(?:\\.js)?['"\`]`
  + `|['"\`]lib['"\`]\\s*,\\s*['"\`]${ENGINE_MODULES}(?:\\.js)?['"\`]`
  + '|require\\(\\s*[\'"`][^\'"`]*dataverse-write'
  // any CODE module loaded from the engine or the plugin (its .json settings are data, a read)
  + '|(?:require|import)\\s*\\(\\s*[\'"`][^\'"`]*(?:dataverse[\\\\/]+engine|sbrm-claude-toolkit)[^\'"`]*(?<!\\.json)[\'"`]');

// ---------- 3. raw writing HTTP at Dataverse ----------

const DV_HOST = /[\w-]+\.crm\d*\.dynamics\.com|\bdynamics\.com\b|\bapi\/data\/v9/i;
// A writing HTTP request in any common spelling (10/7 re-verify: -Method:Post, -Me Patch, curl -d / --json
// / -T, requests.post, fetch with a method, Invoke-WebRequest -Body).
const MUTATING_HTTP = new RegExp([
  '(?:-X|--request)\\s*["\']?(?:POST|PATCH|PUT|DELETE|MERGE)\\b',
  '-Me(?:t(?:h(?:o(?:d)?)?)?)?(?::|\\s+)["\']?(?:Post|Patch|Put|Delete|Merge)\\b',
  'method\\s*[:=]\\s*["\'`]?(?:POST|PATCH|PUT|DELETE|MERGE)\\b',
  '(?:^|\\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|--json|-T|--upload-file|-F|--form)(?:\\s|=)',
  '\\brequests?\\.(?:post|patch|put|delete|request)\\s*\\(',
  '\\b(?:axios|got|superagent|httpx)\\.(?:post|patch|put|delete)\\s*\\(',
  '-Body\\b|-InFile\\b',
  // 10/7 third pass: any client's .post/.patch/.put/.delete (Session(), httpx.Client(), a fetch wrapper),
  // http.client / requests .request('PATCH', ...), urllib with a body, httpie, wget
  '\\.(?:post|patch|put|delete)\\s*\\(',
  '\\.request\\s*\\(\\s*[\'"`](?:POST|PATCH|PUT|DELETE|MERGE)',
  '\\b(?:urlopen|Request)\\s*\\([^)]*\\bdata\\s*=',
  '\\bhttps?\\s+(?:POST|PATCH|PUT|DELETE)\\b',
  '--post-(?:data|file)\\b|--method[=\\s]+["\']?(?:POST|PATCH|PUT|DELETE|MERGE)\\b|\\bopen\\s*\\(\\s*[\'"`](?:POST|PATCH|PUT|DELETE)',
  // final re-verify: combined curl flags (-sd, -sSd), .NET HttpClient, -CustomMethod, jQuery/axios `type:`
  '(?:^|\\s)-[a-zA-Z]*d(?:\\s|=|[\'"])',
  '\\.(?:Post|Patch|Put|Delete|Send)Async\\s*\\(|\\bHttpMethod\\.(?:Post|Patch|Put|Delete)|new\\s+HttpMethod\\s*\\(\\s*[\'"](?:PATCH|MERGE)',
  '-CustomMethod\\s+["\']?(?:POST|PATCH|PUT|DELETE|MERGE)',
  '\\b(?:type|verb)\\s*:\\s*["\'`](?:POST|PATCH|PUT|DELETE|MERGE)["\'`]',
].join('|'), 'i');

// Other tools that write to Dataverse: the Xrm PowerShell module's record cmdlets and the Power Platform CLI.
// (`pac auth ...` is a sign-in, not a write; final re-verify false positive.)
const OTHER_DV_WRITERS = /\b(?:Set|New|Remove|Update|Add|Import|Publish|Merge|Invoke|Approve|Grant|Revoke)-Crm\w*|\bpac\s+(?!auth\b|help\b|org\s+(?:list|who)\b)[^;|&\n]*\b(?:import|create|delete|update|upsert|publish|push|deploy|assign|set|install|upgrade|clone|add|remove|reset)\b|\b(?:CrmServiceClient|ServiceClient|Microsoft\.Xrm\.Tooling)\b[\s\S]{0,400}\.(?:Create|Update|Delete|Execute|Associate|Disassociate)(?:Async)?\s*\(/i;

// The Dataverse CLI called with its arguments as a LIST (Python subprocess, Node execFile/spawn), where the
// words are quoted and comma-separated, so the shell-shaped CLI rule never matches (10/7 review). Any
// list-form call naming the CLI with a write method, a body or a data write verb is blocked.
const CLI_LIST = /['"`]dataverse(?:cli)?(?:\.exe)?['"`]\s*,/i;
const LIST_WRITE = /['"`](?:--method|-X)['"`]\s*,\s*['"`](?:POST|PATCH|PUT|DELETE|MERGE)['"`]|['"`]--body(?:-file)?['"`]|['"`](?:create|update|upsert|delete|upload|associate|disassociate)['"`]/i;

// ---------- 4. keystroke / click injection (the QBO guard's rule D, same spelling trick) ----------
//
// 1.11.5 (false positives 10/9, a terminal-setup review): the rule matched the mere NAMES of input tools, so it
// blocked a monitor-size read (the Forms assembly's Screen class), a check whether automation tools were
// installed (a lookup by name, an uninstall-list filter), a plan written in markdown that said none were
// installed, and a grep for the rule's own words. It now matches only the construct that SENDS input: a call
// with its parenthesis or argument, an import paired with an action call, a command-line tool given an action,
// a script handed to the hotkey or AU3 runtimes. What is NOT injection: a bare product name, a lookup
// (Get-Command, which, where, an uninstall-list search), a grep/echo whose text holds the words, and the Forms
// assembly used for Screen, Clipboard or MessageBox.
const INJECT_ACTIONS = '(?:click|doubleClick|rightClick|middleClick|tripleClick|press|release|keyDown|keyUp|hotkey|typewrite|write|tap|type|moveTo|moveRel|move|dragTo|dragRel|drag|mouseDown|mouseUp|scroll|hscroll|vscroll|press_and_release|send_keys|type_keys|click_input)';
const INJECT_CALLS = [
  // .NET, WSH, VBScript, JScript: the send-keys call in each spelling, and the window-focus call it pairs with
  '\\bSend[K]eys\\s*\\]\\s*::\\s*Send(?:Wait)?\\b',
  '\\.Send[K]eys\\s*[("\'\\s]',
  '\\bSend[K]eys\\s*\\(',
  '\\.App[A]ctivate\\s*[("\'\\s]',
  // Win32 input calls, called or declared (a P/Invoke or ctypes declaration carries the parenthesis too)
  '\\b(?:Send[I]nput|keybd[_]event|mouse[_]event|Post[M]essage[AW]?)\\s*\\(',
  // Python input libraries: a dotted action call, or an import plus any action call later in the same text
  `\\b(?:py[a]utogui|pydirect[i]nput)\\s*\\.\\s*${INJECT_ACTIONS}\\s*\\(`,
  `\\b(?:import|from)\\s+(?:py[a]utogui|pydirect[i]nput|pyn[p]ut|py[w]inauto)\\b[\\s\\S]*?\\b${INJECT_ACTIONS}\\s*\\(`,
  '\\.(?:click_input|double_click_input|right_click_input|type_keys|send_keystrokes|send_chars|press_mouse_input|wheel_mouse_input)\\s*\\(',
  // keyboard/mouse modules (Python's, the Node nut-js library's) and the Node robot library
  '\\bkeyboard\\s*\\.\\s*(?:press|release|write|send|type|press_and_release|pressKey|releaseKey|tap)\\s*\\(',
  '\\bmouse\\s*\\.\\s*(?:click|press|release|leftClick|rightClick|doubleClick|move|setPosition|drag|scrollUp|scrollDown|scroll)\\s*\\(',
  '\\brobot\\s*\\.\\s*(?:keyTap|keyToggle|typeString\\w*|mouseClick|mouseToggle|moveMouse\\w*|dragMouse|scrollMouse)\\s*\\(',
  // The AU3 COM object, and Windows UI Automation patterns that act
  '\\.(?:ControlClick|ControlSend|MouseClick|MouseClickDrag)\\s*\\(',
  '\\bAuto[I]tX3\\b[\\s\\S]{0,400}\\.Send\\s*\\(',
  '\\b(?:InvokePattern|TogglePattern|ExpandCollapsePattern|SelectionItemPattern|ValuePattern|LegacyIAccessiblePattern)\\b[\\s\\S]{0,400}\\.(?:Invoke|Toggle|Expand|Select|SetValue|DoDefaultAction)\\s*\\(',
  '\\b(?:Invoke|Set|Send|Move)-UI[A]\\w+',
  // Command-line input tools given an action
  '\\b[xy]do[t]ool\\b[^\\n;|&]*?\\s(?:key|keydown|keyup|type|click|mousedown|mouseup|mousemove|windowactivate)\\b',
  '\\bcl[i]click\\b[^\\n;|&]*?\\s(?:c|dc|rc|tc|kd|ku|kp|t|m|dd|du|dm):',
  '\\bnir[c]mdc?(?:\\.exe)?["\']?\\s+(?:sendkey\\w*|sendmouse|setcursor\\w*|movecursor|win\\s+activate)\\b',
  // macOS: the system-events app told to type or press, an accessibility action
  'System\\s+Events["\']?[\\s\\S]{0,600}\\b(?:keystroke|key\\s+code|click)\\b',
  'perform\\s+action\\s+["\']?A[X]\\w*|\\bAXUIElementPerform[A]ction\\s*\\(',
].map((s) => new RegExp(s, 'i'));
// The first call-shaped match in `text`, as a short token for the block message, or null.
function injectMatch(text) {
  for (const re of INJECT_CALLS) {
    const m = re.exec(text);
    if (m) {
      const t = m[0].replace(/\s+/g, ' ').trim();
      return t.length > 60 ? `${t.slice(0, 57)}...` : t;
    }
  }
  return null;
}
// The hotkey and AU3 runtimes run a script whose only purpose is sending input: running either with any
// argument, or launching one of their script files, is injection. Naming them (a lookup, an install, a grep) is not.
const INJECT_RUNTIME = /^(?:auto[h]otkey\w*|auto[i]t3\w*)$/i;
const INJECT_SCRIPT = /\.(?:a[h]k|au3)["']?$/i;
const LAUNCHERS = new Set(['start', 'start-process', 'saps', 'invoke-item', 'ii', 'explorer', 'cmd', 'call', '&', 'wscript', 'cscript']);
// Commands that only look things up or print text: their arguments are data (the 10/9 grep for the rule's own
// words, a Get-Command lookup by name). Exempt only while they write no file and the line feeds nothing to an
// interpreter (`echo "<send call>" | powershell` runs it).
const LOOKUP_CMDS = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'findstr', 'select-string', 'sls', 'get-command', 'gcm',
  'where', 'which', 'type', 'echo', 'printf', 'write-output', 'write-host', 'cat', 'get-content', 'gc', 'head', 'tail', 'less', 'more',
  'ls', 'dir', 'gci', 'get-childitem', 'test-path', 'get-item', 'gi', 'get-itemproperty', 'gp', 'get-package', 'get-appxpackage', 'git', 'gh', 'wc']);
const FEEDS_INTERPRETER = /\|\s*["']?(?:\S*[\\/])?(?:bash|sh|zsh|dash|pwsh|powershell|python[\d.]*|py|node|cscript|wscript|osascript|perl|ruby|cmd|iex|Invoke-Expression|auto[h]otkey\w*|auto[i]t3\w*)(?:\.exe)?\b/i;
// Heredoc bodies written to a non-executable file (`cat > notes.md <<EOF`) are prose, not code.
function dataHeredocsRemoved(text) {
  return text.replace(/([^\n]*)<<-?\s*(['"]?)(\w+)\2[^\n]*\n[\s\S]*?\n\s*\3\s*(?=\n|$)/g, (m, before) => {
    const target = (before.match(/>{1,2}\s*("[^"]+"|'[^']+'|[^\s;|&]+)/) || [])[1];
    const first = firstWord(before);
    return target && !EXEC_FILE.test(target.replace(/^["']|["']$/g, '')) && ['cat', 'tee'].includes(first) ? m.split('\n')[0] : m;
  });
}
// null, or { token, where } for a shell line that sends input.
function shellInjection(text) {
  const feeds = FEEDS_INTERPRETER.test(text);
  const segs = segments(dataHeredocsRemoved(text)).filter((s) => !isEngineRun(s));
  const live = [];
  for (const seg of segs) {
    const first = firstWord(seg);
    if (LOOKUP_CMDS.has(first) && !feeds && !REDIRECT.test(unquoted(seg.replace(HARMLESS_REDIRECT, ' ')))) continue;
    live.push(seg);
    const words = (seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^["'({]+|["')}]+$/g, ''));
    const bases = words.map((w) => base(w).replace(/\.exe$/i, '').toLowerCase());
    const runsAt = (i) => i === 0 || LAUNCHERS.has(bases[i - 1]) || /^-(?:FilePath|ArgumentList)$/i.test(words[i - 1] || '');
    for (let i = 0; i < words.length; i += 1) {
      if (INJECT_RUNTIME.test(bases[i]) && runsAt(i) && words.length > i + 1) {
        return { token: `${words[i]} ${words[i + 1]}`, where: 'a hotkey or AU3 script run' };
      }
      if (INJECT_SCRIPT.test(words[i]) && (runsAt(i) || INJECT_RUNTIME.test(bases[i - 1] || ''))) {
        return { token: words[i], where: 'a script launched' };
      }
    }
  }
  const token = injectMatch(live.join(' ;\n'));
  return token ? { token, where: 'a call that sends input' } : null;
}
// Files that RUN: only these are scanned for injection when written (prose cannot press anything, 10/9).
const EXEC_FILE = /\.(?:js|cjs|mjs|jsx|ts|tsx|py|pyw|ps1|psm1|sh|bash|zsh|ksh|fish|cmd|bat|rb|pl|php|go|cs|vb|vbs|vbe|wsf|jse|hta|a[h]k|au3|applescript|scpt|swift|lua|java|kt|ipynb)$/i;
const isExecFile = (file, text) => EXEC_FILE.test(file) || (!/\.[\w-]+$/.test(path.basename(String(file))) && /^#!/.test(text));

// ---------- 6. code that runs out of sight: decoded or preloaded (10/7 re-verify) ----------

const HIDDEN_CODE = /\beval\s*\(\s*(?:Buffer\.from|atob|decodeURIComponent|unescape)|FromBase64String[\s\S]{0,200}(?:\biex\b|Invoke-Expression|\.Invoke\(|ScriptBlock)|(?:base64\s+(?:-d|--decode)|certutil\s+-decode)[\s\S]{0,80}\|\s*(?:sh|bash|node|python3?|pwsh|powershell)\b|\bNODE_OPTIONS\b[^;&|\n]*(?:--require|-r\b|--import|--loader|--experimental-loader)|(?:^|\s)node(?:\.exe)?\s+(?:[^\n;&|]*\s)?(?:--require|-r|--import|--loader)\s+\S*(?:dataverse|sbrm)/i;

// ---------- 7. switching the plugin (and so its guard) off ----------

const PLUGIN_OFF_SHELL = /\bclaude\s+plugin\s+(?:disable|uninstall|remove|rm)\b|\bclaude\s+plugin\s+marketplace\s+(?:remove|rm)\b/i;
const PLUGIN_OFF_SETTINGS = /["']?sbrm-toolkit@sbrm-claude-toolkit["']?\s*:\s*false|["']?enabledPlugins["']?\s*:\s*\{\s*\}/i;

// ---------- 5. tamper ----------

// The account's own folder from the OS, not a HOME/USERPROFILE a command line can override (10/7).
const HOME = (() => { try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); } })();
function norm(p) {
  let s = String(p || '').replace(/\\/g, '/');
  if (s.startsWith('~/')) s = HOME.replace(/\\/g, '/') + s.slice(1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

// A file path as the file system will resolve it (10/7 review: a Write to `C:/Users/ABCDEF~1/.sbrm-dataverse/
// plans/x.json`, an 8.3 short name, or through a `..` segment, slipped past the folder checks): `..` folded,
// and the deepest part that exists expanded to its real long name. Never throws; falls back to norm().
function real(p) {
  try {
    let s = String(p || '');
    if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(HOME, s.slice(2));
    let cur = path.resolve(s);
    const tail = [];
    while (!fs.existsSync(cur)) {
      const up = path.dirname(cur);
      if (up === cur) break;
      tail.unshift(path.basename(cur));
      cur = up;
    }
    return norm(path.join(fs.realpathSync.native(cur), ...tail));
  } catch {
    return norm(p);
  }
}
const STORE = norm(path.join(HOME, '.sbrm-dataverse'));
// `config` holds this machine's developer exemptions (dev_dirs.json, 1.10.0): a session must not grant
// itself one, exactly as it must not edit the plugin's own toolkit.json.
const PROTECTED_STORE = ['plans', 'log', 'events', 'pending', 'tmp', 'config'];
function inProtectedStore(p) {
  return [norm(p), real(p)].some((n) => PROTECTED_STORE.some((d) => n === `${STORE}/${d}` || n.startsWith(`${STORE}/${d}/`)));
}
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT ? norm(process.env.CLAUDE_PLUGIN_ROOT) : null;
}
function inPlugin(p) {
  const root = pluginRoot();
  return [norm(p), real(p)].some((n) => (root && (n === root || n.startsWith(root + '/')))
    || /\/\.claude\/plugins\/(?:cache|marketplaces)\/sbrm-claude-toolkit\//i.test(n));
}
const SETTINGS_FILE = /\/\.claude\/settings(?:\.local)?\.json$|\/managed-settings\.json$/i;
// Only switching hooks OFF: setting it back to false is doctor's own fix and must pass (10/7).
const HOOKS_OFF = /disable[A]llHooks["'`]?\s*[:=]\s*["'`]?(?:true|\$true|1)\b/i;
const PROMPT_ANSWERER = /Permission[R]equest/;
// Shell verbs plus the file-writing calls of inline code (node -e, python -c), which a quoted script can
// carry straight past a redirect rule.
const SHELL_MUTATE_WORD = /\b(?:rm|del|erase|mv|move|cp|copy|tee|truncate|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Content|Add-Content|Out-File|Clear-Content|New-Item|writeFileSync|writeFile|appendFileSync|appendFile|copyFileSync|renameSync|unlinkSync|unlink|rmSync|rmdirSync|cpSync|symlinkSync|linkSync|openSync|writeSync|createWriteStream|write_text|write_bytes|shutil|rmtree|WriteAllText|WriteAllBytes|WriteAllLines|AppendAllText|AppendAllLines|StreamWriter|ri|rd|rmdir|ni|mi|cpi|rni|sc|ac|robocopy|xcopy|tar|unzip|7z|mklink|ln|Expand-Archive|Compress-Archive|install|link)\b|\bos\.(?:remove|unlink|replace|rename|makedirs|symlink|link|system)\b|::(?:Delete|Replace|Move|Copy|Create|CreateText|AppendText)\b|sed\s+-i|\bopen\s*\([^)]*['"`][wax]\+?b?['"`]|\bFile\.(?:write|open|delete|rename)\b|\bDeno\.(?:write|remove|rename|copy)|\bBun\.write\b/i;
// A redirect writes a file only OUTSIDE quotes: `node -e "x => y"` or a `>` inside a quoted string is code
// or data, not a redirect (false positive found 10/7 evening: a read-only one-liner with an arrow function
// that named the plugin's envs.json was blocked as "changing the toolkit plugin's files"). EXCEPT when the
// quoted text is itself handed to a shell (bash -c, cmd /c, powershell -Command, eval): there a quoted `>`
// is a real redirect, so the whole line is checked.
const REDIRECT = />{1,2}/;
// ...and code that hands a string to a shell (execSync, os.system, subprocess with shell, Start-Process).
const SHELL_WRAPPER = /\b(?:bash|sh|zsh|dash|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^|;&\n]*?\s(?:-c|\/c|\/k|-Command)\b|\beval\b|\bInvoke-Expression\b|\biex\b|\b(?:execSync|exec|spawnSync|spawn|execFileSync|system|popen|Popen|check_output|check_call|getoutput|getstatusoutput)\s*\(|\bsubprocess\b|\bStart-Process\b/i;

// The store named WITHOUT a protected folder in it (`cd ~/.sbrm-dataverse && echo x > config/...`, 10/7
// review): anything mutating in a line that reaches the store outside its writable `jobs` folder.
const STORE_ANY = /\.sbrm-dataverse(?![\\/]+jobs(?:[\\/]|\b))/i;
// Moving the engine's store or config for a run puts plans in a folder the guard does not protect (review);
// so does pointing the home folder somewhere else (re-verify: USERPROFILE=/HOME= on a run).
// A PERSISTENT env var (SetEnvironmentVariable, Set-Item env:, setx) outlives this shell, so it is refused
// when its name is computed or on the deny list: the home folder, PATH, node/npm, the loader, Claude, the
// Dataverse CLI, and shell start-up files (a persistent NODE_OPTIONS or BASH_ENV runs code in every later
// engine or shell run). Any other literal name is fine: refusing them all blocked storing an unrelated
// app key (false positive 10/8, an sbrm-logs Grist key).
const ENV_DENY = '(?:USERPROFILE|HOME\\w*|PATH\\w*|PSModulePath|NODE_\\w*|NPM_\\w*|DYLD_\\w*|LD_\\w*|SBRM_DV\\w*|SBRM_DATAVERSE\\w*|DATAVERSE\\w*|CLAUDE\\w*|ANTHROPIC\\w*|BASH_ENV|ENV|XDG_\\w*|COMSPEC|SHELL|APPDATA|LOCALAPPDATA)';
const ENV_SAFE = `(?!${ENV_DENY}\\b)[A-Za-z_][A-Za-z0-9_]*`;
const STORE_MOVE = new RegExp([
  '\\bSBRM_DV_(?:HOME|CONFIG)\\b', '\\bSBRM_DATAVERSE_CLI\\b',
  `\\[(?:System\\.)?Environment\\]::SetEnvironmentVariable\\s*\\((?!\\s*(?<q1>['"])${ENV_SAFE}\\k<q1>\\s*,)`,
  `\\bSet-Item\\b[^;|&\\n]*?\\benv:(?![\\\\/]?${ENV_SAFE}['"]?(?:\\s|$))`,
  `\\bsetx(?:\\.exe)?\\b(?!\\s+(?<q2>['"]?)${ENV_SAFE}\\k<q2>\\s)`,
].join('|'), 'i');
// The home folder set for ONE run (an assignment prefix on a command, through `env`, or PowerShell's $env:).
// 1.11.6: judged apart from the rules above. In a Claude shell it is refused on ANY line, quotes read as spaces
// (so `bash -c "..."` and a quoted word handed to env count too): quoted text runs in too many ways ($(...),
// bash -lc, a pipe into sh) to tell apart, and the next command on the line could start Claude Code with no
// plugins. In a code FILE it is refused only when the file is about Dataverse or runs Claude Code itself (a
// moved home loads no plugins, so no guard): a Fly.io entrypoint dropping privileges through setpriv and env
// with the home set to /data/x was refused as moving the store (false positive 10/9).
const HOME_VARS = '(?:USERPROFILE|HOME|HOMEPATH|HOMEDRIVE)';
const HOME_MOVE = new RegExp(`(?:^|[\\s;&|(])${HOME_VARS}=|\\$\\{?env:${HOME_VARS}\\}?\\s*=`, 'i');
// Quotes read as spaces, and also deleted along with backslashes (a split-up spelling of the name).
const homeMoved = (text) => [String(text).replace(/["'`]/g, ' '), String(text).replace(/["'`\\]/g, '')].some((t) => HOME_MOVE.test(t));
const DV_RELATED = /dataverse|SBRM_DV|SBRM_DATAVERSE|sbrm-claude-toolkit|sbrm-toolkit|CLAUDE_PLUGIN_ROOT|\.crm\d*\.dynamics\.com|\bapi\/data\/v9/i;
// `claude` (lowercase) as the COMMAND of a line that is not a comment: at its start, after a separator, `$(`,
// a call operator or an argument list's bracket, or after exec/env/sudo/npx and the like, past flags and
// assignments; with its own path if any (`~/.local/bin/claude`, `C:\...\claude.exe`, `$BIN/claude`). A folder
// named claude (`/home/claude`, `--reuid=claude`) or the word in an echo is not a run.
const CLAUDE_RUN = new RegExp(String.raw`(?:^[ \t]*|[;&|(\[` + '`' + String.raw`]\s*|\$\(\s*|\b(?:exec|env|nohup|sudo|npx|command|time|xargs)\s+(?:-\S+\s+)*)(?:[A-Za-z_]\w*=\S*\s+)*["']?(?:[~\w.:$\{\}\\/-]*[\\/])?(?:claude(?:\.exe|\.cmd|\.ps1)?|@anthropic-ai\/claude-code(?:@[\w.^~-]+)?)(?=[\s"'` + '`' + String.raw`;|&),\]]|$)`);
const runsClaude = (text) => String(text).split(/\r?\n/).some((l) => !/^[ \t]*(?:#|\/\/|REM\b|::)/i.test(l) && CLAUDE_RUN.test(l));
function storeMoveShell(text) {
  return STORE_MOVE.test(text) || homeMoved(text);
}
function storeMoveCode(text) {
  return STORE_MOVE.test(text) || (homeMoved(text) && (DV_RELATED.test(text) || runsClaude(text)));
}

// A command that NAMES the store (or works inside it after a cd) may only be one of these reads; anything
// else (another language's file API, an archive tool, a link maker, an alias) is refused rather than
// guessed at (10/7 re-verify: 57 of 60 crafted spellings passed a list of banned words).
const STORE_READ_CMDS = new Set(['cat', 'type', 'ls', 'dir', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'findstr',
  'less', 'more', 'wc', 'stat', 'file', 'md5sum', 'sha1sum', 'sha256sum', 'diff', 'cmp', 'echo', 'printf', 'test', '[',
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'gi', 'test-path', 'select-string', 'sls', 'resolve-path',
  'get-filehash', 'measure-object', 'cd', 'set-location', 'sl', 'pushd', 'popd', 'find', 'xxd', 'od', 'jq', 'cut', 'mkdir', 'md']);
const FIND_WRITES = /\s-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/;
function unquoted(text) {
  let out = '';
  let q = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < text.length) { i += 1; continue; }
      if (c === q) q = null;
      out += ' ';
    } else if (c === '"' || c === "'") {
      q = c;
      out += ' ';
    } else out += c;
  }
  return out;
}
const GIT_WRITE = /\bgit\b[^;|&\n]*\b(?:apply|checkout|restore|reset|stash|pull|merge|am|clone|switch|cherry-pick|rebase)\b/i;

function mutates(text) {
  return SHELL_MUTATE_WORD.test(text) || GIT_WRITE.test(text) || REDIRECT.test(SHELL_WRAPPER.test(text) ? text : unquoted(text));
}

// The first command word of a simple command, past `VAR=value` prefixes, lowercased, without a path or .exe.
function firstWord(seg) {
  const words = (seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) || []).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const w = (words[0] || '').replace(/^["']|["']$/g, '');
  return w.split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
}
const STORE_NAMED = (s) => STORE_IN_TEXT.test(s) || STORE_ANY.test(s) || /\.sbrm-dataverse[^\s"'`]*\.\./i.test(s);

// The plan signing key (config/plan.key, 1.10.1) must not be READ by a session either: with it a forged plan
// would verify. Its file, the settings folder, and the store's ROOT (a recursive read or a wildcard there
// sweeps the key in) are off limits to shell text; only a plain non-recursive listing, or reading the
// machine's dev exemptions file by name, passes.
const KEY_NAMED = /\bplan\.key\b/i;
const STORE_ROOT_OR_CONFIG = /\.sbrm-dataverse(?:[\\/]+(?:config\b[^\s"'`;|&]*|\*[^\s"'`;|&]*)|[\\/]*(?=[\s"'`;|&)]|$))/i;
// A recursive read, copy or archive of the home folder, a drive root or any folder above home sweeps the key
// in (final re-verify: `grep -r x ~`, `find ~ -exec cat`, `gci $HOME -Recurse | gc`, robocopy /
// Compress-Archive of home). 1.11.5: judged per COMMAND, on what that command actually targets. Until then the
// rule fired when a home or root token and a recursion word appeared ANYWHERE on the line, so a process trace
// whose prose said "shells / claude" (a lone `/`) and whose Get-CimInstance took `-Filter` (read as `-r`) was
// blocked twice on 10/9, and a fixed file under $env:USERPROFILE could be too.
// Commands that walk a tree by themselves, and those that do only with a flag.
const SWEEP_ALWAYS = new Set(['find', 'tree', 'rg', 'ag', 'ack', 'fd', 'fdfind', 'robocopy', 'xcopy', 'tar', 'bsdtar', '7z', '7za', 'zip', 'rsync', 'compress-archive', 'rclone']);
const PS_RECURSE = /^-(?:r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?|depth)(?::\$?true)?$/i;
const SWEEP_FLAGGED = {
  grep: (f) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(f) || /^--(?:dereference-)?recursive$|^--directories=recurse$/.test(f),
  ls: (f) => /^-[a-zA-Z]*R[a-zA-Z]*$/.test(f) || PS_RECURSE.test(f),
  dir: (f) => /^\/s$/i.test(f) || PS_RECURSE.test(f),
  'get-childitem': (f) => PS_RECURSE.test(f),
  cp: (f) => /^-[a-zA-Z]*[rRa][a-zA-Z]*$/.test(f) || /^--(?:recursive|archive)$/.test(f),
  'copy-item': (f) => PS_RECURSE.test(f),
  findstr: (f) => /^\/s$/i.test(f),
  scp: (f) => /^-[a-zA-Z]*r[a-zA-Z]*$/.test(f),
};
for (const [alias, cmd] of [['egrep', 'grep'], ['fgrep', 'grep'], ['zgrep', 'grep'], ['gci', 'get-childitem'], ['cpi', 'copy-item'], ['copy', 'copy-item']]) SWEEP_FLAGGED[alias] = SWEEP_FLAGGED[cmd];
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'findstr']);
// Words before a command word: a block, a wrapper, an assignment.
const CMD_LEAD = new Set(['{', '(', 'do', 'then', 'else', 'sudo', 'time', 'xargs', 'nohup', 'exec', 'env', 'nice', 'timeout', '-c', '/c', '/k', '-command', '=', 'call', 'start', '&']);
const HOME_N = norm(HOME).replace(/\/+$/, '');
// The folder a path word names, normalized like norm(); null when it cannot be known (a variable, relative
// with no known folder). `here` is the folder relative words resolve against.
function sweepPath(word, here) {
  let w = String(word).replace(/^["'(]+|["'),;]+$/g, '').replace(/\\/g, '/');
  if (!w) return null;
  w = w.replace(/^(?:\$\{?HOME\}?|\$\{?env:(?:USERPROFILE|HOME)\}?|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%|\$env:HOMEDRIVE\$env:HOMEPATH|~)(?=\/|$)/i, HOME.replace(/\\/g, '/'))
    .replace(/^(?:\$env:SystemDrive|%SystemDrive%)(?=\/|$)/i, 'c:')
    .replace(/^\/([a-z])(?=\/|$)/i, '$1:');
  if (/[$%`]/.test(w)) return null;
  w = w.replace(/(?:\/\*+(?:\.\*)?)+$/, '').replace(/^\*+(?:\.\*)?$/, '.');
  let abs;
  if (/^[a-z]:(?:\/|$)/i.test(w) || w.startsWith('/')) abs = w;
  else if (here) abs = `${here}/${w}`;
  else return null;
  const drive = (abs.match(/^[a-z]:/i) || [''])[0];
  abs = drive + path.posix.normalize(`/${abs.slice(drive.length)}`);
  return norm(abs).replace(/\/+$/, '');
}
// The home folder, any folder above it, a drive root or `/`.
function sweepsHome(p) {
  return p !== null && (p === '' || /^[a-z]:$/i.test(p) || p === HOME_N || HOME_N.startsWith(`${p}/`));
}
// null, or { cmd, target } for the first command in the line that walks a tree at home or above it.
function homeSweep(text, cwd, depth = 0) {
  let here = cwd ? norm(cwd).replace(/\/+$/, '') : null;
  for (const seg of segments(text)) {
    const raw = seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const words = raw.map((w) => w.replace(/^["'({]+|["')}]+$/g, ''));
    const bases = raw.map((w) => base(w.replace(/^[({]+/, '')).replace(/\.exe$/i, '').toLowerCase());
    // A string handed to a shell (`bash -c "grep -r x ~"`) is a command line of its own.
    if (depth < 2 && SHELL_WRAPPER.test(seg)) {
      for (const q of raw.filter((w) => /^["']/.test(w))) {
        const inner = homeSweep(q.slice(1, -1), here, depth + 1);
        if (inner) return inner;
      }
    }
    for (let i = 0; i < words.length; i += 1) {
      const b = bases[i];
      const lead = i === 0 || CMD_LEAD.has((words[i - 1] || '').toLowerCase()) || /^[({]/.test(raw[i]) || /[={]$/.test(words[i - 1] || '');
      if (!lead) continue;
      if (['cd', 'set-location', 'sl', 'pushd', 'push-location', 'chdir'].includes(b)) {
        const to = words.slice(i + 1).find((w) => w && !/^-/.test(w));
        here = to === undefined ? HOME_N : sweepPath(to, here);
        break;
      }
      const flagged = SWEEP_FLAGGED[b];
      if (!SWEEP_ALWAYS.has(b) && !flagged) continue;
      let end = words.slice(i + 1).findIndex((w, k) => /^[)}]/.test(raw[i + 1 + k]) && !w);
      end = end < 0 ? words.length : i + 1 + end;
      const args = words.slice(i + 1, end).filter((w) => w !== '');
      if (flagged && !args.some((a) => flagged(a))) break;
      let targets = args.filter((a) => !/^-/.test(a) && !(/^\/[a-z]+$/i.test(a) && ['dir', 'findstr', 'robocopy', 'xcopy'].includes(b)));
      // a search tool's first plain word is the pattern, unless -e/-f gave it
      if (PATTERN_FIRST.has(b) && !args.some((a) => /^-(?:e|f)$|^--(?:regexp|file)=/.test(a))) targets = targets.slice(1);
      if (!targets.length) targets = ['.'];
      const hit = targets.find((t) => sweepsHome(sweepPath(t, here)));
      if (hit) return { cmd: [words[i], ...args.filter((a) => /^-|^\/[a-z]+$/i.test(a))].join(' '), target: hit };
      break;
    }
  }
  return null;
}

function keyVerdict(segs, text = segs.join(' ; '), cwd = null) {
  // A listing of the root fed into something that reads each name (`find <store> | xargs cat`).
  // (A pipe into head/sort/grep only reads the NAMES; these run something per name, or bind names to files.)
  if (STORE_ROOT_OR_CONFIG.test(text) && /\|\s*(?:xargs|while\b|for\b|parallel|Get-Content|gc\b|%|ForEach-Object|foreach|Select-String|sls\b|Copy-Item|cpi\b)/i.test(text)) {
    return "feeding the store's root or settings folder into another command (it holds the plan signing key)";
  }
  const sweep = homeSweep(text, cwd);
  if (sweep) {
    return `a recursive read or copy of the home folder or a drive root (it would sweep in the plan signing key); name a narrower folder [rule: home-sweep; matched: "${sweep.cmd}" on "${sweep.target}"]`;
  }
  // A wildcard or a `..` walking into the store can reach the key without naming it (`conf*/plan*`).
  if (/\.sbrm-dataverse[\\/]+[^\s"'`;|&]*\.\.[\\/]/i.test(text) || /\.sbrm-dataverse[\\/]+(?!jobs[\\/])[^\s"'`;|&/\\]*[*?]/i.test(text)) {
    return "a wildcard or a '..' walking through the store's folders (it holds the plan signing key)";
  }
  for (const seg of segs) {
    if (KEY_NAMED.test(seg)) return 'reading the plan signing key';
    if (!STORE_ROOT_OR_CONFIG.test(seg)) continue;
    const first = firstWord(seg);
    // Names only, never contents: a non-recursive listing, or `find` with no action of its own.
    const listing = (['ls', 'dir', 'get-childitem', 'gci'].includes(first) && !/\s-(?:[a-z]*R|Recurse)\b/i.test(seg) && !/\*/.test(seg))
      || (first === 'find' && !FIND_WRITES.test(seg))
      // making the store's folder on a new machine reads nothing (final re-verify false positive)
      || (['mkdir', 'md'].includes(first) && !/config/i.test(seg));
    const devFile = STORE_READ_CMDS.has(first) && /config[\\/]+dev_dirs\.json["'`]?(?:\s|$)/i.test(seg) && !/\*/.test(seg)
      && !STORE_ROOT_OR_CONFIG.test(seg.replace(/[\\/]+config[\\/]+dev_dirs\.json/ig, '/devfile.json'));
    if (!listing && !devFile) return "reaching into the store's root or settings folder (it holds the plan signing key)";
  }
  return null;
}
function keyPathVerdict(tool, ti, cwd) {
  // A Grep with no path searches the session's folder (final re-verify: from the home folder that swept
  // the key in; Claude Code's Grep does search hidden folders).
  const p = ti.file_path || ti.path || ti.notebook_path || (tool === 'Grep' ? cwd || '' : '');
  if (!p) return null;
  const n = real(p).replace(/\/+$/, '') || '/';
  const cfg = `${STORE}/config`;
  if (n === cfg || n.startsWith(`${cfg}/`)) return /\/dev_dirs\.json$/.test(n) && tool === 'Read' ? null : 'reading the plan signing key (the store\'s settings folder)';
  // Grep searches recursively: the store root, or ANY folder above it (home, the drive root), sweeps it in.
  if (tool === 'Grep' && (n === STORE || STORE.startsWith(n === '/' || /^[a-z]:$/.test(n) ? `${n.replace(/\/$/, '')}/` : `${n}/`))) {
    return 'searching a folder that holds the store\'s settings (the plan signing key); search a narrower folder';
  }
  return null;
}
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py']);

// Where a command's redirects write: the word after each unquoted `>` / `>>` (quoted ones too when the text is
// handed to a shell). 1.11.5 (false positive 10/9): `sed 's#<plugin path>#<working copy path>#' a.js > b.js`
// rewrote a scratch file and was blocked as changing the plugin, because ANY redirect on a line that named the
// plugin counted as a write into it. Now only a redirect whose target is in the plugin does, or one whose target
// cannot be known (a variable, nothing), or a relative one after a `cd` into the plugin.
function redirectTargets(seg) {
  const scan = SHELL_WRAPPER.test(seg) ? seg : unquoted(seg);
  const out = [];
  const re = />{1,2}/g;
  let m;
  while ((m = re.exec(scan)) !== null) {
    if (/[=-]$/.test(scan.slice(0, m.index))) continue; // `=>` and `->` are code, not redirects
    const after = seg.slice(m.index + m[0].length).replace(/^\s+/, '');
    out.push((after.match(/^"[^"]*"|^'[^']*'|^[^\s;|&()<>]+/) || [''])[0].replace(/^["']+|["']+$/g, ''));
  }
  return out;
}
const PLUGIN_CD = /(?:^|[\s;&|(])(?:cd|pushd|chdir|Set-Location|sl|Push-Location)\s+[^;&|\n]*\.claude[\\/]+plugins[\\/]+(?:cache|marketplaces)[\\/]+sbrm-claude-toolkit/i;
function writesIntoPlugin(seg, line) {
  return redirectTargets(seg).some((t) => !t || /[$`%]/.test(t) || PLUGIN_IN_TEXT.test(t) || inPlugin(t)
    || (PLUGIN_CD.test(line) && !/^(?:[a-z]:)?[\\/~]/i.test(t)));
}
// mutates(), with a redirect counted only when it writes into the plugin.
function mutatesPlugin(text, line = text) {
  return SHELL_MUTATE_WORD.test(text) || GIT_WRITE.test(text) || segments(text).some((s) => writesIntoPlugin(s, line));
}

// Every simple command that names the store, or runs after a `cd` into it, must be a plain read
// (STORE_READ_CMDS, no redirect, no find -delete/-exec). A command that names the plugin must be a plain
// read (or sed/awk without in-place editing) whose output goes elsewhere, or an interpreter run with nothing in
// it that writes into the plugin (reading the plugin's JSON settings is fine).
function storeOrPluginVerdict(segs) {
  const line = segs.join(' ; ');
  let inStore = false;
  for (const seg of segs) {
    const first = firstWord(seg);
    // An empty piece (between the two characters of && or ||) or a bare `VAR=value` runs nothing
    // (10/7 third pass: both read as a non-read command and blocked `cd jobs && ls`).
    if (!first) continue;
    const namesStore = STORE_NAMED(seg);
    const isCd = ['cd', 'set-location', 'sl', 'pushd'].includes(first);
    if (namesStore || inStore) {
      const read = STORE_READ_CMDS.has(first) && !(first === 'find' && FIND_WRITES.test(seg)) && !REDIRECT.test(unquoted(seg));
      if (!read) return "changing the engine's own store (plans, log, events): only plain reads may name it";
    }
    if (isCd) inStore = /\.sbrm-dataverse/i.test(seg);
    if (PLUGIN_IN_TEXT.test(seg)) {
      const filter = (first === 'sed' && !/\s(?:-[a-zA-Z]*i|--in-place)/.test(unquoted(seg)))
        || (['awk', 'gawk'].includes(first) && !/\binplace\b/i.test(seg));
      const read = (((STORE_READ_CMDS.has(first) && !(first === 'find' && FIND_WRITES.test(seg))) || filter) && !writesIntoPlugin(seg, line))
        || (INTERPRETERS.has(first) && !mutatesPlugin(seg, line));
      if (!read) return "changing the toolkit plugin's files";
    }
  }
  return null;
}
const STORE_IN_TEXT = new RegExp(`\\.sbrm-dataverse[\\\\/]+(?:${PROTECTED_STORE.join('|')})\\b`, 'i');
const PLUGIN_IN_TEXT = /\.claude[\\/]+plugins[\\/]+(?:cache|marketplaces)[\\/]+sbrm-claude-toolkit/i;

// Folders where the engine itself is developed (Dylan's staging copy): code there may reference the
// write side. Since 1.10.0 they live on the developer's own machine in ~/.sbrm-dataverse/config/
// dev_dirs.json ({"dev_dirs": [...]}), which survives toolkit updates (the plugin's toolkit.json was reset
// by every update, 10/7) and which this guard protects like the rest of the store. The plugin's
// toolkit.json list is still read, for setups from before.
function devDirs() {
  const out = [];
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).dev_dirs || []; } catch { return []; }
  };
  out.push(...read(path.join(HOME, '.sbrm-dataverse', 'config', 'dev_dirs.json')));
  if (pluginRoot()) out.push(...read(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'dataverse', 'toolkit.json')));
  return [...new Set(out.map(norm))];
}
// The REAL path must be inside a dev folder (a `..` cannot walk out of one and still count).
function inDevDir(p, dirs) {
  const n = real(p);
  return dirs.some((d) => n === d || n.startsWith(d.replace(/\/$/, '') + '/'));
}

// ---------- what in a shell line is data, not a command (false positives found 10/7) ----------

// A redirect that cannot change a file: an fd duplicate (2>&1, >&2) or a null sink (/dev/null, $null, NUL).
// `>` counts as a write in SHELL_MUTATE, so these are dropped first; a redirect to any real file still counts.
const HARMLESS_REDIRECT = /(?:&|\*)?\d*>{1,2}\s*(?:&\s*\d+|(?:\/dev\/null|\$null|nul)(?![\w.\/\\-]))/gi;

// The line split on its unquoted separators (; & | newline) into simple commands.
function segments(text) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"' && i + 1 < text.length) cur += text[++i];
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ';' || c === '&' || c === '|' || c === '\n') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// A plain run of THIS plugin's engine CLI: `node <plugin>/dataverse/engine/dataverse-write.js <args>`. Its
// arguments are data (a `report` carries the person's words verbatim, which may say "move" or "the Dataverse
// skill"), so the text rules skip it. Not plain, so still checked: command substitution, a redirect, an
// option before the script (`--require`), or an engine copy outside the plugin folder.
function isEngineRun(seg) {
  if (/\$\(|`|<\(|>/.test(seg)) return false;
  const words = (seg.match(/"[^"]*"|'[^']*'|[^\s"']+/g) || []).map((w) => w.replace(/^["']|["']$/g, ''));
  if (words.length < 2 || !/(?:^|[\\/])node(?:\.exe)?$/i.test(words[0])) return false;
  return /[\\/]dataverse[\\/]engine[\\/]dataverse-write\.js$/i.test(words[1]) && inPlugin(words[1]);
}

// ---------- the approval (1.11.0, DESIGN.md §10n, ruled 10/8) ----------
//
// The person approves a write in Claude Code's own permission prompt, not an OS pop-up. An `apply` (or a
// `resolve`) of THIS plugin's engine, on a line of its own, is answered with Claude Code's "ask" decision,
// which the model cannot answer; at that moment the guard mints a one-time ticket per plan
// (engine/lib/ticket.js) and the engine refuses any write without one. So an apply the guard does not
// recognise (wrapped, disguised, run through another tool) gets no prompt AND no ticket, and writes nothing.
//
// Only in modes where Claude Code really asks (tested 10/8: headless runs refuse "ask" in every mode; the
// docs leave interactive bypassPermissions open): any other or missing mode is refused, never asked.
const ASK_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
const PLAN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
const SHELL_WORD = String.raw`(?:"[^"]+"|'[^']+'|[^\s;&|"'` + '`' + String.raw`$()<>]+)`;
const APPROVAL_LINE = new RegExp(String.raw`^(?:cd\s+(${SHELL_WORD})\s*&&\s*)?(${SHELL_WORD})\s+(${SHELL_WORD})\s+(apply|resolve)\s+(.+)$`, 'i');
// An engine apply or resolve ANYWHERE in a command, a script or another tool's input (blind review 10/8: a
// ticket minted for a declined prompt must not be spendable by a second, wrapped run). Only the exact
// approval form below is ever let through; this is refused, so an honest mistake is told what to do and a
// leftover ticket can only be reached by deliberate obfuscation (the guard's stated residual).
const APPLY_ANYWHERE = /dataverse-write(?:\.js)?["']?\s+(?:apply|resolve)\b/i;
// The engine this guard ships beside: an approval runs THIS file, never one that only looks like it
// (blind review 10/8: the plugin-path text check matched a look-alike folder anywhere on disk).
function ownEngine() {
  try { return fs.realpathSync(path.join(__dirname, '..', 'engine', 'dataverse-write.js')); } catch { return null; }
}
function sameFile(a, b) {
  if (!a || !b) return false;
  try { return fs.realpathSync(a).toLowerCase() === b.toLowerCase(); } catch { return false; }
}

// { verb, keys } when `command` is exactly one engine apply/resolve of this plugin, else null.
function approvalCommand(command, engine = ownEngine()) {
  const text = String(command || '').trim().replace(/\s+2>&1$/, '');
  if (/[\r\n]/.test(text)) return null;
  // No expansion of any kind anywhere on the line, quoted or not (blind review 10/8): what the person
  // approves must be exactly what runs.
  if (/[$`*?[\]{}!%^]/.test(text)) return null;
  const m = APPROVAL_LINE.exec(text);
  if (!m) return null;
  const unq = (s) => (s ? s.replace(/^["']|["']$/g, '') : s);
  // Plain `node` only (blind review 10/8): any other file named node could be a stand-in launcher.
  if (!/^node(?:\.exe)?$/i.test(m[2])) return null;
  // A leading ~ means HOME only when unquoted: bash leaves a quoted ~ alone, and the guard must read the
  // line the way the shell will.
  const tilde = (raw) => (/^~(?=[\\/]|$)/.test(raw) ? HOME + raw.slice(1) : unq(raw));
  let script = tilde(m[3]);
  if (!path.isAbsolute(script)) {
    if (!m[1]) return null;
    script = path.join(tilde(m[1]), script);
  }
  if (!/[\\/]dataverse[\\/]engine[\\/]dataverse-write\.js$/i.test(script) || !sameFile(script, engine)) return null;
  const verb = m[4].toLowerCase();
  const rest = m[5].trim();
  if (/[;&|`$<>]/.test(rest)) return null;
  if (verb === 'apply') {
    const ids = rest.split(/\s+/);
    if (ids.length > 20 || !ids.every((x) => PLAN_ID_RE.test(x)) || new Set(ids).size !== ids.length) return null;
    return { verb, keys: ids };
  }
  // --fixed-in <version> may sit anywhere, as the engine allows (blind review 10/8).
  const num = /^([DHRSF]-\d{4,})\s/i.exec(rest.replace(/--fixed-in\s+\S+\s*/i, '') + ' ');
  return num ? { verb, keys: [`resolve-${num[1].toUpperCase()}`] } : null;
}

// null (not an approval), { block } or { ask: { verb, keys } }.
function approvalVerdict(input, { engine } = {}) {
  const tool = String(input.tool_name || '');
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = String((input.tool_input || {}).command || '');
  const ap = approvalCommand(command, engine === undefined ? ownEngine() : engine);
  if (!ap) {
    if (APPLY_ANYWHERE.test(command)) {
      return { block: 'an apply or resolve that is not exactly the approval form, so Claude Code cannot ask the person about it. The form: its own command, nothing before or after it, `node "<this plugin>/dataverse/engine/dataverse-write.js" apply <plan-id> [<plan-id> ...]` (at most 20 plans, none twice) or `... resolve <number> <resolution> "<note>"`, with no $ ` * ? [ ] { } ! % ^ ; & | < > characters anywhere (reword a note that has them)' };
    }
    return null;
  }
  // A subagent's hook input carries agent_id and the parent's mode (tested 10/8), but a background
  // subagent's prompt can be refused unseen, which would leave a ticket for a prompt nobody saw.
  if (input.agent_id || input.agent_type) {
    return { block: 'an apply from a subagent (the main session runs applies, so the person sees Claude Code\'s prompt)' };
  }
  const mode = input.permission_mode;
  if (!ASK_MODES.has(mode)) {
    return { block: `an apply in a permission mode where Claude Code does not ask the person (this session: "${mode || 'not given'}"). The person switches to a mode that asks (shift+tab), then Claude runs the apply again` };
  }
  // Every other rule still applies to the line before anyone is asked (blind review 10/8).
  const other = shellVerdict(command);
  if (other) return { block: other };
  return { ask: ap };
}

// What the prompt says about one plan: its headline and its warning lines, read from the plan file (ruled
// 10/8: the prompt is the person's only yes, so it carries the facts). Display only: the engine verifies the
// plan's signature before it writes, so an edited file shows wrong text and then writes nothing.
function describePlan(id) {
  try {
    const store = require('../engine/lib/store');
    const rec = JSON.parse(fs.readFileSync(path.join(store.dir('plans'), `${id}.json`), 'utf8'));
    const app = rec.app || 'app';
    let head;
    if (rec.kind === 'rows') head = require('../engine/lib/render').headline(rec);
    else if (rec.kind === 'merge') head = `Merge ${(rec.pairs || []).length} pair(s) of records in the ${app}`;
    else if (rec.kind === 'unmerge') head = `Undo a merge in the ${app}`;
    else if (rec.kind === 'component') head = `${rec.mode || 'change'} ${rec.component && rec.component.name ? `'${rec.component.name}'` : 'an app component'} in the ${app}`;
    else if (rec.kind === 'schema') head = `App change (tables, columns, choices) in the ${app}`;
    else head = `A change in the ${app}`;
    const warn = (rec.severity && Array.isArray(rec.severity.lines)) ? rec.severity.lines : [];
    return `${head}${rec.reverts_plan_id ? ' (an undo)' : ''}${warn.length ? `. ${warn.join(' ')}` : ''}`;
  } catch {
    return `plan ${id}`;
  }
}

function askPerson({ verb, keys }) {
  const T = require('../engine/lib/ticket');
  for (const k of keys) T.mint(k);
  const what = verb === 'resolve'
    ? `Close ${keys[0].slice('resolve-'.length)}`
    : keys.map(describePlan).join(' | ');
  const shown = what.length > 900 ? `${what.slice(0, 900)}...` : what.replace(/\.+$/, '');
  const reason = `SBRM Dataverse: ${shown}. Yes writes it; No stops it.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }));
  process.exit(0);
}

// ---------- the verdict ----------

// `cwd` (the hook input's working folder, when given) is where a recursive command with no path, or a
// relative one, would walk.
function shellVerdict(text, cwd = null) {
  const segs = segments(text.replace(HARMLESS_REDIRECT, ' ')).filter((s) => !isEngineRun(s));
  const rest = segs.join(' ; ');
  if (HIDDEN_CODE.test(text)) return 'code that runs out of sight (decoded at run time, or preloaded into node)';
  const key = keyVerdict(segments(text), text, cwd);
  if (key) return key;
  if (PLUGIN_OFF_SHELL.test(rest)) return 'switching the toolkit plugin (and its guard) off';
  const sp = storeOrPluginVerdict(segs);
  if (sp) return sp;
  const cli = cliVerdict(text.replace(HARMLESS_REDIRECT, ' ')); // raw: its heredoc bodies are found by line
  if (cli) return `${cli}, which writes to Dataverse`;
  if (CLI_LIST.test(rest) && LIST_WRITE.test(rest)) return "the Dataverse CLI's write side, called with a list of arguments";
  if (ENGINE_INTERNALS.test(rest)) return "code that reaches the engine's write side directly (it would skip the approval)";
  if (targetsDataverse(text.replace(HARMLESS_REDIRECT, ' '))) return 'a raw writing HTTP call at Dataverse';
  if (OTHER_DV_WRITERS.test(rest)) return 'another tool that writes to Dataverse (the Xrm PowerShell cmdlets or the Power Platform CLI)';
  const inj = shellInjection(text);
  if (inj) return `keystroke or click injection (approving is the person's alone) [rule: injection; matched: "${inj.token}" in ${inj.where}]`;
  if (storeMoveShell(text)) return "moving the engine's store or settings for a run (plans must stay where the guard protects them)";
  // An apply or resolve on a line that also changes PATH or node's own options could be handed a substitute
  // CLI or preloaded code (final re-verify). A Claude shell keeps no settings between commands, so the same
  // line is the only place such a change can come from.
  if (/dataverse-write(?:\.js)?["']?\s+(?:apply|resolve)\b/i.test(text)
    && /(?:^|[\s;&|(])(?:PATH|Path|NODE_\w+|DYLD_\w+|LD_\w+)=|\$env:(?:PATH|Path|NODE_\w+)|\bexport\s+(?:PATH|NODE_|DYLD_|LD_)|\bset\s+(?:PATH|NODE_)\w*=|\benv\s+(?:-\S+\s+)*\w+=/.test(text)) {
    return 'changing PATH or node options on the same line as an apply (the engine must run the real Dataverse CLI)';
  }
  // The path is looked for in the WHOLE line (an engine run can feed a later delete, `show 1 | xargs rm`);
  // the mutating command only outside the engine's own arguments.
  if ((STORE_IN_TEXT.test(text) || STORE_ANY.test(text)) && mutates(rest)) return "changing the engine's own store (plans, log, events)";
  if (PLUGIN_IN_TEXT.test(text) && mutatesPlugin(rest, text)) return "changing the toolkit plugin's files";
  if (HOOKS_OFF.test(rest)) return 'switching hooks off';
  if (PROMPT_ANSWERER.test(text) && /settings(?:\.local)?\.json/i.test(text) && mutates(rest)) return 'adding a hook that answers approval prompts (only the person may add one)';
  return null;
}

function contentOf(tool, ti) {
  if (tool === 'Write') return String(ti.content || '');
  if (tool === 'Edit') return String(ti.new_string || '');
  if (tool === 'MultiEdit') return (ti.edits || []).map((e) => String((e && e.new_string) || '')).join('\n');
  if (tool === 'NotebookEdit') return String(ti.new_source || '');
  return '';
}

const CODE_FILE = /\.(?:js|cjs|mjs|ts|py|ps1|psm1|sh|bash|zsh|cmd|bat|rb|pl|php|go|cs|vbs|applescript|scpt)$/i;

// A settings write ADDS a prompt-answering hook only if the file afterwards holds a PermissionRequest hook it did
// not hold before. 1.11.5 (10/9, Daian's Mac): iTerm2's own Claude integration installs one (a status reporter the
// person added), so any Write of the whole file, or an Edit spanning that block, was refused while it only kept
// it. Changing that hook's command counts as new. Anything that cannot be worked out fails closed.
function answererHooks(jsonText) {
  try {
    const d = JSON.parse(String(jsonText).replace(/^﻿/, ''));
    const groups = (d && d.hooks && d.hooks['Permission' + 'Request']) || [];
    if (!Array.isArray(groups)) return null;
    return groups.flatMap((g) => ((g && Array.isArray(g.hooks)) ? g.hooks : [null]).map((h) => JSON.stringify([g && g.matcher, h])));
  } catch { return null; }
}
function readSettings(file) {
  try {
    return fs.readFileSync(/^~[\\/]/.test(file) ? path.join(HOME, file.slice(2)) : file, 'utf8');
  } catch { return ''; }
}
function settingsHasAnswerer(file) {
  const t = readSettings(file);
  return PROMPT_ANSWERER.test(t) || /\\u[0-9a-f]{4}/i.test(t);
}
function addsAnswerer(tool, ti, file) {
  const before = readSettings(file);
  let after = before;
  const edits = tool === 'Write' ? null : tool === 'Edit' ? [ti] : tool === 'MultiEdit' ? (ti.edits || []) : undefined;
  if (edits === undefined) return true;
  if (edits === null) after = String(ti.content || '');
  for (const e of edits || []) {
    const from = String((e && e.old_string) || '');
    // Claude Code refuses an Edit whose old text is not in the file, so it writes nothing.
    if (!from || !after.includes(from)) return false;
    after = e.replace_all ? after.split(from).join(String(e.new_string || '')) : after.replace(from, () => String(e.new_string || ''));
  }
  const now = answererHooks(after);
  // Not JSON afterwards: no hook in it can load. Refused only if the new text itself names the hook or a \u key.
  if (now === null) return PROMPT_ANSWERER.test(contentOf(tool, ti)) || /\\u[0-9a-f]{4}/i.test(contentOf(tool, ti));
  const was = before.trim() ? (answererHooks(before) || []) : [];
  return now.some((h) => !was.includes(h));
}

function writeVerdict(tool, ti, dirs) {
  const file = ti.file_path || ti.notebook_path || '';
  if (inPlugin(file)) return "changing the toolkit plugin's files";
  if (inProtectedStore(file)) return "changing the engine's own store (plans, log, events)";
  const text = contentOf(tool, ti);
  if (SETTINGS_FILE.test(norm(file)) && HOOKS_OFF.test(text)) return 'switching hooks off';
  if (SETTINGS_FILE.test(norm(file)) && PLUGIN_OFF_SETTINGS.test(text)) return 'switching the toolkit plugin (and its guard) off';
  // A PermissionRequest hook can answer Claude Code's prompts itself (docs, checked 10/8), which would
  // approve a write with nobody looking. Only the person adds one, by hand.
  // Parsed and compared when the new text names the hook, spells a key with a JSON \u escape, or edits a file that
  // already holds one (an Edit can change that hook's command without naming it; 1.11.4 missed both).
  if (SETTINGS_FILE.test(norm(file)) && (PROMPT_ANSWERER.test(text) || /\\u[0-9a-f]{4}/i.test(text) || (tool !== 'Write' && settingsHasAnswerer(file)))
    && addsAnswerer(tool, ti, file)) return 'adding a hook that answers approval prompts (only the person may add one) [rule: prompt-answerer; matched: a new or changed PermissionRequest hook]';
  if (HIDDEN_CODE.test(text) && !inDevDir(file, dirs)) return 'writing code that runs out of sight (decoded at run time, or preloaded into node)';
  // Only files that run (1.11.5): a markdown plan that names an input tool cannot press anything (false
  // positive 10/9). A hotkey/AU3 script file is refused outright: sending input is all it does. Claude Code's
  // settings carry hook COMMANDS, so they are read as code too.
  if (/\.(?:a[h]k|au3)$/i.test(file)) return `writing keystroke or click injection (approving is the person's alone) [rule: injection-write; matched: a ${path.extname(file)} script]`;
  if (isExecFile(file, text) || SETTINGS_FILE.test(norm(file))) {
    const token = injectMatch(SETTINGS_FILE.test(norm(file)) ? text.replace(/\\"/g, '"') : text);
    if (token) return `writing keystroke or click injection (approving is the person's alone) [rule: injection-write; matched: "${token}" in a ${path.extname(file) || 'script'} file]`;
  }
  if (!inDevDir(file, dirs)) {
    if (ENGINE_INTERNALS.test(text)) return "writing code that reaches the engine's write side directly (it would skip the approval)";
    // A script that runs an apply would spend a ticket minted for someone else's prompt (blind review 10/8).
    if (CODE_FILE.test(file) && APPLY_ANYWHERE.test(text)) return 'writing a script that runs an apply or resolve (an apply runs only as its own command, so Claude Code asks the person)';
    // Code only (a note describing the Web API is not a call): final re-verify false positive.
    if (CODE_FILE.test(file) && (targetsDataverse(text) || XRM_WRITE.test(text))) return 'writing a raw writing HTTP call at Dataverse';
    if (CODE_FILE.test(file) && (KEY_NAMED.test(text) || /\.sbrm-dataverse[\\/]+config/i.test(text))) return 'writing code that reads the plan signing key';
    if (CLI_LIST.test(text) && LIST_WRITE.test(text)) return "writing code that calls the Dataverse CLI's write side";
    // Code only: a note or doc that mentions the variable is not a run (re-verify false positive).
    if (CODE_FILE.test(file) && storeMoveCode(text)) return "writing code that moves the engine's store or settings";
  }
  return null;
}

// An approval is waiting on this machine (a fresh ticket exists: Claude Code is asking, or was just asked):
// screen-driving tools stay off the prompt meanwhile.
function popupOpen() {
  try { return require('../engine/lib/ticket').pending(); } catch { return false; }
}

function verdict(input, dirs = devDirs(), { popup = popupOpen } = {}) {
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const mcp = mcpParts(tool);
  if (mcp && DV_SERVER.test(mcp.server)) return READ_TOOLS.has(mcp.name) ? null : `the Dataverse tool "${mcp.name}" (only known reads are allowed)`;
  if (mcp && DV_WRITE_TOOLS.test(mcp.name)) return `the tool "${mcp.name}" (a Dataverse write outside the approved path)`;
  if (SCREEN_TOOL.test(tool) && popup()) return 'driving the screen while an approval is waiting (approving is the person\'s alone)';
  if (mcp) {
    // Every string the tool was handed, as written (JSON would escape the quotes the rules read).
    const strings = [];
    const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(ti);
    const text = strings.join('\n');
    if (SHELL_MCP.test(mcp.name)) {
      if (strings.some((s) => APPLY_ANYWHERE.test(s))) return `an apply or resolve through the tool "${mcp.name}" (an apply runs only as a Bash or PowerShell command of its own, so Claude Code asks the person)`;
      for (const s of strings) { const v = shellVerdict(s); if (v) return `${v} (through the tool "${mcp.name}")`; }
    }
    if (CODE_MCP.test(mcp.name)) {
      if (targetsDataverse(text)) return 'a writing HTTP call at Dataverse from another tool';
      if (XRM_WRITE.test(text)) return "a write through the app's own page code (Xrm), which skips the approval";
    }
  }
  if (tool === 'Read' || tool === 'Grep') return keyPathVerdict(tool, ti, input.cwd);
  if (tool === 'Bash' || tool === 'PowerShell') return shellVerdict(String(ti.command || ''), input.cwd || null);
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return writeVerdict(tool, ti, dirs);
  return null;
}

// Each block is recorded on this machine (1.11.6, engine/lib/blocks.js): the call as seen, the rule, the
// folder, the version, queued for Dylan's review as a routine count. The message then gives the block id and
// the one command that reports it, which the person's Claude runs ON ITS OWN when it judges the block wrong
// (Dylan 10/9: reports should go in automatically when a hook blocks a legitimate action and Claude notices).
// Recording is best effort: a failure leaves a plain block. Not recorded: doctor's own probes
// (SBRM_GUARD_PROBE=1 on this process, set by the engine) and a call the guard could not parse.
function recordBlock(input, what) {
  if (!input || process.env.SBRM_GUARD_PROBE === '1') return null;
  try { return require('../engine/lib/blocks').record(input, what); } catch { return null; }
}

function blockMessage(what, rec) {
  let msg = `BLOCKED by the SBRM toolkit Dataverse guard: ${what}. `
    + 'A change to Dataverse goes through the shared write path: Claude plans it, runs `apply` on its own '
    + 'line, and the person approves it when Claude Code asks. Tell the person what you were trying '
    + 'to do. Do not look for another way, and do not edit or remove this hook.\n';
  if (rec) {
    const engine = path.join(__dirname, '..', 'engine', 'dataverse-write.js').replace(/\\/g, '/');
    msg += `Block ${rec.block_id} is recorded on this machine. If this call changes nothing in Dataverse, the `
      + 'toolkit or its store and answers no permission prompt (a read, a search, a document, a script of your '
      + 'own), the block is probably a mistake. Report it yourself, without asking first, as a command of its own:\n'
      + `node "${engine}" report --blocked ${rec.block_id} "<one plain sentence: what you were doing>"\n`
      + 'Describe it in words only; the blocked call is already attached. Then tell the person in one line '
      + 'that it was reported, with the number it prints.\n';
  }
  return msg;
}

function block(what, input = null) {
  process.stderr.write(blockMessage(what, recordBlock(input, what)));
  process.exit(2);
}

// ---------- self-test (trigger strings assembled at runtime) ----------

function selftest() {
  const J = (...p) => p.join('');
  const ENG = '"C:/Users/x/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.9.0/dataverse/engine/dataverse-write.js"';
  const B = (command, tool = 'Bash') => ({ tool_name: tool, tool_input: { command } });
  const W = (file_path, content) => ({ tool_name: 'Write', tool_input: { file_path, content } });
  const E = (file_path, new_string) => ({ tool_name: 'Edit', tool_input: { file_path, old_string: 'x', new_string } });
  const H = HOME.replace(/\\/g, '/');
  const SHORT_HOME = path.join(path.dirname(HOME), `${path.basename(HOME).replace(/\s/g, '').slice(0, 6).toUpperCase()}~1`).replace(/\\/g, '/');
  const DEV = 'C:/dev/sbrm-toolkit';
  const cases = [
    // [label, input, expectBlocked]
    ['engine plan', B(`node ${ENG} plan ~/.sbrm-dataverse/jobs/x.json`), false],
    ['engine show / revert / doctor / report / review / whoami', B(`node ${ENG} show 1 && node ${ENG} revert 2 && node ${ENG} doctor && node ${ENG} report "it froze" && node ${ENG} review --brief && node ${ENG} whoami donorapp`), false],
    ['engine apply (verdict allows; approvalVerdict asks first)', B(`node ${ENG} ${J('ap', 'ply')} 20261007-122502-eec9f60a`), false],
    ['engine apply via PowerShell', B(`node ${ENG} ${J('ap', 'ply')} 1`, 'PowerShell'), false],
    ['engine resolve (verdict allows; approvalVerdict asks first)', B(`node ${ENG} ${J('reso', 'lve')} D-1001 fixed "x"`), false],
    ['inline code loading the write connection', B(`node -e "const { write${'Connection'} } = require('./lib/write')"`), true],
    ['inline code loading the write module', B(`node -e "const { ${J('write', 'Connection')} } = require('./lib/write')"`), true],
    ['inline code driving the entry point', B(`node -e "require('./${J('dataverse-', 'write')}').runCli(['x'])"`), true],
    ['running the tests is fine', B('cd engine && node --test test/*.test.js'), false],
    ['CLI write verb', B(J('dataverse data ', 'up', 'date contact 1')), true],
    ['CLI read', B('dataverse data query contacts'), false],
    ['CLI describe (1.0.81 read)', B('dataverse data describe contact'), false],
    ['CLI upload (1.0.81 write)', B(J('dataverse data up', 'load contact 1 photo x.png')), true],
    ['raw PATCH at Dataverse', B(J('curl -X P', 'ATCH https://sbrmdonorapp.crm.dynamics.com/api/data/v9.2/contacts(1) -d "{}"')), true],
    ['raw GET at Dataverse', B('curl https://sbrmdonorapp.crm.dynamics.com/api/data/v9.2/WhoAmI'), false],
    ['PowerShell Invoke-RestMethod Patch', B(J('Invoke-RestMethod -Uri https://sbrmhgs.crm.dynamics.com/api/data/v9.2/x -Method P', 'atch'), 'PowerShell'), true],
    ['keystroke injection (shell)', B(J('powershell -c "$w = New-Object -ComObject WScript.', 'Shell; $w.Send', 'Keys(\'~\')"')), true],
    ['keystroke injection (Mac)', B(J('osascript -e \'tell application "System Events" to key', 'stroke return\'')), true],
    ['click helper', B(J('py', 'autogui.click(100, 200)')), true],
    ['delete a plan file', B(J('r', 'm ~/.sbrm-dataverse/plans/20261007-1.json')), true],
    ['edit the local log via shell', B(J('sed -', 'i s/a/b/ ~/.sbrm-dataverse/log/x.md')), true],
    ['read the store is fine', B('cat ~/.sbrm-dataverse/log/person@example.org.md && ls ~/.sbrm-dataverse/plans'), false],
    ['shell into the plugin folder', B(J('c', 'p evil.json ~/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.9.0/dataverse/toolkit.json')), true],
    ['switch hooks off via shell', B(J('echo \'{"disableAll', 'Hooks": true}\' > ~/.claude/settings.local.json')), true],
    ['Write a job file in jobs/', W(`${H}/.sbrm-dataverse/jobs/fix.json`, '{"contract":"sbrm-dv-job/1"}'), false],
    ['Write into plans/', W(`${H}/.sbrm-dataverse/plans/1.json`, '{}'), true],
    ['Write into events/', W(`${H}/.sbrm-dataverse/events/pending/x.json`, '{}'), true],
    ['Write toolkit.json in the plugin', W(`${H}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.9.0/dataverse/toolkit.json`, '{}'), true],
    ['Write a script that uses the write connection', W('C:/temp/fix.js', J('const { write', 'Connection } = require("C:/x/lib/write");')), true],
    ['Write a script that runs the CLI apply (it would spend another prompt\'s ticket)', W('C:/temp/go.ps1', `node ${ENG} ${J('ap', 'ply')} 1`), true],
    ['Write prose that mentions apply in a .md', W('C:/temp/notes.md', `run node ${ENG} ${J('ap', 'ply')} <id> yourself`), false],
    ['Write a raw PATCH script', W('C:/temp/p.py', J('requests.patch("https://sbrmrec.crm.dynamics.com/api/data/v9.2/x", headers=h, method="P', 'ATCH")')), true],
    ['Edit settings to switch hooks off', E(`${H}/.claude/settings.json`, J('"disableAll', 'Hooks": true')), true],
    ['Edit settings otherwise', E(`${H}/.claude/settings.json`, '"theme": "dark"'), false],
    ['Edit settings to switch hooks back ON (doctor\'s fix)', E(`${H}/.claude/settings.json`, J('"disableAll', 'Hooks": false')), false],
    ['Write keystroke injection', W('C:/temp/k.vbs', J('CreateObject("WScript.', 'Shell").Send', 'Keys "~"')), true],
    ['dev folder may reference the write side', W(`${DEV}/dataverse/engine/test/x.test.js`, J('const { apply', 'Plan } = require("../lib/apply");')), false],
    ['MCP read_query (old name)', { tool_name: 'mcp__dataverse-donorapp__read_query' }, false],
    ['MCP read (plugin name)', { tool_name: 'mcp__plugin_sbrm-toolkit_dataverse-donorapp__describe' }, false],
    ['MCP update_record (old name)', { tool_name: J('mcp__dataverse-donorapp__up', 'date_record') }, true],
    ['MCP create (plugin name)', { tool_name: J('mcp__plugin_sbrm-toolkit_dataverse-hgs__cr', 'eate_record') }, true],
    ['MCP unknown future tool', { tool_name: 'mcp__dataverse-recovery__bulk_patch' }, true],
    ['other MCP passes', { tool_name: 'mcp__ms365__list-mail-messages' }, false],
    ['Read passes', { tool_name: 'Read', tool_input: { file_path: `${H}/.sbrm-dataverse/plans/1.json` } }, false],
    ['git commit mentioning the engine', B('git commit -m "engine: merge undo, tests"'), false],
    // False positives found 10/7 (a stderr redirect read as a write; the person's own words read as commands)
    ['engine doctor with 2>&1', B(`node ${ENG} doctor 2>&1`), false],
    ['list the plugin, then doctor with 2>&1', B(`ls ${ENG} && node ${ENG} doctor 2>&1`), false],
    ['read the plugin with 2>/dev/null', B(`cat ${ENG} 2>/dev/null | head`), false],
    ['read the store with 2>/dev/null', B('cat ~/.sbrm-dataverse/log/person@example.org.md 2>/dev/null'), false],
    ['engine doctor with 2>$null (PowerShell)', B(`node ${ENG} doctor 2>$null`, 'PowerShell'), false],
    ['report in the person\'s words (move, copy, del)', B(`node ${ENG} report "I tried to move the gift and copy the old one; it froze, so I hit del" --plan 1`), false],
    ['report in the person\'s words (names the Dataverse skill)', B(`node ${ENG} report "the Dataverse skill isn't working | dataverse install failed"`), false],
    ['a real redirect into the plugin', B(`node ${ENG} doctor > ~/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.9.0/dataverse/toolkit.json`), true],
    ['a stderr redirect into the store', B('node x.js 2> ~/.sbrm-dataverse/log/person@example.org.md'), true],
    ['a redirect to a file that only starts like a null sink', B('cd ~/.sbrm-dataverse/plans && echo x > null.json'), true],
    ['a redirect between store files',B('cat ~/.sbrm-dataverse/plans/1.json >> ~/.sbrm-dataverse/plans/2.json'), true],
    ['report, then a delete in the plugin', B(`node ${ENG} report "x"; ${J('r', 'm')} -rf ~/.claude/plugins/cache/sbrm-claude-toolkit`), true],
    ['report hiding a delete in $( )', B(`node ${ENG} report "$(${J('r', 'm')} -rf ~/.claude/plugins/cache/sbrm-claude-toolkit)"`), true],
    ['engine output piped into a delete', B(`node ${ENG} show 1 | xargs ${J('r', 'm')}`), true],
    ['a look-alike engine outside the plugin', B(`node /tmp/dataverse/engine/dataverse-write.js ${J('r', 'm')} ~/.claude/plugins/cache/sbrm-claude-toolkit/x`), true],
    ['report, then a CLI write verb', B(`node ${ENG} report "x" && ${J('dataverse data ', 'up', 'date contact 1')}`), true],
    // 1.10.0 (DESIGN.md §10): the app development kinds, and the false positive found 10/7 evening
    ['inline code reaching the schema apply', B(`node -e "require('./lib/schema').${J('apply', 'Schema')}(p)"`), true],
    ['inline code reaching the component apply', B(`node -e "require('./lib/component').${J('apply', 'Component')}(p)"`), true],
    ['a read one-liner with an arrow function naming the plugin (false positive 10/7)', B(`node -e "console.log(require('${H}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.9.1/dataverse/envs.json').fedev.host)" | node -e "let s='';process.stdin.on('data',d=>s+=d)"`), false],
    ['bash -c with a quoted redirect into the plugin', B(`bash -c "echo x > ${H}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.9.1/dataverse/toolkit.json"`), true],
    ['powershell -Command with a quoted redirect into the plugin', B(`powershell -Command "'x' > ${H}/.claude/plugins/cache/sbrm-claude-toolkit/x.json"`, 'PowerShell'), true],
    ['inline code writing into the plugin', B(`node -e "require('fs').${J('writeFile', 'Sync')}('${H}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.9.1/dataverse/toolkit.json','{}')"`), true],
    ['Write the machine\'s dev exemptions', W(`${H}/.sbrm-dataverse/config/dev_dirs.json`, '{"dev_dirs":["C:/anything"]}'), true],
    ['shell into the machine\'s dev exemptions', B(`echo '{}' > ~/.sbrm-dataverse/config/dev_dirs.json`), true],
    ['read the machine\'s dev exemptions is fine', B('cat ~/.sbrm-dataverse/config/dev_dirs.json'), false],
    // The 10/7 blind review's probes: each one was ALLOWED before this release.
    ['the write module by path.join pieces', B(`node -e "const E=process.argv[1];const w=require(path.join(E,'lib','${J('wri', 'te')}'));Object.values(w)[0]"`), true],
    ['the schema apply by a computed name', B(`node -e "require('C:/x/sbrm-claude-toolkit/sbrm-toolkit/1.10.0/dataverse/engine/lib/schema')['apply'+'Schema'](p,{})"`), true],
    ['any engine module required by its folder', B(`node -e "const m=require('${H}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.10.0/dataverse/engine/lib/x');"`), true],
    ['the CLI as a Python argument list with DELETE', B(J('python -c "import subprocess;subprocess.run([\'dataverse\',\'api\',\'request\',\'--target\',\'dataverse\',\'--path\',\'/api/data/v9.2/contacts(1)\',\'--method\',\'DEL', 'ETE\'])"')), true],
    ['the CLI as a Node argument list with a body', B(J('node -e "require(\'child_process\').execFileSync(\'dataverse\',[\'api\',\'request\',\'--body-file\',\'b.json\'])"')), true],
    ['the CLI as a list for a read is fine', B('python -c "import subprocess;subprocess.run([\'dataverse\',\'api\',\'request\',\'--path\',\'/api/data/v9.2/WhoAmI\'])"'), false],
    ['PowerShell WriteAllText into the plans', B(J('[IO.File]::WriteAll', 'Text("$HOME/.sbrm-dataverse/plans/x.json", "{}")'), 'PowerShell'), true],
    ['Python open(w) into the dev exemptions', B(J('python -c "open(\'', H, '/.sbrm-dataverse/config/dev_dirs.json\',\'w\').write(\'{}\')"')), true],
    ['Node createWriteStream into the log', B(J('node -e "require(\'fs\').createWrite', 'Stream(\'', H, '/.sbrm-dataverse/log/a.md\')"')), true],
    ['execSync handing a quoted redirect to a shell', B(J('node -e "require(\'child_process\').execSync(\'echo x > ', H, '/.sbrm-dataverse/plans/a\')"')), true],
    ['cd into the store, then a relative redirect', B('cd ~/.sbrm-dataverse && echo \'{}\' > config/dev_dirs.json'), true],
    ['a job file written by shell into jobs/ is fine', B('cat > ~/.sbrm-dataverse/jobs/fix.json <<\'EOF\'\n{}\nEOF'), false],
    // This machine's 8.3 short name for the home folder (FIRSTS~1), when Windows made one: blocked if it exists.
    ['Write through an 8.3 short path', W(`${SHORT_HOME}/.sbrm-dataverse/plans/x.json`, '{}'), process.platform === 'win32' && fs.existsSync(path.join(SHORT_HOME, '.sbrm-dataverse'))],
    ['Write through a .. segment', W(`${H}/.sbrm-dataverse/jobs/../plans/x.json`, '{}'), true],
    ['moving the store for an apply', B(`SBRM_DV_HOME=/tmp/x node ${ENG} ${J('ap', 'ply')} 1`), true],
    ['moving the config in PowerShell', B(`$env:SBRM_DV_CONFIG='C:/tmp'; node ${ENG} plan x.json`, 'PowerShell'), true],
    ['a dev-folder .. walk that leaves the folder', W(`${DEV}/../elsewhere/x.js`, J('const { write', 'Connection } = require("../lib/write");')), true],
    // The 10/7 re-verify's probes: the accident-plausible ones first, then a sample of deliberate spellings.
    ['CLI: an unknown flag before the verb', B(J('dataverse --env donorapp data cre', 'ate contact x')), true],
    ['CLI: a real global flag before a write verb', B(J('dataverse --log-level Debug data del', 'ete contact 1')), true],
    ['CLI: a real global flag before a read is fine', B('dataverse --log-level Debug data query contacts'), false],
    ['CLI: dataverse.cmd', B(J('dataverse.cmd data up', 'date contact 1')), true],
    ['CLI: through npx', B(J('npx @microsoft/dataverse data cre', 'ate contact x')), true],
    ['CLI: the raw bearer token', B(J('dataverse auth to', 'ken --environment https://x.crm.dynamics.com')), true],
    ['CLI: sign-in and profiles are fine (setup)', B('dataverse auth create --environment https://sbrmdonorapp.crm.dynamics.com && dataverse auth list'), false],
    ['HTTP: curl -d at Dataverse', B(J('curl -H "Authorization: Bearer $T" https://sbrmfedev.crm.dynamics.com/api/data/v9.2/contacts -', 'd \'{}\'')), true],
    ['HTTP: python requests.post at Dataverse', B(J('python -c "import requests; requests.po', 'st(\'https://sbrmhgs.crm.dynamics.com/api/data/v9.2/x\', json={})"')), true],
    ['HTTP: Invoke-RestMethod -Me Patch -Body', B(J('Invoke-RestMethod -Uri https://x.crm.dynamics.com/api/data/v9.2/contacts(1) -Me Pat', 'ch -Body $b'), 'PowerShell'), true],
    ['HTTP: an abbreviated -Me Delete, no body', B(J('Invoke-WebRequest -Uri https://x.crm.dynamics.com/api/data/v9.2/contacts(1) -Me:Del', 'ete'), 'PowerShell'), true],
    ['HTTP: a GET at Dataverse is fine', B('curl -s https://sbrmdonorapp.crm.dynamics.com/api/data/v9.2/WhoAmI'), false],
    ['store: python os.remove', B(J('python -c "import os; os.rem', 'ove(\'', H, '/.sbrm-dataverse/pending/a.json\')"')), true],
    ['store: PowerShell ri alias', B(J('r', 'i ~/.sbrm-dataverse/pending/a.json'), 'PowerShell'), true],
    ['store: [IO.File]::Delete', B(J('[IO.File]::Del', 'ete("$HOME/.sbrm-dataverse/log/x.md")'), 'PowerShell'), true],
    ['store: cmd rmdir', B(J('cmd /c rmd', 'ir /s /q %USERPROFILE%\\.sbrm-dataverse\\plans')), true],
    ['store: perl write', B(J('perl -e \'open(F,">', H, '/.sbrm-dataverse/config/dev_dirs.json")\'')), true],
    ['store: robocopy in', B(J('robo', 'copy C:\\tmp\\x ', H, '\\.sbrm-dataverse\\plans')), true],
    ['store: tar -C into it', B(J('t', 'ar -xf x.tar -C ~/.sbrm-dataverse/plans')), true],
    ['store: a junction to it', B(J('cmd /c mkl', 'ink /J C:\\x ', H, '\\.sbrm-dataverse\\plans')), true],
    ['store: cd into jobs then .. out', B(J('cd ~/.sbrm-dataverse/jobs/../plans && c', 'p a.json b.json')), true],
    ['store: plain reads are fine', B('ls ~/.sbrm-dataverse/plans && grep -c applied ~/.sbrm-dataverse/log/a.md && find ~/.sbrm-dataverse -name "*.json" | head'), false],
    ['plugin: git apply into it', B(J('git -C ', H, '/.claude/plugins/marketplaces/sbrm-claude-toolkit app', 'ly x.patch')), true],
    ['plugin: npm install into it', B(J('npm inst', 'all --prefix ', H, '/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit x')), true],
    ['home moved for an apply', B(J('USERPROFILE=/tmp/x node ', ENG, ' ap', 'ply 1')), true],
    ['store moved via Set-Item', B(J('Set-Item ("env:SBRM_"+"DV_HOME") C:\\tmp; node ', ENG, ' plan x.json'), 'PowerShell'), true],
    ['plugin disabled from the CLI', B(J('claude plugin dis', 'able sbrm-toolkit@sbrm-claude-toolkit')), true],
    ['plugin disabled in settings', W(`${H}/.claude/settings.json`, J('{"enabledPlugins": {"sbrm-toolkit@sbrm-claude-toolkit": fal', 'se}}')), true],
    ['keystrokes via pynput', B(J('python -c "from pyn', 'put.keyboard import Controller; Controller().press(\'a\')"')), true],
    ['decoded code', B(J('node -e "ev', 'al(Buffer.from(process.argv[1],\'base64\').toString())" aGk=')), true],
    ['preloaded code', B(J('NODE_OPTIONS="--req', 'uire C:/x/sbrm/x.js" node -e 1')), true],
    ['a doc that mentions the store variable is fine', W('C:/temp/notes.md', 'Tests set SBRM_DV_HOME to a temp folder.'), false],
    ['engine show piped to head is fine', B(`node ${ENG} show 3 | head -20`), false],
    // 10/7 third adversarial pass (1.10.1): the plan signing key, the CLI by npx/shim, more HTTP spellings,
    // other Dataverse writers, other tools, the approval-waiting marker; and the false positives it found
    ['Read the plan signing key', { tool_name: 'Read', tool_input: { file_path: `${H}/.sbrm-dataverse/config/plan.key` } }, true],
    ['Read the dev exemptions is fine', { tool_name: 'Read', tool_input: { file_path: `${H}/.sbrm-dataverse/config/dev_dirs.json` } }, false],
    ['Grep the store root', { tool_name: 'Grep', tool_input: { pattern: '.', path: `${H}/.sbrm-dataverse` } }, true],
    ['Grep the log folder is fine', { tool_name: 'Grep', tool_input: { pattern: 'applied', path: `${H}/.sbrm-dataverse/log` } }, false],
    ['cat the key', B(J('cat ~/.sbrm-dataverse/config/plan.', 'key')), true],
    ['cat a wildcard in config', B('cat ~/.sbrm-dataverse/config/*'), true],
    ['grep -r the store root', B('grep -r x ~/.sbrm-dataverse'), true],
    ['find the root into xargs cat', B('find ~/.sbrm-dataverse -type f | xargs cat'), true],
    ['cd into the store root', B('cd ~/.sbrm-dataverse && grep -r x .'), true],
    ['list the store root is fine', B('ls ~/.sbrm-dataverse'), false],
    ['CLI by npx at the pinned version', B(J('npx @microsoft/dataverse@1.0.81 data cre', 'ate contact x')), true],
    ['CLI by its node shim target', B(J('node "$(npm root -g)/@microsoft/dataverse/bin/dataverse.js" data up', 'date contact 1')), true],
    ['HTTP: urllib with a body', B(J('python -c "import urllib.request as u; u.urlopen(u.Request(\'https://x.crm.dynamics.com/api/data/v9.2/contacts\', da', 'ta=b\'{}\'))"')), true],
    ['HTTP: a Session().patch', B(J('python -c "import requests; requests.Session().pat', 'ch(\'https://x.crm.dynamics.com/api/data/v9.2/contacts(1)\', json={})"')), true],
    ['HTTP: httpie PATCH', B(J('http PAT', 'CH https://x.crm.dynamics.com/api/data/v9.2/contacts(1) name=x')), true],
    ['HTTP: wget --post-data', B(J('wget --post-da', 'ta=\'{}\' https://x.crm.dynamics.com/api/data/v9.2/contacts')), true],
    ['Xrm PowerShell cmdlet', B(J('Set-Crm', 'Record -conn $c -EntityLogicalName contact -Id $id -Fields @{x=1}'), 'PowerShell'), true],
    ['Power Platform CLI import', B(J('pac solution imp', 'ort --path x.zip')), true],
    ['MCP: a claude.ai Dataverse connector write', { tool_name: J('mcp__claude_ai_Dataverse__create_', 'record') }, true],
    ['MCP: a claude.ai Dataverse connector read is fine', { tool_name: 'mcp__claude_ai_Dataverse__read_query' }, false],
    ['browser JavaScript writing at Dataverse', { tool_name: 'mcp__claude-in-chrome__javascript_tool', tool_input: { text: J('fetch("https://x.crm.dynamics.com/api/data/v9.2/contacts(1)", {method: "PAT', 'CH", body: "{}"})') } }, true],
    ['browser JavaScript reading is fine', { tool_name: 'mcp__claude-in-chrome__javascript_tool', tool_input: { text: 'document.title' } }, false],
    ['multi-line osascript click', B(J('osascript -e \'tell application "System Events"\' -e \'tell process "x"\' -e \'cli', 'ck button "Approve" of window 1\' -e \'end tell\'')), true],
    ['heredoc job whose reason says Dataverse is fine', B("cat > ~/.sbrm-dataverse/jobs/fix.json <<'EOF'\n{\"reason\": \"Dataverse contact address fix\"}\nEOF"), false],
    ['cd into jobs && ls is fine', B('cd ~/.sbrm-dataverse/jobs && ls'), false],
    ['a variable holding the plugin path, then the engine', B(`TK="${H}/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.10.1"; node "$TK/dataverse/engine/dataverse-write.js" whoami donorapp`), false],
    ['an echo about dataverse is fine', B('echo "dataverse tools are set up"'), false],
    ['a commit message about dataverse is fine', B('git commit -m "dataverse setup notes"'), false],
    ['the key reached relatively from inside the store', B(J('cd ~/.sbrm-dataverse/plans && cat ../config/plan.', 'key')), true],
    ['a heredoc note whose line starts like a CLI write is data', B("cat > notes.md <<'EOF'\ndataverse data delete is blocked by the guard\nEOF"), false],
    ['a heredoc handed to bash runs: its CLI write is caught', B(J("bash <<'EOF'\ndataverse data del", "ete contact 1\nEOF")), true],
    // final re-verify (1.10.1, round 4)
    ['CLI write inside a for loop', B(J('for id in a b; do dataverse data up', 'date contact $id; done')), true],
    ['CLI write inside while read', B(J('cat ids.txt | while read id; do dataverse data del', 'ete contact $id; done')), true],
    ['CLI write inside if/then', B(J('if true; then dataverse data cre', 'ate contact x; fi')), true],
    ['CLI write in a subshell', B(J('(dataverse data up', 'date contact 1)')), true],
    ['CLI write in PowerShell foreach', B(J('foreach ($i in $ids) { dataverse data up', 'date contact $i }'), 'PowerShell'), true],
    ['CLI write in ForEach-Object', B(J('$ids | ForEach-Object { dataverse data del', 'ete contact $_ }'), 'PowerShell'), true],
    ['CLI write behind timeout', B(J('timeout 30 dataverse data up', 'date contact 1')), true],
    ['CLI write via npm exec', B(J('npm exec -- dataverse data cre', 'ate contact x')), true],
    ['CLI write via xargs -I{}', B(J('cat ids | xargs -I{} dataverse data del', 'ete contact {}')), true],
    ['CLI write via $(which dataverse)', B(J('$(which dataverse) data up', 'date contact 1')), true],
    ['a read loop over the CLI is fine', B('for t in contacts accounts; do dataverse data query $t --top 1; done'), false],
    ['Grep with no path from the home folder', { tool_name: 'Grep', tool_input: { pattern: 'x' }, cwd: HOME }, true],
    ['Grep with no path from a project folder is fine', { tool_name: 'Grep', tool_input: { pattern: 'x' }, cwd: DEV }, false],
    ['Grep at the drive root', { tool_name: 'Grep', tool_input: { pattern: 'x', path: 'C:/' } }, process.platform === 'win32'],
    ['grep -r of the home folder', B('grep -r token ~'), true],
    ['find home and exec', B(J('find ~ -name "*.key" -ex', 'ec cat {} +')), true],
    ['a wildcard into the store folders', B('cat ~/.sbrm-dataverse/conf*/plan*'), true],
    ['browser Xrm.WebApi write', { tool_name: 'mcp__claude-in-chrome__javascript_tool', tool_input: { text: J('Xrm.WebApi.update', 'Record("contact", id, {firstname: "x"})') } }, true],
    ['browser form save', { tool_name: 'mcp__claude-in-chrome__javascript_tool', tool_input: { text: J('Xrm.Page.data.sa', 've()') } }, true],
    ['a Dataverse write tool on a differently named server', { tool_name: J('mcp__donorapp__update_', 'record') }, true],
    ['a Dataverse write tool on a server with an unrelated name', { tool_name: J('mcp__orgdata__create_', 'record') }, true],
    ['an unrelated server\'s own tools are fine', { tool_name: 'mcp__claude_ai_Notion__notion-create-pages' }, false],
    ['a shell-running MCP running a CLI write', { tool_name: 'mcp__desktop-commander__start_process', tool_input: { command: J('dataverse data up', 'date contact 1') } }, true],
    ['HTTP: curl -sd at Dataverse', B(J('curl -s', 'd \'{}\' https://x.crm.dynamics.com/api/data/v9.2/contacts')), true],
    ['HTTP: HttpClient.PatchAsync', B(J('$c.Patch', 'Async("https://x.crm.dynamics.com/api/data/v9.2/contacts(1)", $body)'), 'PowerShell'), true],
    ['pac application install', B(J('pac application inst', 'all --environment x')), true],
    ['pac auth create is a sign-in, fine', B('pac auth create --environment https://x.crm.dynamics.com'), false],
    ['a screen tool click while an approval is waiting', { tool_name: 'mcp__windows-mcp__Click-Tool', tool_input: { loc: [1, 2] } }, false],
    ['an apply with PATH changed on the line', B(J('PATH=/tmp/shim:$PATH node ', ENG, ' ap', 'ply 1')), true],
    ['an apply with the CLI override', B(J('SBRM_DATAVERSE_CLI=/tmp/x node ', ENG, ' ap', 'ply 1')), true],
    ['BookStack update whose body mentions the app URL is fine', B('curl -X PUT https://wiki.sbrmapps.com/api/pages/12 -H "Authorization: Token x" -d \'{"html": "The donor app lives at https://sbrmdonorapp.crm.dynamics.com"}\''), false],
    ['a Teams post mentioning a curl PATCH is fine', { tool_name: 'mcp__ms365__send-chat-message', tool_input: { body: J('Do not run curl -X PAT', 'CH https://x.crm.dynamics.com/api/data/v9.2/contacts(1)') } }, false],
    ['a .md note describing requests.patch is fine', W('C:/temp/notes.md', J('requests.pat', 'ch("https://x.crm.dynamics.com/api/data/v9.2/x")')), false],
    ['a script that reads the plan key', W('C:/temp/k.py', J('open(os.path.expanduser("~/.sbrm-dataverse/config/plan.', 'key")).read()')), true],
    ['mkdir the store on a new machine is fine', B('mkdir -p ~/.sbrm-dataverse'), false],
    ['bash -c running the CLI write is still caught', B(J('bash -c "dataverse data del', 'ete contact 1"')), true],
    // False positive found 10/8 (storing an sbrm-logs Grist key): ANY persistent env var was read as moving the
    // store. A literal name off the deny list is fine; a home/PATH/node/Claude/startup name, or a computed one, is not.
    ['persist an unrelated key as a User env var is fine (false positive 10/8)', B("[Environment]::SetEnvironmentVariable('SBRM_LOGS_GRIST_KEY', (Get-Clipboard).Trim(), 'User')", 'PowerShell'), false],
    ['Set-Item an unrelated env var is fine', B('Set-Item env:GRIST_API_KEY abc', 'PowerShell'), false],
    ['setx an unrelated env var is fine', B('setx CLOUDRON_API_TOKEN abc'), false],
    ['persist the home folder elsewhere', B("[Environment]::SetEnvironmentVariable('USERPROFILE', 'C:\\tmp', 'User')", 'PowerShell'), true],
    ['persist preloaded node code', B(J("[System.Environment]::SetEnvironmentVariable(\"NODE_OPT", "IONS\", '--require C:/x.js', 'User')"), 'PowerShell'), true],
    ['persist a computed name', B("$n='HO'+'ME'; [Environment]::SetEnvironmentVariable($n, 'C:\\tmp', 'User')", 'PowerShell'), true],
    ['persist PATH', B("[Environment]::SetEnvironmentVariable('Path', 'C:\\shim;' + $p, 'User')", 'PowerShell'), true],
    ['persist a shell start-up file', B(J('setx BASH_', 'ENV C:\\x.sh')), true],
    ['setx a Claude setting', B('setx CLAUDE_CONFIG_DIR C:\\tmp'), true],
    ['setx with a computed name', B('setx %N% C:\\tmp'), true],
    ['Set-Item the home folder', B('Set-Item env:HOME C:\\tmp', 'PowerShell'), true],
    ['Set-Item a computed env name', B('Set-Item "env:$n" C:\\tmp', 'PowerShell'), true],
    // 1.11.5, false positives 10/9 (fuller set: engine/test/guard_false_positives.test.js): invocation, not vocabulary
    ['the Forms Screen class for monitor sizes is fine', B('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.Bounds }', 'PowerShell'), false],
    ['Get-Command lookups of input tools are fine', B(J("foreach ($c in 'Auto", "Hotkey','nir", "cmd') { Get-Command $c -ErrorAction SilentlyContinue }"), 'PowerShell'), false],
    ['a grep for the rule\'s words is fine', B(J("grep -n -i -E 'injection|hotkey|Send", "Keys|nir", "cmd' guard/*")), false],
    ['a markdown plan naming input tools is fine', W('C:/temp/PLAN.md', J('Automation helpers: none (no Auto', 'Hotkey, PowerToys).')), false],
    ['a hotkey script file is refused', W(J('C:/temp/x.a', 'hk'), 'Send {Enter}'), true],
    ['a process trace with prose " / " and -Filter is fine', B('Get-CimInstance Win32_Process -Filter "ProcessId=$PID"; "=== shells / claude ==="', 'PowerShell'), false],
    ['Get-ChildItem -Recurse of $HOME', B('Get-ChildItem $HOME -Recurse | Get-Content', 'PowerShell'), true],
    ['find from the Git Bash drive root', B('find /c/ -name "*.key"'), true],
    ['a fixed file under $env:USERPROFILE is fine', B('Test-Path "$env:USERPROFILE\\.local\\bin\\claude.exe"', 'PowerShell'), false],
  ];
  // An approval waiting (a fresh ticket): a screen tool is refused only then (injected, not read).
  const screen = { tool_name: 'mcp__computer-use__left_click', tool_input: { x: 1, y: 2 } };
  const popupCases = [['screen tool while an approval is waiting', true, true], ['screen tool with none waiting is fine', false, false]];
  const dirs = [norm(DEV)];
  let fails = 0;
  const report = (label, v, expectBlocked) => {
    const ok = (v !== null) === expectBlocked;
    if (!ok) fails += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${expectBlocked ? 'block' : 'allow'}  ${label}${!ok ? `   (got: ${v || 'allowed'})` : ''}`);
  };
  for (const [label, input, expectBlocked] of cases) report(label, verdict(input, dirs, { popup: () => false }), expectBlocked);
  for (const [label, open, expectBlocked] of popupCases) report(label, verdict(screen, dirs, { popup: () => open }), expectBlocked);

  // The approval (1.11.0): which lines Claude Code is told to ASK about (and mint tickets for), which are
  // refused, and which are not approvals at all. approvalVerdict decides only; nothing is minted here.
  const ID1 = '20261008-093056-a114729a';
  const ID2 = '20261008-093108-34408f65';
  // The REAL engine beside this guard: an approval must name it (a look-alike path is refused).
  const OWNP = (ownEngine() || '').replace(/\\/g, '/');
  const OWN = `"${OWNP}"`;
  const EDIR = path.dirname(OWNP).replace(/\\/g, '/');
  const TILDE = OWNP.toLowerCase().startsWith(H.toLowerCase() + '/') && !/\s/.test(OWNP) ? '~' + OWNP.slice(H.length) : null;
  const A = (command, mode = 'default', tool = 'Bash', extra = {}) => ({ tool_name: tool, tool_input: { command }, permission_mode: mode, ...extra });
  const kind = (v) => (!v ? 'none' : v.block ? 'block' : 'ask');
  const approvalCases = [
    ['an apply on its own line asks (default mode)', A(`node ${OWN} ${J('ap', 'ply')} ${ID1}`), 'ask', [ID1]],
    ['an apply asks in auto mode', A(`node ${OWN} ${J('ap', 'ply')} ${ID1}`, 'auto'), 'ask'],
    ['an apply asks in acceptEdits mode', A(`node ${OWN} ${J('ap', 'ply')} ${ID1}`, 'acceptEdits'), 'ask'],
    ['an apply asks in plan mode', A(`node ${OWN} ${J('ap', 'ply')} ${ID1}`, 'plan'), 'ask'],
    ['an apply in bypassPermissions is refused (no prompt to trust)', A(`node ${OWN} ${J('ap', 'ply')} ${ID1}`, 'bypassPermissions'), 'block'],
    ['an apply in dontAsk is refused', A(`node ${OWN} ${J('ap', 'ply')} ${ID1}`, 'dontAsk'), 'block'],
    ['an apply with no mode given is refused', A(`node ${OWN} ${J('ap', 'ply')} ${ID1}`, null), 'block'],
    ['an apply from a subagent is refused (its prompt can be refused unseen)', A(`node ${OWN} ${J('ap', 'ply')} ${ID1}`, 'default', 'Bash', { agent_id: 'a1', agent_type: 'general-purpose' }), 'block'],
    ['a batch asks once, a ticket per plan', A(`node ${OWN} ${J('ap', 'ply')} ${ID1} ${ID2}`), 'ask', [ID1, ID2]],
    ['a batch naming one plan twice is refused', A(`node ${OWN} ${J('ap', 'ply')} ${ID1} ${ID1}`), 'block'],
    ['cd into the engine folder, then a relative apply, asks', A(`cd "${EDIR}" && node dataverse-write.js ${J('ap', 'ply')} ${ID1}`), 'ask', [ID1]],
    ...(TILDE ? [['the ~ form of the own engine with 2>&1 asks', A(`node ${TILDE} ${J('ap', 'ply')} ${ID1} 2>&1`), 'ask']] : []),
    ['an apply from the PowerShell tool asks', A(`node ${OWN} ${J('ap', 'ply')} ${ID1}`, 'default', 'PowerShell'), 'ask'],
    ['an apply chained to another command is refused', A(`node ${OWN} ${J('ap', 'ply')} ${ID1}; echo done`), 'block'],
    ['an apply && another command is refused', A(`node ${OWN} ${J('ap', 'ply')} ${ID1} && echo done`), 'block'],
    ['an apply on a second line is refused', A(`echo hi\nnode ${OWN} ${J('ap', 'ply')} ${ID1}`), 'block'],
    ['an apply of something that is not a plan id is refused', A(`node ${OWN} ${J('ap', 'ply')} ../../x`), 'block'],
    ['an engine copy outside the plugin is refused', A(`node C:/temp/engine/dataverse-write.js ${J('ap', 'ply')} ${ID1}`), 'block'],
    ['a look-alike plugin path elsewhere on disk is refused', A(`node "C:/tmp/x/.claude/plugins/cache/sbrm-claude-toolkit/sbrm-toolkit/1.0/dataverse/engine/dataverse-write.js" ${J('ap', 'ply')} ${ID1}`), 'block'],
    ['command substitution inside the quoted node word is refused', A(`"${J('$', '(curl x)')}/node" ${OWN} ${J('ap', 'ply')} ${ID1}`), 'block'],
    ['a variable inside the quoted script path is refused', A(`node "${J('$', 'HOME')}/x/dataverse/engine/dataverse-write.js" ${J('ap', 'ply')} ${ID1}`), 'block'],
    ['an apply hidden inside bash -c is refused (a leftover ticket stays out of reach)', A(`bash -c "node ${OWN} ${J('ap', 'ply')} ${ID1}"`), 'block'],
    ['plan is not an approval', A(`node ${OWN} plan job.json`), 'none'],
    ['a stand-in file named node is refused (plain node only)', A(`C:/temp/node ${OWN} ${J('ap', 'ply')} ${ID1}`), 'block'],
    ['a resolve with --fixed-in before the number asks', A(`node ${OWN} ${J('reso', 'lve')} --fixed-in 1.11.0 D-1003 fixed "done"`), 'ask', ['resolve-D-1003']],
    ['a resolve asks, keyed by its number', A(`node ${OWN} ${J('reso', 'lve')} D-1003 fixed "gift skill asks now"`), 'ask', ['resolve-D-1003']],
    ['a resolve note carrying a command separator is refused', A(`node ${OWN} ${J('reso', 'lve')} D-1003 fixed "x; echo y"`), 'block'],
    ['grep for the words is refused too (they only run as an approval)', A(J('grep -n "dataverse-write.js ', 'ap', 'ply" JOBS.md')), 'block'],
    ['an unrelated command is not an approval', A('git status'), 'none'],
  ];
  for (const [label, input, want, keys] of approvalCases) {
    const v = approvalVerdict(input);
    const ok = kind(v) === want && (!keys || JSON.stringify(v.ask.keys) === JSON.stringify(keys));
    if (!ok) fails += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${want.padEnd(5)}  ${label}${!ok ? `   (got: ${kind(v)}${v && v.block ? `: ${v.block}` : ''}${v && v.ask ? ` ${JSON.stringify(v.ask.keys)}` : ''})` : ''}`);
  }
  // A hook that answers prompts by itself would approve with nobody looking: only the person adds one.
  const answerer = [
    ['Write a PermissionRequest hook into settings', { tool_name: 'Write', tool_input: { file_path: `${H}/.claude/settings.json`, content: J('{"hooks":{"Permission', 'Request":[{"hooks":[{"type":"command","command":"x"}]}]}}') } }, true],
    ['echo a PermissionRequest hook into settings', B(J("echo '{\"hooks\":{\"Permission", "Request\":[]}}' > ", H, '/.claude/settings.local.json')), true],
    ['a settings edit without one is fine', { tool_name: 'Edit', tool_input: { file_path: `${H}/.claude/settings.json`, old_string: '"a": 1', new_string: '"a": 2' } }, false],
  ];
  for (const [label, input, expectBlocked] of answerer) report(label, verdict(input, dirs, { popup: () => false }), expectBlocked);
  const total = cases.length + popupCases.length + approvalCases.length + answerer.length;
  console.log(fails ? `\n${fails} of ${total} checks FAILED.` : `\nAll ${total} checks passed.`);
  process.exit(fails ? 1 : 0);
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => {
      let input;
      try { input = JSON.parse(raw); } catch { block('an unreadable tool call (the guard could not parse it, so it failed closed)'); }
      const ap = approvalVerdict(input);
      if (ap && ap.block) block(ap.block, input);
      if (ap && ap.ask) {
        try { askPerson(ap.ask); } catch (e) { block(`an apply the guard could not prepare an approval for (${e.message})`, input); }
      }
      const what = verdict(input);
      if (what) block(what, input);
      process.exit(0);
    });
  }
}

module.exports = { verdict, shellVerdict, writeVerdict, cliVerdict, approvalVerdict, approvalCommand, blockMessage };
