'use strict';
// Resolve the Dataverse CLI's native binary on this machine and call the Web API through it.
//
// The npm package's `bin/dataverse.js` only picks a native binary per platform and runs it
// (plus an update check that prints to stderr). We run that binary directly: no shell, so no
// quoting of OData paths, and Windows never has to spawn a `.cmd` shim (Node refuses that
// without a shell since CVE-2024-27980). Nothing machine-specific is hard-coded (DESIGN.md F7).
//
// READ-ONLY MODULE. `get()` is the only verb exported here. The write verbs live in a separate
// module that only `apply` imports, so the plan step cannot reach a POST/PATCH by construction.

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const PKG = path.join('node_modules', '@microsoft', 'dataverse');

function platformDir() {
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux';
  return `${os}-${process.arch}`;
}

function binaryIn(pkgDir) {
  const file = process.platform === 'win32' ? 'dataverse.exe' : 'dataverse';
  const p = path.join(pkgDir, 'bin', platformDir(), file);
  return fs.existsSync(p) ? p : null;
}

function packageVersion(pkgDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// Candidate package folders reachable from one PATH entry.
function candidatesFor(dir) {
  const out = [
    path.join(dir, PKG), // Windows npm prefix: %APPDATA%\npm\node_modules\...
    path.join(dir, '..', 'lib', PKG), // Unix prefix: <prefix>/bin + <prefix>/lib/node_modules
  ];
  // Mac/Linux: <prefix>/bin/dataverse is a symlink into the package (nvm, Homebrew, /usr/local)
  const link = path.join(dir, 'dataverse');
  try {
    const real = fs.realpathSync(link);
    if (real.endsWith(path.join('bin', 'dataverse.js'))) out.unshift(path.dirname(path.dirname(real)));
  } catch { /* not there */ }
  return out;
}

function resolveCli(env = process.env) {
  const override = env.SBRM_DATAVERSE_CLI;
  if (override) {
    if (!fs.existsSync(override)) throw Object.assign(new Error(`SBRM_DATAVERSE_CLI points at a missing file: ${override}`), { code: 'cli_missing' });
    return { binary: override, version: null, pkgDir: null };
  }
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const pkgDir of candidatesFor(dir)) {
      const binary = binaryIn(pkgDir);
      if (binary) return { binary, version: packageVersion(pkgDir), pkgDir: path.resolve(pkgDir) };
    }
  }
  throw Object.assign(new Error('The Dataverse CLI was not found on this machine. Run /dataverse-setup.'), { code: 'cli_missing' });
}

class DataverseError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'DataverseError';
    this.code = code || null;
    this.status = status || null;
  }
}

// The CLI binary could not be started. EPERM / EACCES on Windows is SBRM's ThreatLocker refusing an
// executable it has not approved (approval is by file hash, so EVERY new CLI version needs it: found
// 10/7 testing 1.0.81, which Git Bash could start and Node could not). Said plainly, with the fix.
function launchError(binary, err) {
  if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
    return Object.assign(new Error(
      `this computer's security software blocked the Dataverse CLI (${binary}). SBRM computers run ThreatLocker, `
      + 'which approves programs one file at a time, so a new CLI version needs approving. Use the ThreatLocker '
      + 'tray icon: Rapid Check-in first; if it is still blocked, request access for that file.',
    ), { code: 'cli_blocked' });
  }
  return new DataverseError(`could not run the Dataverse CLI: ${err.message}`);
}

// One Web API call through the CLI. Returns parsed JSON ({} for an empty body).
// Raises on an OData `error` payload: returned as data it masquerades as a record
// (writing.md, the 8/17/26 trap where a bad $select refused every row as "inactive").
// The --path handed to the CLI: never a leading "/" (Daian's Mac, 10/8: macOS CLI 1.0.81 reads "/api/..."
// as an absolute file URL and refuses every call; the slashless form works on macOS and Windows).
function cliPath(apiPath) {
  const p = String(apiPath).replace(/^\/+/, '');
  return p.startsWith('api/') ? p : 'api/data/v9.2/' + p;
}

function request(cli, host, apiPath, { method = 'GET', headers = [], bodyFile = null } = {}) {
  apiPath = cliPath(apiPath);
  const args = ['api', 'request', '--target', 'dataverse', '--environment', host,
    '--path', apiPath, '--method', method];
  for (const h of headers) args.push('--header', h);
  if (bodyFile) args.push('--body-file', bodyFile);
  const r = spawnSync(cli.binary, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) throw launchError(cli.binary, r.error);
  const txt = (r.stdout || '').trim();
  if (!txt) {
    if (r.status !== 0) throw new DataverseError(`${method} ${apiPath} failed (exit ${r.status}): ${(r.stderr || '').slice(0, 400)}`);
    return {};
  }
  let got;
  try {
    got = JSON.parse(txt);
  } catch {
    throw new DataverseError(`non-JSON response to ${method} ${apiPath}: ${txt.slice(0, 400)}`);
  }
  if (got && typeof got === 'object' && got.error && typeof got.error === 'object') {
    throw new DataverseError(`${method} ${apiPath}: ${got.error.message || JSON.stringify(got.error)}`, { code: got.error.code });
  }
  return got;
}

const FORMATTED = 'Prefer: odata.include-annotations="OData.Community.Display.V1.FormattedValue"';

// One GET without blocking (spawn, not spawnSync), parsed exactly as request() parses.
function getAsync(cli, host, apiPath) {
  apiPath = cliPath(apiPath);
  const args = ['api', 'request', '--target', 'dataverse', '--environment', host, '--path', apiPath, '--method', 'GET'];
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let p;
    try { p = spawn(cli.binary, args, { windowsHide: true }); } catch (e) { resolve({ ok: false, error: launchError(cli.binary, e) }); return; }
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ ok: false, error: launchError(cli.binary, e) }));
    p.on('close', (code) => {
      const txt = out.trim();
      if (!txt) { resolve(code === 0 ? { ok: true, value: {} } : { ok: false, error: new DataverseError(`GET ${apiPath} failed (exit ${code}): ${err.slice(0, 400)}`) }); return; }
      let got;
      try { got = JSON.parse(txt); } catch { resolve({ ok: false, error: new DataverseError(`non-JSON response to GET ${apiPath}: ${txt.slice(0, 400)}`) }); return; }
      if (got && typeof got === 'object' && got.error && typeof got.error === 'object') {
        resolve({ ok: false, error: new DataverseError(`GET ${apiPath}: ${got.error.message || JSON.stringify(got.error)}`, { code: got.error.code }) });
        return;
      }
      resolve({ ok: true, value: got });
    });
  });
}

// Many GETs, at most `concurrency` at a time; results in input order, each { ok, value } or { ok:false, error }.
// Added 10/7/26 for the merge inventory (up to ~50 relationship queries per pair).
async function getMany(cli, host, paths, concurrency = 8) {
  const results = new Array(paths.length);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const i = next++;
      results[i] = await getAsync(cli, host, paths[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return results;
}

// The read-only connection the plan step gets. GETs only.
function readConnection(host, cli = resolveCli()) {
  return {
    host,
    cliVersion: cli.version,
    get(apiPath, { formatted = false } = {}) {
      return request(cli, host, apiPath, { method: 'GET', headers: formatted ? [FORMATTED] : [] });
    },
    getMany(paths, concurrency) {
      return getMany(cli, host, paths, concurrency);
    },
  };
}

module.exports = { resolveCli, readConnection, request, getMany, cliPath, launchError, DataverseError, FORMATTED, platformDir };
