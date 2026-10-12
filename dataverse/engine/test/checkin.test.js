'use strict';
// Version check-ins (1.11.9, DESIGN.md §12): what this machine runs, has installed and what main holds,
// recorded only when that changes, plus the lock and skip rules that keep five launchers to one check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-checkin-'));
process.env.SBRM_DV_HOME = SCRATCH;

const checkin = require('../lib/checkin');
const { cmpVersion } = require('../lib/version');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-13T16:00:00Z');

// A plugins folder shaped like Claude Code's: cache/<marketplace>/<plugin>/<version>, installed_plugins.json,
// the marketplace clone. Returns the running root and the plugins folder.
function plugins({ running = '1.11.8', installed = '1.11.9', name = 'sbrm-toolkit', fetched = '1.11.9', entry } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-plugins-'));
  const pdir = path.join(base, 'plugins');
  const ver = (v, n = 'sbrm-toolkit') => {
    const d = path.join(pdir, 'cache', 'sbrm-claude-toolkit', 'sbrm-toolkit', v);
    fs.mkdirSync(path.join(d, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(d, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: n, version: v }));
    return d;
  };
  const root = ver(running, name);
  const instPath = installed ? ver(installed) : null;
  if (entry !== null) {
    const e = entry || { 'sbrm-toolkit@sbrm-claude-toolkit': [
      { scope: 'user', installPath: root, version: running },
      { scope: 'managed', installPath: instPath, version: installed, gitCommitSha: 'abc123', lastUpdated: '2026-10-13T16:05:00Z' },
    ] };
    fs.writeFileSync(path.join(pdir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: e }));
  }
  if (fetched) {
    const m = path.join(pdir, 'marketplaces', 'sbrm-claude-toolkit', '.claude-plugin');
    fs.mkdirSync(m, { recursive: true });
    fs.writeFileSync(path.join(m, 'plugin.json'), JSON.stringify({ name: 'sbrm-toolkit', version: fetched }));
  }
  return { root, pdir };
}

function freshStore() {
  fs.rmSync(path.join(SCRATCH, 'events'), { recursive: true, force: true });
}

function fakeConn() {
  const sent = [];
  return { sent, conn: { createEvent(body) { sent.push(body); return {}; } } };
}

function opts(over = {}) {
  const { root } = over.layout || plugins();
  const fc = fakeConn();
  return {
    fc,
    o: {
      root, app: 'donorapp', host: 'https://example.crm.dynamics.com', uptimeMs: 2 * MIN, trigger: 'start', now: T0,
      fetchMain: async () => ({ version: '1.11.9' }),
      claudeVersion: () => '2.1.0 (Claude Code)',
      connection: () => fc.conn,
      ...over.o,
    },
  };
}

const checkins = () => checkin.history().filter((e) => e.reason_code === 'checkin');

test('version order is numeric, not text', () => {
  assert.equal(cmpVersion('1.11.10', '1.11.9'), 1);
  assert.equal(cmpVersion('1.11.9', '1.11.9'), 0);
  assert.equal(cmpVersion('1.9', '1.11.0'), -1);
});

test('1. running comes from the plugin folder; no plugin.json = unknown; another name = a dev copy', () => {
  const { root } = plugins({ running: '1.11.8' });
  assert.deepEqual(checkin.readPlugin(root), { name: 'sbrm-toolkit', version: '1.11.8' });
  assert.equal(checkin.readPlugin(fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))).version, 'unknown');
  assert.equal(checkin.readPlugin(plugins({ name: 'sbrm-toolkit-dvtest' }).root).name, 'sbrm-toolkit-dvtest');
});

test('2. installed: the managed entry, its version read from the folder on disk; missing pieces give unknown with a reason', () => {
  const { root, pdir } = plugins({ running: '1.11.8', installed: '1.11.9' });
  assert.equal(checkin.pluginsDir(root), pdir);
  const i = checkin.readInstalled(pdir);
  assert.equal(i.version, '1.11.9');
  assert.equal(i.scope, 'managed');
  assert.equal(i.sha, 'abc123');
  // the folder's plugin.json beats the entry's own version field
  const lying = plugins({ installed: '1.11.9', entry: { 'sbrm-toolkit@sbrm-claude-toolkit': [{ scope: 'managed', installPath: null, version: '1.11.7' }] } });
  assert.equal(checkin.readInstalled(lying.pdir).version, '1.11.7', 'no folder: falls back to the entry');
  const none = plugins({ entry: null });
  assert.equal(checkin.readInstalled(none.pdir).version, 'unknown');
  assert.match(checkin.readInstalled(none.pdir).reason, /installed_plugins\.json/);
  const other = plugins({ entry: { 'someone-else@x': [] } });
  assert.match(checkin.readInstalled(other.pdir).reason, /no sbrm-toolkit entry/);
  fs.writeFileSync(path.join(other.pdir, 'installed_plugins.json'), '{not json');
  assert.equal(checkin.readInstalled(other.pdir).version, 'unknown');
});

test('3. fetchMain reads the version from a local server; a 404, a hang and a refused port each give an error, never a throw', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.end(JSON.stringify({ name: 'sbrm-toolkit', version: '1.11.9' })); return; }
    if (req.url === '/hang') return; // never answers
    res.statusCode = 404; res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await checkin.fetchMain(`${base}/ok`), { version: '1.11.9' });
    assert.match((await checkin.fetchMain(`${base}/missing`)).error, /404/);
    assert.match((await checkin.fetchMain(`${base}/hang`, 300)).error, /timed out/);
  } finally { server.close(); }
  assert.ok((await checkin.fetchMain('http://127.0.0.1:1/x', 1000)).error);
});

test('4. the state table, including main unknown = equal and both grace conditions', () => {
  const base = { running: '1.11.9', installed: '1.11.9', main: '1.11.9', uptimeMin: 120, installedForMin: 120, graceMin: 60 };
  const st = (over) => checkin.computeState({ ...base, ...over });
  assert.equal(st({}), 'current');
  assert.equal(st({ running: 'unknown' }), 'unknown');
  assert.equal(st({ installed: 'unknown' }), 'unknown');
  assert.equal(st({ running: '1.11.8' }), 'restart-needed');
  assert.equal(st({ running: '1.11.8', installed: '1.11.8', main: '1.11.9' }), 'stale');
  assert.equal(st({ running: '1.11.8', installed: '1.11.8', main: '1.11.9', uptimeMin: 30 }), 'pending', 'a short session is not proof');
  assert.equal(st({ running: '1.11.8', installed: '1.11.8', main: '1.11.9', installedForMin: 5 }), 'pending', 'installed just moved');
  assert.equal(st({ running: '1.11.8', installed: '1.11.8', main: 'unknown' }), 'current', 'main unknown compares as equal');
  assert.equal(st({ running: '1.11.10', installed: '1.11.10', main: '1.11.9' }), 'current', 'numeric order');
});

test('5. a check records one event when the key changes, nothing when it does not', async () => {
  freshStore();
  const { o } = opts();
  const r1 = await checkin.runCheck(o);
  assert.equal(r1.recorded, true);
  assert.equal(r1.state, 'restart-needed');
  const evs = checkins();
  assert.equal(evs.length, 1);
  const e = evs[0];
  assert.equal(e.kind, 'version check-in');
  assert.equal(e.signal, false);
  assert.equal(e.env, 'machine');
  assert.equal(e.headline, 'Toolkit 1.11.8 running, 1.11.9 installed: restart needed');
  assert.match(e.detail, /^running: 1\.11\.8\ninstalled: 1\.11\.9\nmain: 1\.11\.9\nstate: restart-needed\ninstalled_since: \S+\nmain_fetched_at: \S+\nsession_uptime_min: 2\n/);
  assert.match(e.detail, /trigger: start/);
  assert.match(e.detail, /Claude Code: 2\.1\.0/);
  assert.match(e.detail, /scope: managed/);
  assert.match(e.detail, /commit: abc123/);
  assert.match(e.detail, /marketplace clone: 1\.11\.9/);
  // same triple an hour later: no new row
  const r2 = await checkin.runCheck({ ...o, trigger: 'hourly', now: T0 + 61 * MIN, uptimeMs: 63 * MIN });
  assert.equal(r2.recorded, false);
  assert.equal(checkins().length, 1);
});

test('5b. each part of the key alone makes a row: main moving is one row, then installed, then running', async () => {
  freshStore();
  const layout = plugins({ running: '1.11.8', installed: '1.11.8' });
  const { o } = opts({ layout, o: { fetchMain: async () => ({ version: '1.11.8' }) } });
  await checkin.runCheck(o);
  assert.equal(checkins().at(-1).headline, 'Toolkit 1.11.8: current');
  await checkin.runCheck({ ...o, trigger: 'hourly', now: T0 + 61 * MIN, uptimeMs: 3 * MIN, fetchMain: async () => ({ version: '1.11.9' }) });
  assert.equal(checkins().length, 2, 'main moved');
  assert.equal(checkins().at(-1).headline, 'Toolkit 1.11.8 installed, 1.11.9 on main: not pulled yet');
  // a second release while still pending: the state stays "pending", main alone moved, and that is a row
  await checkin.runCheck({ ...o, trigger: 'hourly', now: T0 + 122 * MIN, uptimeMs: 3 * MIN, fetchMain: async () => ({ version: '1.11.10' }) });
  assert.equal(checkins().length, 3, 'main is part of the key');
  assert.equal(checkins().at(-1).headline, 'Toolkit 1.11.8 installed, 1.11.10 on main: not pulled yet');
});

test('5c. stale: installed has not moved for the grace window of a session that ran that long', async () => {
  freshStore();
  const layout = plugins({ running: '1.11.8', installed: '1.11.8' });
  const { o } = opts({ layout });
  await checkin.runCheck({ ...o, uptimeMs: 2 * MIN });
  assert.equal(checkins().at(-1).headline, 'Toolkit 1.11.8 installed, 1.11.9 on main: not pulled yet');
  await checkin.runCheck({ ...o, trigger: 'hourly', now: T0 + 62 * MIN, uptimeMs: 64 * MIN });
  assert.equal(checkins().at(-1).headline, 'Toolkit 1.11.8 installed, 1.11.9 on main for 1h+ of a session: auto-update not pulling');
  assert.match(checkins().at(-1).detail, /state: stale/);
});

test('6. the lock: a fresh lock means another check is running; a lock older than 10 minutes is broken', async () => {
  freshStore();
  const lock = path.join(checkin.eventsDir(), 'checkin.lock');
  fs.writeFileSync(lock, `4242 ${new Date(T0 - MIN).toISOString()}`);
  const { o } = opts();
  assert.equal((await checkin.runCheck(o)).skipped, 'locked');
  assert.equal(checkins().length, 0);
  fs.writeFileSync(lock, `4242 ${new Date(T0 - 11 * MIN).toISOString()}`);
  assert.equal((await checkin.runCheck(o)).recorded, true, 'a crashed check\'s lock is cleared');
  assert.ok(!fs.existsSync(lock), 'released after the check');
});

test('6b. two checks started together: one records', async () => {
  freshStore();
  const { o } = opts();
  const [a, b] = await Promise.all([checkin.runCheck(o), checkin.runCheck(o)]);
  assert.equal([a, b].filter((r) => r.recorded).length, 1);
  assert.equal(checkins().length, 1);
});

test('7. skip rules: hourly within 50 minutes of a check skips before reading anything; start skips only a same-version check under 10 minutes', async () => {
  freshStore();
  let fetches = 0;
  const { o } = opts({ o: { fetchMain: async () => { fetches += 1; return { version: '1.11.9' }; } } });
  await checkin.runCheck(o);
  assert.equal(fetches, 1);
  assert.equal((await checkin.runCheck({ ...o, trigger: 'hourly', now: T0 + 20 * MIN })).skipped, 'checked recently');
  assert.equal((await checkin.runCheck({ ...o, trigger: 'start', now: T0 + 5 * MIN })).skipped, 'checked recently', 'the other launchers of the same start');
  const r = await checkin.runCheck({ ...o, trigger: 'start', now: T0 + 15 * MIN });
  assert.equal(r.skipped, undefined, 'a new session after 10 minutes checks');
  assert.equal(fetches, 1, 'main fetched within 50 minutes is reused');
  const restarted = { ...o, root: plugins({ running: '1.11.9', installed: '1.11.9' }).root, trigger: 'start', now: T0 + 16 * MIN };
  const r2 = await checkin.runCheck(restarted);
  assert.equal(r2.skipped, undefined, 'a start on a NEW running version never skips');
  assert.equal(r2.state, 'current');
});

test('8. send: pending events for the app and the machine go out, even with no new row; a failed send leaves them', async () => {
  freshStore();
  const { o, fc } = opts();
  await checkin.runCheck(o);
  assert.equal(fc.sent.length, 1);
  assert.equal(fc.sent[0].sbrm_kind, 'version check-in');
  assert.equal(fc.sent[0].sbrm_reasoncode, 'checkin');
  assert.equal(fc.sent[0].sbrm_status, null, 'never opens an item');
  // something else waiting (a failed read connection, say) goes out on the next check with no key change
  require('../lib/note').note({ id: 'M-x', kind: 'read connection failed', code: 'mcp_failed', signal: true, by: 'launcher', headline: 'x' });
  await checkin.runCheck({ ...o, trigger: 'hourly', now: T0 + 61 * MIN, uptimeMs: 3 * MIN });
  assert.equal(fc.sent.length, 2);
  require('../lib/note').note({ id: 'M-y', kind: 'read connection failed', code: 'mcp_failed', signal: true, by: 'launcher', headline: 'y' });
  const bad = { createEvent() { throw new Error('offline'); } };
  await checkin.runCheck({ ...o, trigger: 'hourly', now: T0 + 122 * MIN, uptimeMs: 3 * MIN, connection: () => bad });
  assert.ok(fs.readdirSync(path.join(checkin.eventsDir(), 'pending')).some((f) => f.includes('M-y')), 'kept for the next check');
});

test('9. offline: main keeps its last fetched value; never fetched = unknown, and that is not an error state', async () => {
  freshStore();
  const layout = plugins({ running: '1.11.9', installed: '1.11.9' });
  const { o } = opts({ layout, o: { fetchMain: async () => ({ error: 'getaddrinfo ENOTFOUND' }) } });
  const r = await checkin.runCheck(o);
  assert.equal(r.state, 'current');
  assert.match(checkins().at(-1).detail, /main: unknown/);
  assert.match(checkins().at(-1).detail, /main fetch: getaddrinfo ENOTFOUND/);
});

test('10. a dev copy never checks in', async () => {
  freshStore();
  const { o } = opts({ layout: plugins({ name: 'sbrm-toolkit-dvtest' }) });
  assert.equal((await checkin.runCheck(o)).skipped, 'not the managed toolkit');
  assert.equal(checkins().length, 0);
});

test('12. status() for the health check: fresh running/installed, cached main reused, the last stale verdict kept while nothing moved', async () => {
  freshStore();
  const layout = plugins({ running: '1.11.8', installed: '1.11.8' });
  const { o } = opts({ layout });
  await checkin.runCheck({ ...o, uptimeMs: 2 * MIN });
  await checkin.runCheck({ ...o, trigger: 'hourly', now: T0 + 62 * MIN, uptimeMs: 64 * MIN });
  let fetched = 0;
  const s = checkin.status({ root: layout.root, now: T0 + 70 * MIN, fetchSync: () => { fetched += 1; return { version: '1.11.9' }; } });
  assert.deepEqual(s, { running: '1.11.8', installed: '1.11.8', main: '1.11.9', state: 'stale' });
  assert.equal(fetched, 0, 'main under 50 minutes old is reused');
  const later = checkin.status({ root: layout.root, now: T0 + 200 * MIN, fetchSync: () => { fetched += 1; return { version: '1.11.9' }; } });
  assert.equal(fetched, 1);
  assert.equal(later.state, 'stale');
  const restart = checkin.status({ root: plugins({ running: '1.11.8', installed: '1.11.9' }).root, now: T0 + 70 * MIN, fetchSync: () => ({ version: '1.11.9' }) });
  assert.equal(restart.state, 'restart-needed');
});

test('11. nothing in a check throws: a broken installed file, a throwing fetch and a throwing connection still end cleanly', async () => {
  freshStore();
  const layout = plugins({ entry: null });
  const { o } = opts({ layout, o: { fetchMain: async () => { throw new Error('boom'); }, connection: () => { throw new Error('no cli'); }, claudeVersion: () => { throw new Error('x'); } } });
  const r = await checkin.runCheck(o);
  assert.equal(r.state, 'unknown');
  assert.equal(checkins().at(-1).headline, 'Toolkit 1.11.8 running; install record missing');
});
