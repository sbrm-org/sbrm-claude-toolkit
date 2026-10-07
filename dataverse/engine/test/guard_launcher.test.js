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

test('with node: the real guard decides (apply blocked, plan allowed)', (t) => {
  if (!fs.existsSync(BASH)) { t.skip('no bash at ' + BASH); return; }
  assert.equal(call(bash(`node C:/x/dataverse-write.js ${V} 1`)).status, 2);
  assert.equal(call(bash('node C:/x/dataverse-write.js plan j.json')).status, 0);
  assert.equal(call(bash('ls')).status, 0);
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
