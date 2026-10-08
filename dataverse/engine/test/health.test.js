'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { doctor, render, scanDrift } = require('../lib/health');
const { fakeDv, ACCESS } = require('./fake');

const HOME = path.join('/home', 'alex');
const CWD = path.join(HOME, 'work');
const ENVS = {
  donorapp: { host: 'https://d.invalid', name: 'Donor App' },
  hgs: { host: 'https://h.invalid', name: 'HGS apps' },
};

function io(files = {}) {
  return { home: HOME, cwd: CWD, read: (f) => (Object.prototype.hasOwnProperty.call(files, f) ? files[f] : null) };
}

// A real staff machine's shape (from the 10/6 inventories): a local-scope donor-app MCP and an
// old bash guard, beside unrelated servers and hooks.
const STAFF = {
  [path.join(HOME, '.claude.json')]: {
    mcpServers: { 'claude-docs': { type: 'http', url: 'https://api.anthropic.com/v1/pages/mcp' } },
    projects: {
      [HOME]: { mcpServers: { 'dataverse-donorapp': { command: '/Users/alexrivera/.nvm/versions/node/v24.16.0/bin/dataverse', args: ['mcp', 'https://sbrmdonorapp.crm.dynamics.com'] } } },
    },
  },
  [path.join(HOME, '.claude', 'settings.json')]: {
    hooks: {
      PreToolUse: [
        { matcher: 'mcp__dataverse.*', hooks: [{ type: 'command', command: '~/.claude/hooks/dataverse-readonly-guard.sh' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/givebutter-check.sh' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'iterm-status done' }] }],
    },
  },
};

test('drift: finds a hand-added donor-app connection and old guard, ignores unrelated ones', () => {
  const d = scanDrift(io(STAFF));
  assert.deepEqual(d.map((x) => [x.kind, x.name.slice(0, 30)]), [
    ['connection', 'dataverse-donorapp'],
    ['hook', '~/.claude/hooks/dataverse-read'],
  ]);
  assert.equal(d[0].where, 'local scope, home folder');
  assert.match(d[1].where, /PreToolUse hook in .*settings\.json/);
});

test('drift: the toolkit\'s own connection and hook are not foreign; a .mcp.json in the start folder is checked', () => {
  const files = {
    [path.join(HOME, '.claude', 'settings.json')]: { hooks: { PreToolUse: [{ hooks: [{ command: 'node ${CLAUDE_PLUGIN_ROOT}/dataverse/guard.js' }] }] } },
    [path.join(CWD, '.mcp.json')]: { mcpServers: { hgs: { command: 'dataverse', args: ['mcp', 'https://sbrmhgs.crm.dynamics.com'] } } },
  };
  const d = scanDrift(io(files));
  assert.equal(d.length, 1);
  assert.equal(d[0].name, 'hgs');
  assert.match(d[0].where, /project scope/);
  assert.deepEqual(scanDrift(io({})), [], 'a clean machine has no drift');
});

function base(over = {}) {
  const dv = fakeDv();
  return {
    envs: ENVS,
    access: ACCESS,
    cli: () => ({ version: '1.0.34' }),
    connect: () => dv,
    io: io({}),
    pin: null,
    pending: () => ({ events: 0, logs: 0 }),
    ...over,
  };
}

test('a healthy machine passes, and the pass is the heartbeat', () => {
  const r = doctor(base());
  assert.equal(r.code, 'health_passed');
  assert.deepEqual(r.failed, []);
  assert.equal(r.person.email, 'dgross@example.org');
  assert.match(render(r), /Everything checked is working\./);
  assert.ok(r.checks.some((c) => c.label === 'Write Log: Donor App' && c.status === 'ok'));
});

test('no CLI: fails, and stops before trying to reach Dataverse', () => {
  let connected = false;
  const r = doctor(base({ cli: () => { throw new Error('The Dataverse CLI was not found on this machine.'); }, connect: () => { connected = true; } }));
  assert.equal(r.code, 'health_failed');
  assert.equal(connected, false);
  assert.match(render(r), /FAIL {2}Dataverse CLI: The Dataverse CLI was not found/);
});

test('CLI version off the pin fails', () => {
  const r = doctor(base({ pin: '1.0.81' }));
  assert.equal(r.code, 'health_failed');
  assert.match(r.failed[0].detail, /version 1\.0\.34, the toolkit expects 1\.0\.81/);
});

test('an app that does not answer is only a failure where the person is meant to write', () => {
  const dv = fakeDv({ email: 'writer@example.org' }); // write in donorapp only (fake ACCESS)
  const connect = (env) => { if (env === 'hgs') throw new Error('The user is not a member of the organization.'); return dv; };
  const r = doctor(base({ connect }));
  assert.equal(r.code, 'health_passed', 'no HGS role is normal for someone who writes only in the donor app');
  assert.equal(r.checks.find((c) => c.label === 'Signed in: HGS apps').status, 'info');
});

test('a log table that cannot be reached fails where the person writes, is only noted where they read', () => {
  const dv = fakeDv({ email: 'writer@example.org' });
  dv.tablesMissing = true;
  const r = doctor(base({ connect: () => dv }));
  assert.equal(r.code, 'health_failed');
  assert.equal(r.checks.find((c) => c.label === 'Write Log: Donor App').status, 'fail');
  assert.equal(r.checks.find((c) => c.label === 'Write Log: HGS apps').status, 'info');
});

test('--apps: an app the person said they use FAILS when it does not answer (gap 3)', () => {
  const dv = fakeDv({ email: 'writer@example.org' }); // write in donorapp only
  const connect = (env) => { if (env === 'hgs') throw new Error('The user is not a member of the organization.'); return dv; };
  assert.equal(doctor(base({ connect })).code, 'health_passed', 'without --apps an unused app is fine');
  const r = doctor(base({ connect, apps: ['donorapp', 'hgs'] }));
  assert.equal(r.code, 'health_failed');
  const c = r.failed.find((x) => x.label === 'Signed in: HGS apps');
  assert.match(c.detail, /you use the HGS apps but Dataverse did not answer/);
  assert.match(c.fix, /dataverse auth create --environment https:\/\/h\.invalid/);
});

test('signed out everywhere fails', () => {
  const r = doctor(base({ connect: () => { throw new Error('AADSTS700082: The refresh token has expired'); } }));
  assert.equal(r.code, 'health_failed');
  assert.ok(r.failed.some((c) => c.label === 'Any app'));
});

test('waiting items: sent first, then only what is still stuck counts', () => {
  let left = { events: 2, logs: 1 };
  const sent = [];
  const r = doctor(base({ pending: () => left, sendPending: (envs) => { sent.push(...envs); left = { events: 0, logs: 0 }; } }));
  assert.deepEqual(sent, ['donorapp', 'hgs']);
  assert.equal(r.code, 'health_passed');
  const stuck = doctor(base({ pending: () => ({ events: 1, logs: 0 }), sendPending: () => {} }));
  assert.equal(stuck.code, 'health_failed');
  assert.match(stuck.failed[0].detail, /0 Write Log row\(s\) and 1 event\(s\) not yet sent/);
});

test('the guard check: missing, not blocking, or hooks switched off all fail; a working guard passes', () => {
  const g = (x) => doctor(base({ guard: () => x }));
  assert.equal(g({ present: true, blocksBypass: true, hooksOff: null }).code, 'health_passed');
  assert.match(g({ present: false }).failed[0].detail, /missing from this install/);
  assert.match(g({ present: true, blocksBypass: false, detail: 'exit 0' }).failed[0].detail, /did not block a test bypass of the pop-up \(exit 0\)/);
  assert.match(g({ present: true, blocksBypass: true, hooksOff: '/h/.claude/settings.json' }).failed[0].detail, /hooks are switched off in/);
});

test('the real guard beside the engine blocks a bypass of the pop-up and lets apply through (the check doctor runs)', () => {
  const { spawnSync } = require('child_process');
  const file = path.join(__dirname, '..', '..', 'guard', 'guard.js');
  const v = ['ap', 'ply'].join('');
  const r = spawnSync(process.execPath, [file], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `node C:/x/dataverse-write.js ${v} 1` } }), encoding: 'utf8' });
  assert.equal(r.status, 0, 'apply always shows the pop-up, so the session may run it');
  const w = ['write', 'Connection'].join('');
  const bypass = spawnSync(process.execPath, [file], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `node -e "const { ${w} } = require('C:/x/lib/write')"` } }), encoding: 'utf8' });
  assert.equal(bypass.status, 2);
  const ok = spawnSync(process.execPath, [file], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'node C:/x/dataverse-write.js plan j.json' } }), encoding: 'utf8' });
  assert.equal(ok.status, 0);
});

test('every failing check names its fix (setup = run doctor, do the fixes, run it again)', () => {
  const noCli = doctor(base({ cli: () => { throw new Error('The Dataverse CLI was not found on this machine.'); } }));
  assert.match(render(noCli), /fix: npm install -g @microsoft\/dataverse@latest/);
  const pinned = doctor(base({ pin: '1.0.81' }));
  assert.match(pinned.failed[0].fix, /npm install -g @microsoft\/dataverse@1\.0\.81/);
  const blocked = doctor(base({ cli: () => { throw Object.assign(new Error('blocked'), { code: 'cli_blocked' }); } }));
  assert.match(blocked.failed[0].fix, /ThreatLocker tray icon > Rapid Check-in/);
  const out = doctor(base({ connect: () => { throw new Error('AADSTS700082'); } }));
  assert.match(out.failed.find((c) => c.label === 'Any app').fix, /dataverse auth create --environment https:\/\/d\.invalid/);
  const drift = doctor(base({ io: io(STAFF) }));
  const conn = drift.failed.find((c) => c.label === 'Extra Dataverse connection');
  assert.equal(conn.fix, `with the person's OK: claude mcp remove dataverse-donorapp --scope local   (run from ${HOME})`);
  assert.match(drift.failed.find((c) => c.label === 'Extra Dataverse hook').fix, /remove that PreToolUse hook entry from .*settings\.json \(keep everything else in the file\)/);
  const off = doctor(base({ guard: () => ({ present: true, blocksBypass: true, hooksOff: '/h/.claude/settings.json' }) }));
  assert.match(off.failed[0].fix, /set "disableAllHooks" to false/);
  assert.ok(doctor(base()).checks.every((c) => c.status !== 'fail'), 'a healthy machine has nothing to fix');
});

test('drift makes the run a drift event (signal) and is named in the output', () => {
  const r = doctor(base({ io: io(STAFF) }));
  assert.equal(r.code, 'drift');
  const out = render(r);
  assert.match(out, /FAIL {2}Extra Dataverse connection: dataverse-donorapp \(local scope, home folder\)/);
  assert.match(out, /An extra Dataverse connection or hook is on this machine/);
});
