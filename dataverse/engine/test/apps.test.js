'use strict';
// Which apps a machine connects to (lib/apps.js, 1.11.1): the first staff Mac got a sign-in pop-up per app
// at every start. A switched-off app's connection is a stand-in with no tools that never starts the CLI,
// and the health check signs in only to the chosen apps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-apps-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
process.env.SBRM_DV_CONFIG = path.join(HOME, 'config');
fs.mkdirSync(process.env.SBRM_DV_CONFIG, { recursive: true });
fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'), JSON.stringify({
  donorapp: { host: 'https://example.invalid', name: 'Donor App', hipaa: false },
  hgs: { host: 'https://hgs.example.invalid', name: 'HGS apps', hipaa: false },
}));

const { fakeDv } = require('./fake');
const cli = require('../dataverse-write');
const apps = require('../lib/apps');

const LAUNCH = path.join(__dirname, '..', '..', 'mcp', 'launch.js');
const quiet = (fn) => { const real = console.log; console.log = () => {}; try { return fn(); } finally { console.log = real; } };

test('apps: show, set, clear; unknown keys refused and nothing changed', () => {
  apps.clear();
  assert.equal(apps.read(), null, 'no file = every app');
  assert.equal(quiet(() => cli.runCli(['apps', 'donorapp'])), 0);
  assert.deepEqual(apps.read(), ['donorapp']);
  assert.equal(apps.opens('donorapp'), true);
  assert.equal(apps.opens('hgs'), false);
  assert.equal(quiet(() => cli.runCli(['apps', 'donorapp,nowhere'])), 2);
  assert.deepEqual(apps.read(), ['donorapp'], 'unchanged');
  assert.equal(quiet(() => cli.runCli(['apps', 'all'])), 0);
  assert.equal(apps.read(), null);
});

test('a switched-off app: the launcher answers the handshake with no tools and never starts the CLI', () => {
  apps.write(['donorapp']);
  const env = { ...process.env, SBRM_DATAVERSE_CLI: path.join(os.tmpdir(), 'no-such-dataverse.exe') };
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    '',
  ].join('\n');
  const off = spawnSync(process.execPath, [LAUNCH, 'hgs'], { input, encoding: 'utf8', env });
  assert.equal(off.status, 0, off.stderr);
  const replies = off.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(replies.length, 2, 'the notification gets no reply');
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.match(replies[0].result.instructions, /switched off on this machine/);
  assert.deepEqual(replies[1].result.tools, []);
  // A chosen app still goes to the CLI (here a missing one, so it fails fast saying so).
  const on = spawnSync(process.execPath, [LAUNCH, 'donorapp'], { input: '', encoding: 'utf8', env });
  assert.equal(on.status, 1);
  assert.match(on.stderr, /missing file/);
  apps.clear();
});

test('doctor signs in only to the chosen apps (each check is a sign-in; on a Mac, a pop-up)', () => {
  apps.write(['donorapp']);
  const hosts = [];
  const dv = fakeDv({ email: 'dgross@example.org' });
  const deps = {
    readConnection: (host) => { hosts.push(host); return dv; }, writeConnection: () => dv,
    eventConnection: () => ({ createEvent: (b) => dv.create('sbrm_dataverseevents', b) }),
    cli: () => ({ version: '1.0.81' }), io: () => ({ home: HOME, cwd: HOME, read: () => null }), guard: () => ({ present: true, blocksBypass: true, detail: 'x' }),
  };
  quiet(() => cli.runCli(['doctor'], { ...deps, authList: () => ['https://example.invalid/'] }));
  assert.ok(hosts.length > 0);
  assert.ok(!hosts.includes('https://hgs.example.invalid'), 'the switched-off app is never connected to');
  assert.match(cli.lastRun.output.join('\n'), /ok\s+Saved sign-in: Donor App/);
  // No saved sign-in for a chosen app: a FAIL with the sign-in command, even though the app answered.
  apps.write(['donorapp', 'hgs']);
  quiet(() => cli.runCli(['doctor'], { ...deps, authList: () => ['https://example.invalid/'] }));
  const out = cli.lastRun.output.join('\n');
  assert.match(out, /FAIL\s+Saved sign-in: HGS apps/);
  assert.match(out, /dataverse auth create --environment https:\/\/hgs\.example\.invalid/);
  apps.clear();
});

test('a machine that never chose its apps is not asked for saved sign-ins (Dylan\'s, unchanged)', () => {
  apps.clear();
  const dv = fakeDv({ email: 'dgross@example.org' });
  let asked = false;
  const deps = {
    readConnection: () => dv, writeConnection: () => dv, eventConnection: () => ({ createEvent: (b) => dv.create('sbrm_dataverseevents', b) }),
    cli: () => ({ version: '1.0.81' }), io: () => ({ home: HOME, cwd: HOME, read: () => null }), guard: () => ({ present: true, blocksBypass: true, detail: 'x' }),
    authList: () => { asked = true; return []; },
  };
  quiet(() => cli.runCli(['doctor'], deps));
  assert.equal(asked, false);
  assert.doesNotMatch(cli.lastRun.output.join('\n'), /Saved sign-in/);
});
