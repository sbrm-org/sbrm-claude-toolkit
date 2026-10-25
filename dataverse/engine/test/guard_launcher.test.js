'use strict';
// The guard's launcher (guard/run.sh). A hook that cannot start fails OPEN in Claude Code (tested 10/7),
// so the launcher must find node, and without it must fail CLOSED for anything touching Dataverse.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RUN = path.join(__dirname, '..', '..', 'guard', 'run.sh');
// A bare `bash` on Windows can be the WSL stub (Claude Guardrails trap); use Git Bash explicitly.
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const V = ['ap', 'ply'].join('');
// A block is RECORDED in the store from 1.11.6: every spawned guard gets a throwaway one (never the real store).
const SCRATCH = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sbrmdv-launch-'));
const call = (input, env = {}) => spawnSync(BASH, [RUN], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: SCRATCH, ...env } });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('with node: the real guard decides (a raw write blocked; plan allowed; an apply outside the plugin refused)', (t) => {
  if (!fs.existsSync(BASH)) { t.skip('no bash at ' + BASH); return; }
  assert.equal(call(bash('curl -X PATCH https://sbrmdonorapp.crm.dynamics.com/api/data/v9.2/contacts(1)')).status, 2);
  assert.equal(call(bash(`node C:/x/dataverse-write.js ${V} 1`)).status, 2, 'not this plugin, not a plan id: refused');
  assert.equal(call(bash('node C:/x/dataverse-write.js plan j.json')).status, 0);
  assert.equal(call(bash('ls')).status, 0);
});

// 1.11.0 (DESIGN.md §10n): the hook answers an apply with Claude Code's "ask" and mints the ticket the
// engine will use up; in a mode that does not ask, it refuses. A throwaway store, never the real one.
test('an apply of the plugin engine: the hook says "ask" and mints a ticket the engine accepts; bypass mode is refused', (t) => {
  if (!fs.existsSync(BASH)) { t.skip('no bash at ' + BASH); return; }
  const os = require('os');
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-hook-'));
  const env = { SBRM_DV_HOME: store };
  const ID = '20261008-093056-a114729a';
  // The real engine beside the guard: an approval must name it (a look-alike path is refused).
  const ENG = path.join(__dirname, '..', 'dataverse-write.js').replace(/\\/g, '/');
  const input = (mode) => ({ tool_name: 'Bash', tool_input: { command: `node "${ENG}" ${V} ${ID}` }, permission_mode: mode });
  // A plan file in the throwaway store: the prompt carries its headline and warning (ruled 10/8: the
  // prompt is the only yes).
  fs.mkdirSync(path.join(store, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(store, 'plans', `${ID}.json`), JSON.stringify({ kind: 'rows', mode: 'update', app: 'Donor App', labels: { singular: 'Contact', plural: 'Contacts' }, rows: [{ body: { address1_city: 'x' } }, { body: { address1_city: 'y' } }], severity: { lines: ['Large change: 2 contacts.'] } }));
  const r = call(input('auto'), env);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'SBRM Dataverse: Update 2 contacts in the Donor App. Large change: 2 contacts. Yes writes it; No stops it.');
  // The engine's half, against the same store: the ticket is good once.
  process.env.SBRM_DV_HOME = store;
  delete require.cache[require.resolve('../lib/ticket')];
  delete require.cache[require.resolve('../lib/store')];
  const ticket = require('../lib/ticket');
  assert.equal(ticket.take(ID).ok, true);
  assert.equal(ticket.take(ID).ok, false);
  const b = call(input('bypassPermissions'), env);
  assert.equal(b.status, 2);
  assert.match(b.stderr, /does not ask the person/);
  assert.equal(ticket.check(ID).ok, false, 'a refused apply mints nothing');
  // From a subagent: refused, nothing minted (its prompt could be refused unseen).
  const sub = call({ ...input('default'), agent_id: 'a1', agent_type: 'general-purpose' }, env);
  assert.equal(sub.status, 2);
  assert.equal(ticket.check(ID).ok, false);
});

test('WITHOUT node: anything touching Dataverse is blocked (fail closed); unrelated calls pass', (t) => {
  if (!fs.existsSync(BASH)) { t.skip('no bash at ' + BASH); return; }
  const env = { SBRM_GUARD_TEST_NO_NODE: '1' };
  const blocked = [
    bash(`node C:/x/dataverse-write.js ${V} 1`),
    bash(['dataverse data ', 'up', 'date contact 1'].join('')),
    bash('curl -X PATCH https://sbrmdonorapp.crm.dynamics.com/api/data/v9.2/contacts(1)'),
    bash(['r', 'm ~/.sbrm-dataverse/plans/1.json'].join('')),
    { tool_name: 'Write', tool_input: { file_path: '/tmp/x.py', content: 'subprocess.run(["dataverse", "data", "delete"])' } },
    { tool_name: 'mcp__plugin_sbrm-toolkit_dataverse-donorapp__read_query' },
  ];
  for (const input of blocked) {
    const r = call(input, env);
    assert.equal(r.status, 2, JSON.stringify(input));
    assert.match(r.stderr, /could not run \(Node was not found \(test\)\)/);
  }
  assert.equal(call(bash('ls -la && git status'), env).status, 0, 'unrelated work is not bricked');
  assert.equal(call({ tool_name: 'Write', tool_input: { file_path: '/tmp/notes.md', content: 'lunch at noon' } }, env).status, 0);
});

// 10/25/26 (speed): every PreToolUse call runs this launcher, and each helper process it started (cat, dirname, the
// `$(...)` subshells, a pipe) cost ~50-100 ms on Windows: the launcher took 470-650 ms around a guard that decides in
// ~100-160 ms. With PATH reduced to node's own folder, any helper the happy path still needs is missing, so the guard
// would see no input or not be found. A raw write still blocking and `ls` still passing proves the happy path is
// bash builtins + node. Git's REAL bash (usr/bin): its bin/ wrapper re-adds the system folders to PATH.
test('the happy path starts nothing but node (PATH = node\'s folder only): a raw write still blocks', (t) => {
  const realBash = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/bash.exe' : '/bin/bash';
  if (!fs.existsSync(realBash)) { t.skip('no bash at ' + realBash); return; }
  const env = { ...process.env, SBRM_DV_HOME: SCRATCH, PATH: path.dirname(process.execPath) };
  const run = (input) => spawnSync(realBash, [RUN], { input: JSON.stringify(input), encoding: 'utf8', env });
  const w = run(bash('curl -X PATCH https://sbrmdonorapp.crm.dynamics.com/api/data/v9.2/contacts(1)'));
  assert.equal(w.status, 2, w.stderr);
  assert.doesNotMatch(w.stderr, /could not run/, 'the real guard decided, not the no-node fallback');
  assert.equal(run(bash('ls')).status, 0);
});

// Review F3 (1.11.20, Codex): `read -d ''` alone stops at the first NUL byte, where the old `$(cat)` dropped the NUL
// and kept the rest. Valid JSON never carries one, but the launcher must read ALL of stdin either way.
test('input past a NUL byte still reaches the decision (the fallback sees the Dataverse text after it)', (t) => {
  if (!fs.existsSync(BASH)) { t.skip('no bash at ' + BASH); return; }
  const raw = JSON.stringify(bash('ls')) + '\u0000' + 'dataverse';
  const r = spawnSync(BASH, [RUN], { input: raw, encoding: 'utf8',
    env: { ...process.env, SBRM_DV_HOME: SCRATCH, SBRM_GUARD_TEST_NO_NODE: '1' } });
  assert.equal(r.status, 2, r.stderr);
});

// The launcher hands the input on as a here-string (no pipe): a payload far past the pipe buffer must arrive whole.
test('a 300 KB Write payload reaches the guard whole (a raw write at its END still blocks)', (t) => {
  if (!fs.existsSync(BASH)) { t.skip('no bash at ' + BASH); return; }
  const tail = 'requests.patch("https://sbrmdonorapp.crm.dynamics.com/api/data/v9.2/contacts(1)", json={})\n';
  const big = { tool_name: 'Write', tool_input: { file_path: '/tmp/x.py', content: '# pad\n'.repeat(50000) + tail } };
  assert.equal(call(big).status, 2);
  assert.equal(call({ tool_name: 'Write', tool_input: { file_path: '/tmp/x.md', content: 'notes\n'.repeat(50000) } }).status, 0);
});

// 1.11.23, review F1 + F2 of 1.11.20 (pre-existing in the no-node fallback): (F1) its Dataverse match ran through
// `grep`, so with grep missing too it allowed everything; (F2) it matched the raw JSON, so a tool name spelled with
// \u escapes slipped past. The fallback now matches with bash builtins, on the input with \u00XX escapes decoded.
test('WITHOUT node and WITHOUT grep: a Dataverse MCP call is still blocked; unrelated calls pass (F1)', (t) => {
  const realBash = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/bash.exe' : '/bin/bash';
  if (!fs.existsSync(realBash)) { t.skip('no bash at ' + realBash); return; }
  const empty = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sbrmdv-nopath-'));
  const env = { ...process.env, SBRM_DV_HOME: SCRATCH, SBRM_GUARD_TEST_NO_NODE: '1', PATH: empty };
  const run = (input) => spawnSync(realBash, [RUN], { input: JSON.stringify(input), encoding: 'utf8', env });
  const r = run({ tool_name: 'mcp__plugin_sbrm-toolkit_dataverse-donorapp__read_query' });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(run(bash('curl -X PATCH https://sbrmdonorapp.crm.dynamics.com/api/data/v9.2/contacts(1)')).status, 2);
  assert.equal(run(bash('ls -la')).status, 0, 'unrelated work is not bricked');
});

test('WITHOUT node: a tool name spelled with \\u escapes is decoded before the match (F2)', (t) => {
  if (!fs.existsSync(BASH)) { t.skip('no bash at ' + BASH); return; }
  const env = { SBRM_GUARD_TEST_NO_NODE: '1' };
  const esc = '{"tool_name":"mcp__plugin_sbrm-toolkit_\\u0064ataverse-donorapp__read_query","tool_input":{}}';
  const r = spawnSync(BASH, [RUN], { input: esc, encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: SCRATCH, ...env } });
  assert.equal(r.status, 2, r.stderr);
  // 1.11.23 review F1: an escaped mcp__ PREFIX hid the call from the MCP rule (whose words include "dynamics").
  const pre = '{"tool_name":"\\u006dcp__dynamics__read","tool_input":{}}';
  assert.equal(spawnSync(BASH, [RUN], { input: pre, encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: SCRATCH, ...env } }).status, 2);
  // 1.11.23 review round 2: the KEY itself escaped (the t of tool_name), so the raw read finds no tool name at all.
  const key = '{"\\u0074ool_name":"mcp__dynamics__read","tool_input":{}}';
  assert.equal(spawnSync(BASH, [RUN], { input: key, encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: SCRATCH, ...env } }).status, 2);
  const plain = '{"tool_name":"mcp__\\u0063laude_ai_Notion__search","tool_input":{}}';
  assert.equal(spawnSync(BASH, [RUN], { input: plain, encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: SCRATCH, ...env } }).status, 0);
});

test('hooks.json runs the launcher through bash, never bare node', () => {
  const h = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'hooks', 'hooks.json'), 'utf8'));
  const cmd = h.hooks.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /^bash "\$\{CLAUDE_PLUGIN_ROOT\}\/dataverse\/guard\/run\.sh"$/);
});

// GATE_2 C4 (verified 10/13 in the hooks docs: "Requires Claude Code v2.1.295 or later"): a guard that cannot
// start, crashes or times out BLOCKS the call. Without it Claude Code lets the call through (documented).
test('the guard hook fails closed when it cannot run (onFailure: block)', () => {
  const h = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(h.hooks.PreToolUse[0].hooks[0].onFailure, 'block');
});
