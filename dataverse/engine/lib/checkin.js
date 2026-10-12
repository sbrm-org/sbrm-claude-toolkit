'use strict';
// Version check-ins (1.11.9, DESIGN.md §12). Claude Code updates a plugin in the background, once per session
// start, and fails quietly; the running session keeps what it loaded. Nothing told us on 10/12 that nobody had
// 1.11.8 three days after it shipped. So each machine reports three versions:
//   RUNNING   the plugin folder this session loaded (this code's own plugin.json);
//   INSTALLED what is on disk now (installed_plugins.json), which the background update moves;
//   MAIN      the plugin.json on the repo's main branch (one unauthenticated GET; the repo is public).
// A row goes to the event table only when (running, installed, main, state) CHANGES (Dylan, 10/12: a
// first-of-day record would always read behind after a release, because the update lands after the first
// start). The read-connection launcher runs this in a child process (mcp/checkin.js) 90 s after start and
// hourly; a lock and two skip rules keep five launchers and many sessions to about one check an hour.
//
// Nothing here throws to its caller, prompts or prints: it is plugin plumbing beside the read connection.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const store = require('./store');
const { isVersion, cmpVersion } = require('./version');

const PLUGIN_NAME = 'sbrm-toolkit';
const PLUGIN_KEY = 'sbrm-toolkit@sbrm-claude-toolkit';
const MARKETPLACE = 'sbrm-claude-toolkit';
const MIN = 60 * 1000;

const DEFAULTS = {
  release_url: 'https://raw.githubusercontent.com/sbrm-org/sbrm-claude-toolkit/main/.claude-plugin/plugin.json',
  checkin_grace_min: 60, // stale = installed behind main for this long, in a session that ran this long
  checkin_interval_min: 60, // how often a launcher re-checks
  checkin_pending_days: 3, // the review warns when a release is this old and still not installed
  checkin_machine_days: 14, // a machine silent this long drops out of grading
  reload_plugins_applies: false, // DESIGN.md §12f: true once /reload-plugins is measured to load an update
};
const MAIN_FRESH_MIN = 50; // a main fetched this recently is reused
const HOURLY_SKIP_MIN = 50; // an hourly check this soon after any check does nothing
const START_SKIP_MIN = 10; // a start check this soon after a check on the same running version does nothing
const LOCK_STALE_MIN = 10;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// toolkit.json (the engine's config folder, or the folder a test points SBRM_DV_CONFIG at), over the defaults.
function settings(env = process.env) {
  const dir = env.SBRM_DV_CONFIG || path.join(__dirname, '..', '..');
  let got = {};
  try { got = readJson(path.join(dir, 'toolkit.json')); } catch { /* defaults */ }
  return { ...DEFAULTS, ...got };
}

// The plugin folder this code runs from: CLAUDE_PLUGIN_ROOT when it holds a plugin.json, else three up.
function defaultRoot(env = process.env) {
  const r = env.CLAUDE_PLUGIN_ROOT;
  if (r && fs.existsSync(path.join(r, '.claude-plugin', 'plugin.json'))) return r;
  return path.join(__dirname, '..', '..', '..');
}

function readPlugin(root) {
  try {
    const p = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
    return { name: p.name || null, version: isVersion(p.version) ? p.version : 'unknown' };
  } catch {
    return { name: null, version: 'unknown' };
  }
}

// Claude Code's plugins folder: four up from a root in plugins/cache/<marketplace>/<plugin>/<version>, else
// CLAUDE_CONFIG_DIR/plugins, else ~/.claude/plugins.
function pluginsDir(root, env = process.env) {
  const parts = path.resolve(root).split(/[\\/]/);
  if (parts.length >= 5 && parts[parts.length - 4] === 'cache' && parts[parts.length - 5] === 'plugins') {
    return path.resolve(root, '..', '..', '..', '..');
  }
  if (env.CLAUDE_CONFIG_DIR) return path.join(env.CLAUDE_CONFIG_DIR, 'plugins');
  return path.join(store.accountHome ? store.accountHome() : os.homedir(), '.claude', 'plugins');
}

// What is installed on disk: the managed entry (else the first), its version read from the folder it names.
function readInstalled(pdir) {
  const file = path.join(pdir, 'installed_plugins.json');
  let j;
  try { j = readJson(file); } catch (e) {
    return { version: 'unknown', reason: `installed_plugins.json not readable (${e.code || e.message})` };
  }
  const list = j && j.plugins && j.plugins[PLUGIN_KEY];
  if (!Array.isArray(list) || !list.length) return { version: 'unknown', reason: `no ${PLUGIN_KEY.split('@')[0]} entry in installed_plugins.json` };
  const e = list.find((x) => x && x.scope === 'managed') || list[0];
  let version = null;
  if (e.installPath) version = readPlugin(e.installPath).version;
  if (!isVersion(version)) version = isVersion(e.version) ? e.version : 'unknown';
  return { version, scope: e.scope || null, sha: e.gitCommitSha || null, lastUpdated: e.lastUpdated || null, path: e.installPath || null, reason: version === 'unknown' ? 'the entry names no readable version' : null };
}

// What the marketplace refresh last pulled (detail only: tells WHICH half of an update failed).
function readFetched(pdir) {
  return readPlugin(path.join(pdir, 'marketplaces', MARKETPLACE)).version;
}

// One GET of main's plugin.json. Resolves { version } or { error }; never rejects.
function fetchMain(url, timeoutMs = 5000, runningVersion = 'unknown') {
  return new Promise((resolve) => {
    let done = false;
    const end = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { end({ error: `timed out after ${timeoutMs} ms` }); try { req.destroy(); } catch { /* gone */ } }, timeoutMs);
    let req;
    try {
      const lib = String(url).startsWith('http:') ? http : https;
      req = lib.get(url, { headers: { 'User-Agent': `sbrm-toolkit-checkin/${runningVersion}`, 'Cache-Control': 'no-cache' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 65536) res.destroy(); });
        res.on('end', () => {
          if (res.statusCode !== 200) { end({ error: `HTTP ${res.statusCode}` }); return; }
          try {
            const v = JSON.parse(body.replace(/^﻿/, '')).version;
            end(isVersion(v) ? { version: v } : { error: 'no version in the answer' });
          } catch { end({ error: 'the answer was not JSON' }); }
        });
        res.on('error', (e) => end({ error: e.message }));
      });
      req.on('error', (e) => end({ error: e.message }));
    } catch (e) {
      end({ error: e.message });
    }
  });
}

// The same GET for a synchronous caller (the review): a child node process runs fetchMain.
function fetchMainSync(url, timeoutMs = 5000) {
  try {
    const r = spawnSync(process.execPath, [__filename, '--fetch-main', url, String(timeoutMs)], { encoding: 'utf8', timeout: timeoutMs + 3000, windowsHide: true });
    return JSON.parse(String(r.stdout || '').trim() || '{"error":"no answer"}');
  } catch (e) {
    return { error: e.message };
  }
}

// One of: current, restart-needed, pending, stale, unknown (DESIGN.md §12c step 4).
function computeState({ running, installed, main, uptimeMin, installedForMin, graceMin }) {
  if (!isVersion(running) || !isVersion(installed)) return 'unknown';
  if (cmpVersion(running, installed) < 0) return 'restart-needed';
  const m = isVersion(main) ? main : installed;
  if (cmpVersion(installed, m) < 0) {
    return uptimeMin >= graceMin && installedForMin >= graceMin ? 'stale' : 'pending';
  }
  return 'current';
}

function headline({ running, installed, main, state }) {
  switch (state) {
    case 'current': return `Toolkit ${running}: current`;
    case 'restart-needed': return `Toolkit ${running} running, ${installed} installed: restart needed`;
    case 'pending': return `Toolkit ${installed} installed, ${main} on main: not pulled yet`;
    case 'stale': return `Toolkit ${installed} installed, ${main} on main for 1h+ of a session: auto-update not pulling`;
    default: return `Toolkit ${running} running; install record missing`;
  }
}

function eventsDir() {
  return store.dir('events');
}

function stateFile() {
  return path.join(eventsDir(), 'checkin.json');
}

function readState() {
  try { return readJson(stateFile()); } catch { return {}; }
}

function writeState(s) {
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8');
  fs.renameSync(tmp, stateFile());
}

// An exclusive create: the five launchers' checks race here and one wins. A lock older than ten minutes is a
// check that crashed: cleared, and taken once more.
function takeLock(now) {
  const file = path.join(eventsDir(), 'checkin.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, `${process.pid} ${new Date(now).toISOString()}`);
      fs.closeSync(fd);
      return () => { try { fs.rmSync(file, { force: true }); } catch { /* next check clears it */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      try {
        // Aged by the time written inside it (the same clock as `now`), else by the file's own time.
        const m = /\s(\S+)$/.exec(fs.readFileSync(file, 'utf8'));
        const t = m && !Number.isNaN(Date.parse(m[1])) ? Date.parse(m[1]) : fs.statSync(file).mtimeMs;
        if (now - t > LOCK_STALE_MIN * MIN) { fs.rmSync(file, { force: true }); continue; }
      } catch { continue; }
      return null;
    }
  }
  return null;
}

function claudeCodeVersion() {
  for (const bin of ['claude', path.join(os.homedir(), '.local', 'bin', 'claude')]) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      const v = String(r.stdout || '').trim();
      if (!r.error && v) return v.split('\n')[0];
    } catch { /* next */ }
  }
  return null;
}

const iso = (ms) => new Date(ms).toISOString();

// One check. Every argument is injectable for tests; the real ones come from mcp/checkin.js.
async function runCheck({
  root = defaultRoot(), app = null, host = null, uptimeMs = 0, trigger = 'start', now = Date.now(),
  fetchMain: fetcher = null, claudeVersion = claudeCodeVersion, connection = null, env = process.env,
} = {}) {
  const info = readPlugin(root);
  if (info.name !== PLUGIN_NAME) return { skipped: 'not the managed toolkit' };
  const cfg = settings(env);
  const release = takeLock(now);
  if (!release) return { skipped: 'locked' };
  try {
    const st = readState();
    const since = st.checked_at ? now - Date.parse(st.checked_at) : Infinity;
    const sameRunning = st.observed && st.observed.running === info.version;
    if ((trigger === 'hourly' && since < HOURLY_SKIP_MIN * MIN) || (trigger !== 'hourly' && sameRunning && since < START_SKIP_MIN * MIN)) {
      return { skipped: 'checked recently' };
    }
    const notes = [];
    const pdir = pluginsDir(root, env);
    const inst = readInstalled(pdir);
    let fetched = null;
    try { fetched = readFetched(pdir); } catch { /* detail only */ }

    // main: reuse a fetch under 50 minutes old; a failed fetch keeps the last value it had.
    const prev = st.main || {};
    let main = { ...prev };
    if (!prev.fetched_at || now - Date.parse(prev.fetched_at) >= MAIN_FRESH_MIN * MIN || !isVersion(prev.version)) {
      let got;
      try { got = await (fetcher || ((u) => fetchMain(u, 5000, info.version)))(cfg.release_url); } catch (e) { got = { error: e.message }; }
      if (got && isVersion(got.version)) {
        main = { version: got.version, fetched_at: iso(now), error: null, first_seen_at: prev.version === got.version && prev.first_seen_at ? prev.first_seen_at : iso(now) };
      } else {
        main = { ...prev, error: (got && got.error) || 'no version' };
      }
    }
    if (main.error) notes.push(`main fetch: ${main.error}`);
    const mainV = isVersion(main.version) ? main.version : 'unknown';

    const observed = st.observed || {};
    const installedSince = observed.installed === inst.version && observed.installed_since ? observed.installed_since : iso(now);
    const uptimeMin = Math.floor(uptimeMs / MIN);
    const state = computeState({
      running: info.version, installed: inst.version, main: mainV, uptimeMin,
      installedForMin: (now - Date.parse(installedSince)) / MIN, graceMin: cfg.checkin_grace_min,
    });
    let cc = null;
    try { cc = claudeVersion(); } catch { /* best effort */ }

    const key = `${info.version}|${inst.version}|${mainV}|${state}`;
    let recorded = false;
    if (!st.last_sent || st.last_sent.key !== key) {
      const note = require('./note');
      const id = note.newId('V', new Date(now));
      const detail = [
        `running: ${info.version}`, `installed: ${inst.version}`, `main: ${mainV}`, `state: ${state}`,
        `installed_since: ${installedSince}`, `main_fetched_at: ${main.fetched_at || 'never'}`, `session_uptime_min: ${uptimeMin}`,
        '',
        `trigger: ${trigger}${app ? ` (${app} connection)` : ''}`,
        `install path: ${inst.path || '(none)'}`, `scope: ${inst.scope || '(none)'}`, `commit: ${inst.sha || '(none)'}`, `last updated: ${inst.lastUpdated || '(none)'}`,
        `marketplace clone: ${fetched || '(none)'}`,
        `Claude Code: ${cc || 'unknown'}`,
        ...(inst.reason ? [`install record: ${inst.reason}`] : []),
        ...notes,
      ].join('\n');
      note.note({
        id, time: new Date(now), kind: 'version check-in', code: 'checkin', signal: false, by: 'launcher',
        headline: headline({ running: info.version, installed: inst.version, main: mainV, state }), detail,
        extra: { checkin: { running: info.version, installed: inst.version, main: mainV, state } },
      });
      st.last_sent = { key, at: iso(now), event_id: id };
      recorded = true;
    }
    st.observed = { running: info.version, installed: inst.version, installed_since: installedSince };
    st.main = main;
    st.state = state;
    st.checked_at = iso(now);
    st.claude_code = cc;
    writeState(st);

    // Send what is waiting for this app (and the machine) through the connection the launcher proved. For a
    // person who only reads, this is the only thing that ever sends their events.
    let sent = null;
    if (host && app) {
      try {
        const conn = connection ? connection(host) : require('./events').eventConnection(host, undefined, { timeoutMs: 60000 });
        sent = require('./events').flush(conn, app);
      } catch (e) { sent = { error: e.message }; }
    }
    return { recorded, state, key, sent };
  } catch (e) {
    return { error: e.message };
  } finally {
    release();
  }
}

// The versions right now, for the health check: running and installed read fresh; main from the last check's
// fetch when it is under 50 minutes old, else fetched now (synchronously). The state's stale rule needs a
// session's uptime, which the health check does not have, so it reuses the last check's stale verdict when
// the versions still match it. Records nothing.
function status({ root = defaultRoot(), env = process.env, now = Date.now(), fetchSync = fetchMainSync } = {}) {
  const info = readPlugin(root);
  const inst = readInstalled(pluginsDir(root, env));
  const st = readState();
  let mainV = st.main && isVersion(st.main.version) ? st.main.version : 'unknown';
  if (!st.main || !st.main.fetched_at || now - Date.parse(st.main.fetched_at) >= MAIN_FRESH_MIN * MIN) {
    const got = fetchSync(settings(env).release_url);
    if (got && isVersion(got.version)) mainV = got.version;
  }
  let state = computeState({ running: info.version, installed: inst.version, main: mainV, uptimeMin: 0, installedForMin: 0, graceMin: 1 });
  if (state === 'pending' && st.state === 'stale' && st.observed && st.observed.installed === inst.version) state = 'stale';
  return { running: info.version, installed: inst.version, main: mainV, state };
}

// This machine's events, oldest first (note.history's reader).
function history() {
  return require('./note').history();
}

if (require.main === module && process.argv[2] === '--fetch-main') {
  fetchMain(process.argv[3], Number(process.argv[4]) || 5000).then((r) => process.stdout.write(JSON.stringify(r)));
}

module.exports = {
  DEFAULTS, PLUGIN_NAME, settings, defaultRoot, readPlugin, pluginsDir, readInstalled, readFetched,
  fetchMain, fetchMainSync, computeState, headline, runCheck, readState, eventsDir, history, status,
};
