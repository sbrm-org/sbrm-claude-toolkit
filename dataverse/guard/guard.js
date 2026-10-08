#!/usr/bin/env node
'use strict';
// SBRM toolkit: the Dataverse guard (Claude Code PreToolUse hook). Ships WITH the engine, never after
// (design note F15): the approval pop-up only means something while a session cannot write around
// the engine and cannot click the pop-up. The session itself RUNS plan and apply once the person has
// agreed in chat (ruled 10/7: nobody pastes an apply line); the pop-up is the person's one step.
//
// What a Claude session may NOT do (the person's own `!` lines are not tool calls and never reach it):
//   1. reach the engine's write side without the CLI: inline code or a script that loads the write
//      module or the apply functions (the bypass that skips the pop-up altogether, same hole as the
//      QBO guard's rule C). Running the CLI's `apply` / `resolve` is allowed: it always shows the pop-up;
//   2. write through the Dataverse CLI's own write verbs, or a Dataverse MCP tool that is not a known
//      read (ALLOW-LIST, both the old `mcp__dataverse-*__` and the plugin-namespaced names);
//   3. send a raw writing HTTP call (POST/PATCH/PUT/DELETE) at *.crm.dynamics.com;
//   4. inject keystrokes or clicks (so it cannot press Approve), ported from the QBO guard's rule D;
//   5. tamper: change the engine's store (plans, log, events, pending, tmp; `jobs` is where Claude
//      saves job files, so it stays writable), change this plugin's folder, or switch hooks off.
// Everything else passes: reads, `check`, `plan`, `show`, `apply`, `resolve`, `revert` (it only plans),
// `doctor`, `report`, `review`, `whoami`, the read connections.
//
// Fails CLOSED: an unreadable tool call is blocked. Self-test: node guard.js --selftest
// Trigger strings below are spelled with character classes so this file does not trip other guards.

const os = require('os');
const path = require('path');
const fs = require('fs');

// ---------- 2. MCP read allow-list + the CLI's write verbs (from dataverse-cli-guard.js, 10/1/26) ----------

const READ_TOOLS = new Set(['describe', 'read_query', 'search', 'search_data', 'file_download', 'list_tables', 'describe_table']);
const MCP_RE = /^mcp__(?:plugin_[^_]*(?:_[^_]+)*?_)?[^_]*dataverse[^_]*__(.+)$/i;

// The CLI as a shell word (dataverse, dataverse.exe, dataverse.cmd, npx @microsoft/dataverse). Its
// arguments are parsed past its GLOBAL options (`dataverse --help` lists exactly three: --log-level <v>,
// --log-file, --context <v>), so a write verb cannot hide behind a leading flag; any OTHER leading flag is
// unknown and fails closed (10/7 re-verify: `dataverse --env x data create` was allowed).
const CLI_RE = /(?:^|[\s"'`&|;(\/\\])(?:npx\s+(?:-y\s+)?@microsoft\/)?dataverse(?:cli)?(?:\.exe|\.cmd|\.ps1)?["'`]?(?=\s)/gi;
const GLOBAL_WITH_VALUE = new Set(['--log-level', '--context']);
const GLOBAL_FLAG = new Set(['--log-file']);

function cliWords(rest) {
  return (rest.match(/"[^"]*"|'[^']*'|[^\s"';|&<>]+/g) || []).map((w) => w.replace(/^["']|["']$/g, ''));
}

function cliVerdict(command) {
  CLI_RE.lastIndex = 0;
  let m;
  while ((m = CLI_RE.exec(command)) !== null) {
    if (/--target\s*$/.test(command.slice(0, m.index + 1))) continue; // `--target dataverse` is an argument
    const end = command.slice(m.index + m[0].length).search(/[;|&\n]/);
    const words = cliWords(command.slice(m.index + m[0].length, end < 0 ? undefined : m.index + m[0].length + end));
    let i = 0;
    while (i < words.length && /^-/.test(words[i])) {
      const w = words[i].toLowerCase().split('=')[0];
      if (GLOBAL_WITH_VALUE.has(w)) i += words[i].includes('=') ? 1 : 2;
      else if (GLOBAL_FLAG.has(w)) i += 1;
      else if (['--version', '-v', '--help', '-h'].includes(w)) { i = -1; break; }
      else return `the Dataverse CLI with the unknown option "${words[i]}"`;
    }
    if (i < 0 || i >= words.length) continue; // version/help, or the word alone
    const sub = words[i].toLowerCase();
    const sub2 = (words[i + 1] || '').toLowerCase();
    const after = words.slice(i + 1).join(' ');
    let ok;
    if (['org', 'env', 'help'].includes(sub)) ok = true;
    // A session never needs the raw bearer token: with it any HTTP tool writes around the pop-up.
    else if (sub === 'auth') ok = !['token', 'get-token', 'access-token'].includes(sub2);
    else if (sub === 'data') ok = ['query', 'get', 'count', 'describe', '--help', '-h', ''].includes(sub2); // describe: a read, new in 1.0.81
    else if (sub === 'api' && sub2 === 'request') {
      const method = after.match(/(?:--method|-X)(?:\s+|=)["']?([A-Za-z]+)/);
      ok = !(method && method[1].toUpperCase() !== 'GET') && !/--body/.test(after);
    } else if (sub === 'api') ok = ['list', 'describe', '--help', '-h', ''].includes(sub2);
    else if (sub === 'mcp') ok = sub2 !== 'allow';
    else if (/^[a-z][a-z-]*$/.test(sub)) ok = false; // erp, skill, install, or a verb this list does not know
    else continue; // not a CLI call (e.g. a path or a word that only contains "dataverse")
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
].join('|'), 'i');

// The Dataverse CLI called with its arguments as a LIST (Python subprocess, Node execFile/spawn), where the
// words are quoted and comma-separated, so the shell-shaped CLI rule never matches (10/7 review). Any
// list-form call naming the CLI with a write method, a body or a data write verb is blocked.
const CLI_LIST = /['"`]dataverse(?:cli)?(?:\.exe)?['"`]\s*,/i;
const LIST_WRITE = /['"`](?:--method|-X)['"`]\s*,\s*['"`](?:POST|PATCH|PUT|DELETE|MERGE)['"`]|['"`]--body(?:-file)?['"`]|['"`](?:create|update|upsert|delete|upload|associate|disassociate)['"`]/i;

// ---------- 4. keystroke / click injection (the QBO guard's rule D, same spelling trick) ----------

const INJECT = new RegExp(
  '\\bSend[K]eys\\b|\\bApp[A]ctivate\\b|keybd[_]event|\\bSend[I]nput\\b|mouse[_]event|py[a]utogui|'
  + 'py[w]inauto|UI[A]utomation|Auto[H]otkey|\\.a[h]k\\b|WScript\\.[S]hell|Post[M]essage[AW]?\\s*\\(|'
  + 'System\\s+Events.{0,40}(?:keystroke|click|key\\s+code)|cl[i]click|xdo[t]ool|pyn[p]ut|\\bkeyboard\\.(?:press|write|send|type|press_and_release)\\b|nir[c]md|'
  + '\\bmouse\\.(?:click|press)\\b|robotjs|nut-tree|\\bautoit\\b', 'i');

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
const STORE_MOVE = /\bSBRM_DV_(?:HOME|CONFIG)\b|(?:^|[\s;&|(])(?:USERPROFILE|HOME|HOMEPATH|HOMEDRIVE)=|\$env:(?:USERPROFILE|HOME|HOMEPATH|HOMEDRIVE)\s*=|\bSet-Item\b[^;|&\n]*\benv:|\[Environment\]::SetEnvironmentVariable/i;

// A command that NAMES the store (or works inside it after a cd) may only be one of these reads; anything
// else (another language's file API, an archive tool, a link maker, an alias) is refused rather than
// guessed at (10/7 re-verify: 57 of 60 crafted spellings passed a list of banned words).
const STORE_READ_CMDS = new Set(['cat', 'type', 'ls', 'dir', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'findstr',
  'less', 'more', 'wc', 'stat', 'file', 'md5sum', 'sha1sum', 'sha256sum', 'diff', 'cmp', 'echo', 'printf', 'test', '[',
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'gi', 'test-path', 'select-string', 'sls', 'resolve-path',
  'get-filehash', 'measure-object', 'cd', 'set-location', 'sl', 'pushd', 'popd', 'find', 'xxd', 'od', 'jq', 'cut']);
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
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py']);

// Every simple command that names the store, or runs after a `cd` into it, must be a plain read
// (STORE_READ_CMDS, no redirect, no find -delete/-exec). A command that names the plugin must be a plain
// read or an interpreter run with nothing in it that writes (reading the plugin's JSON settings is fine).
function storeOrPluginVerdict(segs) {
  let inStore = false;
  for (const seg of segs) {
    const first = firstWord(seg);
    const namesStore = STORE_NAMED(seg);
    const isCd = ['cd', 'set-location', 'sl', 'pushd'].includes(first);
    if (namesStore || inStore) {
      const read = STORE_READ_CMDS.has(first) && !(first === 'find' && FIND_WRITES.test(seg)) && !REDIRECT.test(unquoted(seg));
      if (!read) return "changing the engine's own store (plans, log, events): only plain reads may name it";
    }
    if (isCd) inStore = /\.sbrm-dataverse/i.test(seg);
    if (PLUGIN_IN_TEXT.test(seg)) {
      const read = (STORE_READ_CMDS.has(first) && !(first === 'find' && FIND_WRITES.test(seg)) && !REDIRECT.test(unquoted(seg)))
        || (INTERPRETERS.has(first) && !mutates(seg));
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

// ---------- the verdict ----------

function shellVerdict(text) {
  const segs = segments(text.replace(HARMLESS_REDIRECT, ' ')).filter((s) => !isEngineRun(s));
  const rest = segs.join(' ; ');
  if (HIDDEN_CODE.test(text)) return 'code that runs out of sight (decoded at run time, or preloaded into node)';
  if (PLUGIN_OFF_SHELL.test(rest)) return 'switching the toolkit plugin (and its guard) off';
  const sp = storeOrPluginVerdict(segs);
  if (sp) return sp;
  const cli = cliVerdict(rest);
  if (cli) return `${cli}, which writes to Dataverse`;
  if (CLI_LIST.test(rest) && LIST_WRITE.test(rest)) return "the Dataverse CLI's write side, called with a list of arguments";
  if (ENGINE_INTERNALS.test(rest)) return "code that reaches the engine's write side directly (it would skip the approval pop-up)";
  if (DV_HOST.test(rest) && MUTATING_HTTP.test(rest)) return 'a raw writing HTTP call at Dataverse';
  if (INJECT.test(rest)) return 'keystroke or click injection (the approval pop-up is the person\'s alone)';
  if (STORE_MOVE.test(text)) return "moving the engine's store or settings for a run (plans must stay where the guard protects them)";
  // The path is looked for in the WHOLE line (an engine run can feed a later delete, `show 1 | xargs rm`);
  // the mutating command only outside the engine's own arguments.
  if ((STORE_IN_TEXT.test(text) || STORE_ANY.test(text)) && mutates(rest)) return "changing the engine's own store (plans, log, events)";
  if (PLUGIN_IN_TEXT.test(text) && mutates(rest)) return "changing the toolkit plugin's files";
  if (HOOKS_OFF.test(rest)) return 'switching hooks off';
  return null;
}

function contentOf(tool, ti) {
  if (tool === 'Write') return String(ti.content || '');
  if (tool === 'Edit') return String(ti.new_string || '');
  if (tool === 'MultiEdit') return (ti.edits || []).map((e) => String((e && e.new_string) || '')).join('\n');
  if (tool === 'NotebookEdit') return String(ti.new_source || '');
  return '';
}

function writeVerdict(tool, ti, dirs) {
  const file = ti.file_path || ti.notebook_path || '';
  if (inPlugin(file)) return "changing the toolkit plugin's files";
  if (inProtectedStore(file)) return "changing the engine's own store (plans, log, events)";
  const text = contentOf(tool, ti);
  if (SETTINGS_FILE.test(norm(file)) && HOOKS_OFF.test(text)) return 'switching hooks off';
  if (SETTINGS_FILE.test(norm(file)) && PLUGIN_OFF_SETTINGS.test(text)) return 'switching the toolkit plugin (and its guard) off';
  if (HIDDEN_CODE.test(text) && !inDevDir(file, dirs)) return 'writing code that runs out of sight (decoded at run time, or preloaded into node)';
  if (INJECT.test(text)) return 'writing keystroke or click injection (the approval pop-up is the person\'s alone)';
  if (!inDevDir(file, dirs)) {
    if (ENGINE_INTERNALS.test(text)) return "writing code that reaches the engine's write side directly (it would skip the approval pop-up)";
    if (DV_HOST.test(text) && MUTATING_HTTP.test(text)) return 'writing a raw writing HTTP call at Dataverse';
    if (CLI_LIST.test(text) && LIST_WRITE.test(text)) return "writing code that calls the Dataverse CLI's write side";
    // Code only: a note or doc that mentions the variable is not a run (re-verify false positive).
    if (STORE_MOVE.test(text) && /\.(?:js|cjs|mjs|ts|py|ps1|psm1|sh|bash|cmd|bat|rb|pl)$/i.test(file)) return "writing code that moves the engine's store or settings";
  }
  return null;
}

function verdict(input, dirs = devDirs()) {
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const mcp = MCP_RE.exec(tool);
  if (mcp) return READ_TOOLS.has(mcp[1]) ? null : `the Dataverse tool "${mcp[1]}" (only known reads are allowed)`;
  if (tool === 'Bash' || tool === 'PowerShell') return shellVerdict(String(ti.command || ''));
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return writeVerdict(tool, ti, dirs);
  return null;
}

function block(what) {
  process.stderr.write(
    `BLOCKED by the SBRM toolkit Dataverse guard: ${what}. `
    + 'A change to Dataverse goes through the shared write path: Claude plans it, runs `apply` once the '
    + 'person has agreed, and the person approves it in the pop-up. Tell the person what you were trying '
    + 'to do. Do not look for another way, and do not edit or remove this hook.\n',
  );
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
    ['engine apply (shows the pop-up)', B(`node ${ENG} ${J('ap', 'ply')} 20261007-122502-eec9f60a`), false],
    ['engine apply via PowerShell', B(`node ${ENG} ${J('ap', 'ply')} 1`, 'PowerShell'), false],
    ['engine resolve (shows the pop-up)', B(`node ${ENG} ${J('reso', 'lve')} D-1001 fixed "x"`), false],
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
    ['Write a script that runs the CLI apply (pop-up still shows)', W('C:/temp/go.ps1', `node ${ENG} ${J('ap', 'ply')} 1`), false],
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
  ];
  const dirs = [norm(DEV)];
  let fails = 0;
  for (const [label, input, expectBlocked] of cases) {
    const v = verdict(input, dirs);
    const ok = (v !== null) === expectBlocked;
    if (!ok) fails += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${expectBlocked ? 'block' : 'allow'}  ${label}${!ok ? `   (got: ${v || 'allowed'})` : ''}`);
  }
  console.log(fails ? `\n${fails} of ${cases.length} checks FAILED.` : `\nAll ${cases.length} checks passed.`);
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
      const what = verdict(input);
      if (what) block(what);
      process.exit(0);
    });
  }
}

module.exports = { verdict, shellVerdict, writeVerdict, cliVerdict };
