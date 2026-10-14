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
// A failed start is RECORDED in the store from 1.11.6: every spawned launcher gets a throwaway one.
const SCRATCH = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sbrmdv-mcp-'));
const run = (args, env = {}, input = '') => spawnSync(process.execPath, [LAUNCH, ...args], { input, encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: SCRATCH, ...env } });

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

// 1.11.9 (DESIGN.md §12c): the version check-in is a CHILD on unref'd timers, so it can never hold the
// launcher open, delay the connection or crash it.
function fakeTimers() {
  const made = [];
  const mk = (kind) => (fn, ms) => { const t = { kind, fn, ms, unrefd: false, unref() { this.unrefd = true; return this; } }; made.push(t); return t; };
  return { made, setTimeout: mk('timeout'), setInterval: mk('interval') };
}
function fakeSpawn() {
  const calls = [];
  const fn = (bin, args, o) => { const c = { bin, args, o, unrefd: false, handlers: {}, unref() { this.unrefd = true; }, on(ev, h) { this.handlers[ev] = h; return this; } }; calls.push(c); return c; };
  return { calls, fn };
}
const PROD_ENV = { PATH: process.env.PATH }; // no SBRM_DV_HOME: the real-machine case

test('check-in: first firing at 90 s plus jitter, then hourly; timers and child unref\'d; args name app, host, uptime, trigger', () => {
  const { scheduleCheckin } = require('../../mcp/launch');
  const tm = fakeTimers();
  const sp = fakeSpawn();
  const ok = scheduleCheckin({ app: 'donorapp', host: 'https://h' }, { ...tm, spawn: sp.fn, env: PROD_ENV, random: () => 0.5, uptime: () => 95.4, isToolkit: () => true, intervalMin: 60 });
  assert.equal(ok, true);
  assert.equal(tm.made.length, 1);
  assert.equal(tm.made[0].ms, 105000, '90 s + half of 30 s');
  assert.ok(tm.made[0].unrefd);
  tm.made[0].fn();
  assert.equal(sp.calls.length, 1);
  const c = sp.calls[0];
  assert.equal(c.bin, process.execPath);
  assert.match(c.args[0], /mcp[\\/]checkin\.js$/);
  assert.deepEqual(c.args.slice(1), ['--app', 'donorapp', '--host', 'https://h', '--uptime-ms', '95400', '--trigger', 'start']);
  assert.equal(c.o.stdio, 'ignore');
  assert.ok(c.unrefd);
  assert.equal(typeof c.handlers.error, 'function', 'a spawn error is swallowed');
  const iv = tm.made.find((t) => t.kind === 'interval');
  assert.equal(iv.ms, 3600000);
  assert.ok(iv.unrefd);
  iv.fn();
  assert.equal(sp.calls[1].args.at(-1), 'hourly');
});

test('check-in: never scheduled under a test store, from a dev copy, and a throwing spawn stays inside', () => {
  const { scheduleCheckin } = require('../../mcp/launch');
  const tm = fakeTimers();
  const sp = fakeSpawn();
  assert.equal(scheduleCheckin({ app: 'a', host: 'h' }, { ...tm, spawn: sp.fn, env: { SBRM_DV_HOME: '/tmp/x' }, isToolkit: () => true }), false);
  assert.equal(scheduleCheckin({ app: 'a', host: 'h' }, { ...tm, spawn: sp.fn, env: PROD_ENV, isToolkit: () => false }), false);
  assert.equal(tm.made.length, 0);
  const boom = () => { throw new Error('spawn failed'); };
  scheduleCheckin({ app: 'a', host: 'h' }, { ...tm, spawn: boom, env: PROD_ENV, random: () => 0, isToolkit: () => true });
  assert.doesNotThrow(() => tm.made[0].fn());
});

test('check-in: the launcher schedules it only AFTER the connection is spawned', () => {
  const src = fs.readFileSync(LAUNCH, 'utf8');
  const spawnAt = src.indexOf("spawn(cli.binary, ['mcp', info.host]");
  const schedAt = src.indexOf('scheduleCheckin({ app: envKey');
  assert.ok(spawnAt > 0 && schedAt > spawnAt, 'scheduled after the MCP child exists');
});

test('it hands the session to the CLI as `mcp <host>`, through the proxy', (t) => {
  // A stand-in "CLI": answers `auth list` with one profile row (before 1.11.10 it did not, so on a Mac this test
  // failed at the sign-in check), and as `mcp` echoes its arguments and its stdin once stdin closes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-mcp-'));
  const fake = path.join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake.sh');
  const script = path.join(dir, 'fake.js');
  fs.writeFileSync(script, "if(process.argv[2]==='auth'){console.log('[1]  UNIVERSAL  x@example.org  Public User SBRM HGS  https://sbrmhgs.crm.dynamics.com/');process.exit(0);}let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:s}));});");
  if (process.platform === 'win32') fs.writeFileSync(fake, `@"${process.execPath}" "${script}" %*\r\n`);
  else { fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); fs.chmodSync(fake, 0o755); }
  const r = spawnSync(process.execPath, [LAUNCH, 'hgs'], { input: '{"jsonrpc":"2.0","id":1,"method":"initialize"}', encoding: 'utf8', shell: false, env: { ...process.env, SBRM_DV_HOME: SCRATCH, SBRM_DATAVERSE_CLI: fake } });
  if (process.platform === 'win32' && r.status !== 0 && /EINVAL|spawn/.test(r.stderr)) {
    t.skip('a .cmd stand-in cannot be spawned without a shell on Windows; proven live instead (10/7) and on Mac');
    return;
  }
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.args, ['mcp', 'https://sbrmhgs.crm.dynamics.com']);
  assert.match(got.stdin, /"method":"initialize"/);
});
