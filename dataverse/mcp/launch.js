#!/usr/bin/env node
'use strict';
// The toolkit's READ connections (DESIGN.md §5, "the toolkit ships the CONNECTION, never the
// PERMISSION"): one MCP server per app, started by the plugin as `node launch.js <env>`.
//
// It finds the Dataverse CLI on THIS machine (PATH, npm prefix, nvm; never a hard-coded path, the
// failure an nvm-versioned path showed on a staff machine, F13) and hands the MCP session to the CLI's own
// `mcp <url>` server, stdio straight through. What a person can read is decided by their Dataverse
// security role; the guard keeps every MCP tool to the known reads.
//
// It fails FAST, with the reason, instead of hanging:
//   - the CLI is missing, or ThreatLocker blocks it;
//   - nobody is signed in on this machine (10/7, setup gap 1): with no profile the CLI's server would try
//     to authenticate interactively over the MCP pipe, where nobody can answer. Profiles are UNIVERSAL
//     (one sign-in serves every app; F&E Dev answered on Dylan's donor-app profile), so the check is
//     "any profile", read from `dataverse auth list` (a fresh machine: "No authentication
//     profiles found.").

const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { resolveCli, launchError } = require('../engine/lib/cli');

// True when `auth list` output shows at least one profile row ("[1] ...").
function hasProfile(text) {
  const t = String(text || '');
  if (/No authentication profiles/i.test(t)) return false;
  return /^\s*\[\d+\]/m.test(t);
}

function fail(msg) {
  process.stderr.write(`SBRM toolkit Dataverse connection: ${msg}\n`);
  process.exit(1);
}

function main(envKey) {
  let envs;
  try {
    envs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'envs.json'), 'utf8'));
  } catch (e) {
    fail(`cannot read the toolkit's environment list: ${e.message}`);
  }
  const info = envs[envKey];
  if (!envKey || envKey.startsWith('_') || !info) fail(`unknown environment "${envKey}"; one of: ${Object.keys(envs).filter((k) => !k.startsWith('_')).join(', ')}`);

  let cli;
  try {
    cli = resolveCli();
  } catch (e) {
    fail(`${e.message} Run /dataverse-setup.`);
  }

  const auth = spawnSync(cli.binary, ['auth', 'list'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (auth.error) fail(launchError(cli.binary, auth.error).message);
  if (!hasProfile(`${auth.stdout}\n${auth.stderr}`)) {
    fail(`nobody is signed in to Dataverse on this machine. The person signs in once: dataverse auth create --environment ${info.host}   then restart Claude Code. (/dataverse-setup walks it.)`);
  }

  const child = spawn(cli.binary, ['mcp', info.host], { stdio: 'inherit', windowsHide: true });
  child.on('error', (e) => fail(launchError(cli.binary, e).message));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code === null ? 1 : code);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

if (require.main === module) main(process.argv[2]);

module.exports = { hasProfile };
