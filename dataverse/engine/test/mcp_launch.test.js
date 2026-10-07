'use strict';
// The read-connection launcher (dataverse/mcp/launch.js): bad input fails fast with the reason, and
// with a CLI that is a stand-in script it hands stdio straight through and passes `mcp <host>`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LAUNCH = path.join(__dirname, '..', '..', 'mcp', 'launch.js');
const run = (args, env = {}, input = '') => spawnSync(process.execPath, [LAUNCH, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });

test('signed in or not, read from real `auth list` output (gap 1: fail fast, never hang)', () => {
  const { hasProfile } = require('../../mcp/launch');
  assert.equal(hasProfile('No authentication profiles found.'), false, 'a fresh machine');
  assert.equal(hasProfile(''), false);
  const dylan = 'Index Active Kind      Name      User              Cloud  Type Environment       Environment Url\n'
    + '[1]          UNIVERSAL           dgross@example.org   Public User SBRM Donor App    https://sbrmdonorapp.crm.dynamics.com/\n';
  assert.equal(hasProfile(dylan), true);
  assert.equal(hasProfile(`[33m╭──╮[0m\n  Update available\n\n${dylan}`), true, 'the 1.0.34 update banner in front does not hide the rows');
});

test('an unknown environment fails fast and names the real ones', () => {
  const r = run(['nowhere']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown environment "nowhere"; one of: donorapp, hgs, recovery, soberliving, fedev/);
});

test('a missing CLI fails fast with the setup pointer (never hangs)', () => {
  const r = run(['donorapp'], { SBRM_DATAVERSE_CLI: path.join(os.tmpdir(), 'no-such-dataverse.exe') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /points at a missing file[\s\S]*Run \/dataverse-setup/);
});

test('it hands the session to the CLI as `mcp <host>`, stdio straight through', (t) => {
  // A stand-in "CLI": echoes its arguments and one line of stdin, as an MCP server would answer.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-mcp-'));
  const fake = path.join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake.sh');
  const script = path.join(dir, 'fake.js');
  fs.writeFileSync(script, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:s}));});");
  if (process.platform === 'win32') fs.writeFileSync(fake, `@"${process.execPath}" "${script}" %*\r\n`);
  else { fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); fs.chmodSync(fake, 0o755); }
  const r = spawnSync(process.execPath, [LAUNCH, 'hgs'], { input: '{"jsonrpc":"2.0","id":1,"method":"initialize"}', encoding: 'utf8', shell: false, env: { ...process.env, SBRM_DATAVERSE_CLI: fake } });
  if (process.platform === 'win32' && r.status !== 0 && /EINVAL|spawn/.test(r.stderr)) {
    t.skip('a .cmd stand-in cannot be spawned without a shell on Windows; proven live instead (10/7) and on Mac');
    return;
  }
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.args, ['mcp', 'https://sbrmhgs.crm.dynamics.com']);
  assert.match(got.stdin, /"method":"initialize"/);
});
