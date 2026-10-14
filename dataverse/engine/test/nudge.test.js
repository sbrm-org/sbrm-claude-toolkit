'use strict';
// The toolkit nudge (1.11.9, DESIGN.md §12e): a UserPromptSubmit hook that tells the person's Claude, once,
// when this session runs an older toolkit than the one on disk, or when the automatic update has stopped
// pulling a release. Silent otherwise, silent on any failure, never blocks a prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NUDGE = path.join(__dirname, '..', '..', 'nudge', 'nudge.js');
const RUN_SH = path.join(__dirname, '..', '..', 'nudge', 'run.sh');

function layout({ running = '1.11.8', installed = '1.11.9', name = 'sbrm-toolkit' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-nudge-'));
  const pdir = path.join(base, 'plugins');
  const ver = (v, n = 'sbrm-toolkit') => {
    const d = path.join(pdir, 'cache', 'sbrm-claude-toolkit', 'sbrm-toolkit', v);
    fs.mkdirSync(path.join(d, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: n, version: v }));
    return d;
  };
  const root = ver(running, name);
  const inst = ver(installed);
  fs.writeFileSync(path.join(pdir, 'installed_plugins.json'), JSON.stringify({ plugins: { 'sbrm-toolkit@sbrm-claude-toolkit': [{ scope: 'managed', installPath: inst, version: installed }] } }));
  const home = path.join(base, 'store');
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  return { root, home };
}

function nudge(l, { session = 's1', input = null, config = null, env = {} } = {}) {
  const r = spawnSync(process.execPath, [NUDGE], {
    input: input !== null ? input : JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
    encoding: 'utf8',
    env: { ...process.env, SBRM_DV_HOME: l.home, CLAUDE_PLUGIN_ROOT: l.root, ...(config ? { SBRM_DV_CONFIG: config } : {}), ...env },
  });
  const ctx = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  return { code: r.status, ctx, stderr: r.stderr };
}

function writeState(l, st) {
  fs.writeFileSync(path.join(l.home, 'events', 'checkin.json'), JSON.stringify(st));
}

function cfgWith(o) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-cfg-'));
  fs.writeFileSync(path.join(d, 'toolkit.json'), JSON.stringify(o));
  return d;
}

test('running behind installed: the restart text, once per session, as UserPromptSubmit additionalContext', () => {
  const l = layout({ running: '1.11.8', installed: '1.11.9' });
  const off = cfgWith({ reload_plugins_applies: false });
  const a = nudge(l, { session: 's1', config: off });
  assert.equal(a.code, 0);
  assert.equal(a.ctx.hookEventName, 'UserPromptSubmit');
  assert.match(a.ctx.additionalContext, /^SBRM toolkit: this computer now has toolkit 1\.11\.9 installed, but this session is still running 1\.11\.8\./);
  assert.match(a.ctx.additionalContext, /quit Claude Code completely and reopen it/);
  assert.ok(!/reload-plugins/.test(a.ctx.additionalContext), 'with the switch off');
  assert.equal(nudge(l, { session: 's1', config: off }).ctx, null, 'once per session');
  assert.ok(nudge(l, { session: 's2', config: off }).ctx, 'a different session hears it too');
});

test('the restart text names /reload-plugins once it is measured to work (10/12: it is; the shipped switch is on)', () => {
  const l = layout({ running: '1.11.8', installed: '1.11.9' });
  assert.match(nudge(l, { config: cfgWith({ reload_plugins_applies: true }) }).ctx.additionalContext, /run \/reload-plugins, or quit Claude Code completely and reopen it/);
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'toolkit.json'), 'utf8'));
  assert.equal(shipped.reload_plugins_applies, true, 'DESIGN.md §12f measured on 10/12');
});

test('running = installed: silent, whatever the last check said, unless the update is stuck', () => {
  const l = layout({ running: '1.11.9', installed: '1.11.9' });
  assert.equal(nudge(l).ctx, null);
  writeState(l, { state: 'pending', main: { version: '1.11.10', first_seen_at: new Date().toISOString() }, observed: { installed: '1.11.9' } });
  assert.equal(nudge(l).ctx, null, 'a release out for minutes is normal');
});

test('stuck: stale (or pending 3+ days) gives the offer-to-update text once per day, with the fallback if Claude Code refuses', () => {
  const l = layout({ running: '1.11.8', installed: '1.11.8' });
  writeState(l, { state: 'stale', main: { version: '1.11.9', first_seen_at: '2026-10-13T16:00:00.000Z' }, observed: { installed: '1.11.8' } });
  const a = nudge(l, { session: 'x' });
  assert.match(a.ctx.additionalContext, /a newer version \(1\.11\.9, out since Oct 13\) has not reached this computer, which still has 1\.11\.8; the automatic update is not pulling it/);
  assert.match(a.ctx.additionalContext, /claude plugin marketplace update sbrm-claude-toolkit/);
  assert.match(a.ctx.additionalContext, /claude plugin update sbrm-toolkit@sbrm-claude-toolkit/);
  assert.match(a.ctx.additionalContext, /If they say yes, run these two commands yourself/);
  assert.match(a.ctx.additionalContext, /If Claude Code will not let you run them, give the person the two lines to type themselves, each starting with !/);
  assert.equal(nudge(l, { session: 'y' }).ctx, null, 'once per day per machine, not per session');
  const old = layout({ running: '1.11.8', installed: '1.11.8' });
  writeState(old, { state: 'pending', main: { version: '1.11.9', first_seen_at: new Date(Date.now() - 4 * 86400000).toISOString() }, observed: { installed: '1.11.8' } });
  assert.ok(nudge(old).ctx, 'pending for 4 days is stuck too');
  const moved = layout({ running: '1.11.9', installed: '1.11.9' });
  writeState(moved, { state: 'stale', main: { version: '1.11.9' }, observed: { installed: '1.11.8' } });
  assert.equal(nudge(moved).ctx, null, 'a stale verdict about an older install is not repeated once it moved');
});

test('a dev copy, bad input, missing files: silent, exit 0', () => {
  assert.equal(nudge(layout({ name: 'sbrm-toolkit-dvtest' })).ctx, null);
  const l = layout();
  const bad = nudge(l, { input: 'not json' });
  assert.equal(bad.code, 0);
  const gone = layout();
  fs.rmSync(path.join(path.dirname(path.dirname(path.dirname(path.dirname(gone.root)))), 'installed_plugins.json'));
  const r = nudge(gone);
  assert.equal(r.code, 0);
  assert.equal(r.ctx, null);
});

test('run.sh never blocks a prompt: no node means silence and exit 0', { skip: process.platform === 'win32' && !fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'no bash' : false }, () => {
  const l = layout();
  const r = spawnSync('bash', [RUN_SH], { input: '{}', encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: l.home, CLAUDE_PLUGIN_ROOT: l.root, SBRM_NUDGE_TEST_NO_NODE: '1' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const ok = spawnSync('bash', [RUN_SH], { input: JSON.stringify({ session_id: 'z' }), encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: l.home, CLAUDE_PLUGIN_ROOT: l.root } });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /"hookEventName":"UserPromptSubmit"/);
});
