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
const call = (input, env = {}) => spawnSync(BASH, [RUN], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
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

test('hooks.json runs the launcher through bash, never bare node', () => {
  const h = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'hooks', 'hooks.json'), 'utf8'));
  const cmd = h.hooks.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /^bash "\$\{CLAUDE_PLUGIN_ROOT\}\/dataverse\/guard\/run\.sh"$/);
});
