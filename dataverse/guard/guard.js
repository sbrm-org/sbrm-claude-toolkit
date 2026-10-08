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

const CLI_RE = /(?:^|[\s"'`&|;(\/\\])dataverse(?:cli)?(?:\.exe)?["'`]?\s+([^\s"'`;|&<>]+)(?:\s+([^\s"'`;|&<>]+))?/g;
const CLI_WORDS = new Set(['auth', 'org', 'env', 'api', 'erp', 'data', 'skill', 'mcp', 'install', 'help',
  '--version', '-v', '--help', '-h', '--log-level', '--log-file', '--context']);

function cliVerdict(command) {
  CLI_RE.lastIndex = 0;
  let m;
  while ((m = CLI_RE.exec(command)) !== null) {
    if (/--target\s*$/.test(command.slice(0, m.index + 1))) continue;
    const sub = m[1].toLowerCase();
    const sub2 = (m[2] || '').toLowerCase();
    if (!CLI_WORDS.has(sub)) continue;
    let ok;
    if (['auth', 'org', 'env', '--version', '-v', '--help', '-h', 'help'].includes(sub)) ok = true;
    else if (sub === 'data') ok = ['query', 'get', 'count', 'describe', '--help', '-h', ''].includes(sub2); // describe: a read, new in 1.0.81
    else if (sub === 'api' && sub2 === 'request') {
      const rest = command.slice(m.index);
      const method = rest.match(/(?:--method|-X)\s+["']?([A-Za-z]+)/);
      ok = !(method && method[1].toUpperCase() !== 'GET') && !/--body/.test(rest);
    } else if (sub === 'api') ok = ['list', 'describe', '--help', '-h', ''].includes(sub2);
    else if (sub === 'mcp') ok = sub2 !== 'allow';
    else ok = false;
    if (!ok) return `the Dataverse CLI's "${sub}${sub2 ? ' ' + sub2 : ''}"`;
  }
  return null;
}

// ---------- 1. the engine's own writes ----------

// Code that reaches the write side directly: the write connection, the apply functions, or the engine
// entry point loaded as a module (to call runCli with a write verb).
const ENGINE_INTERNALS = /\b(?:writeConnection|applyPlan|applyMerge|applyUnmerge)\b|lib[\\/]+(?:write|apply)(?:\.js)?['"`]|require\(\s*['"`][^'"`]*dataverse-write/;

// ---------- 3. raw writing HTTP at Dataverse ----------

const DV_HOST = /[\w-]+\.crm\d*\.dynamics\.com/i;
const MUTATING_HTTP = /(?:-X|--request)\s*["']?(?:POST|PATCH|PUT|DELETE|MERGE)\b|-Method\s+["']?(?:Post|Patch|Put|Delete|Merge)\b|method\s*[:=]\s*["'`](?:POST|PATCH|PUT|DELETE|MERGE)["'`]/i;

// ---------- 4. keystroke / click injection (the QBO guard's rule D, same spelling trick) ----------

const INJECT = new RegExp(
  '\\bSend[K]eys\\b|\\bApp[A]ctivate\\b|keybd[_]event|\\bSend[I]nput\\b|mouse[_]event|py[a]utogui|'
  + 'py[w]inauto|UI[A]utomation|Auto[H]otkey|\\.a[h]k\\b|WScript\\.[S]hell|Post[M]essage[AW]?\\s*\\(|'
  + 'System\\s+Events.{0,40}(?:keystroke|click)|cl[i]click|xdo[t]ool', 'i');

// ---------- 5. tamper ----------

const HOME = os.homedir();
function norm(p) {
  let s = String(p || '').replace(/\\/g, '/');
  if (s.startsWith('~/')) s = HOME.replace(/\\/g, '/') + s.slice(1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
const STORE = norm(path.join(HOME, '.sbrm-dataverse'));
const PROTECTED_STORE = ['plans', 'log', 'events', 'pending', 'tmp'];
function inProtectedStore(p) {
  const n = norm(p);
  return PROTECTED_STORE.some((d) => n === `${STORE}/${d}` || n.startsWith(`${STORE}/${d}/`));
}
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT ? norm(process.env.CLAUDE_PLUGIN_ROOT) : null;
}
function inPlugin(p) {
  const n = norm(p);
  const root = pluginRoot();
  if (root && (n === root || n.startsWith(root + '/'))) return true;
  return /\/\.claude\/plugins\/(?:cache|marketplaces)\/sbrm-claude-toolkit\//i.test(n);
}
const SETTINGS_FILE = /\/\.claude\/settings(?:\.local)?\.json$|\/managed-settings\.json$/i;
// Only switching hooks OFF: setting it back to false is doctor's own fix and must pass (10/7).
const HOOKS_OFF = /disable[A]llHooks["'`]?\s*[:=]\s*["'`]?(?:true|\$true|1)\b/i;
const SHELL_MUTATE = /\b(?:rm|del|erase|mv|move|cp|copy|tee|truncate|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Content|Add-Content|Out-File|Clear-Content|New-Item)\b|sed\s+-i|>{1,2}/i;
const STORE_IN_TEXT = new RegExp(`\\.sbrm-dataverse[\\\\/]+(?:${PROTECTED_STORE.join('|')})\\b`, 'i');
const PLUGIN_IN_TEXT = /\.claude[\\/]+plugins[\\/]+(?:cache|marketplaces)[\\/]+sbrm-claude-toolkit/i;

// Folders where the engine itself is developed (Dylan's staging copy): code there may reference the
// write side. Listed in the plugin's dataverse/toolkit.json, which this guard also protects.
function devDirs() {
  const root = pluginRoot();
  if (!root) return [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'dataverse', 'toolkit.json'), 'utf8'));
    return (cfg.dev_dirs || []).map(norm);
  } catch {
    return [];
  }
}
function inDevDir(p, dirs) {
  const n = norm(p);
  return dirs.some((d) => n === d || n.startsWith(d.replace(/\/$/, '') + '/'));
}

// ---------- the verdict ----------

function shellVerdict(text) {
  const cli = cliVerdict(text);
  if (cli) return `${cli}, which writes to Dataverse`;
  if (ENGINE_INTERNALS.test(text)) return "code that reaches the engine's write side directly (it would skip the approval pop-up)";
  if (DV_HOST.test(text) && MUTATING_HTTP.test(text)) return 'a raw writing HTTP call at Dataverse';
  if (INJECT.test(text)) return 'keystroke or click injection (the approval pop-up is the person\'s alone)';
  if (STORE_IN_TEXT.test(text) && SHELL_MUTATE.test(text)) return "changing the engine's own store (plans, log, events)";
  if (PLUGIN_IN_TEXT.test(text) && SHELL_MUTATE.test(text)) return "changing the toolkit plugin's files";
  if (HOOKS_OFF.test(text)) return 'switching hooks off';
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
  if (INJECT.test(text)) return 'writing keystroke or click injection (the approval pop-up is the person\'s alone)';
  if (!inDevDir(file, dirs)) {
    if (ENGINE_INTERNALS.test(text)) return "writing code that reaches the engine's write side directly (it would skip the approval pop-up)";
    if (DV_HOST.test(text) && MUTATING_HTTP.test(text)) return 'writing a raw writing HTTP call at Dataverse';
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
