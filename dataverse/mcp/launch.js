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

// 1.11.6 (DESIGN.md §11, candidate 4): a connection that cannot start leaves an OPEN item for Dylan, once per
// app per machine per day (Claude Code starts every connection at every session start, so without the limit
// one unsigned machine would file one a session). Filed as the machine's (it goes to whichever app this
// machine reaches next, which may not be the one that failed); the app is named in the item. Best effort.
function recordFailure(envKey, name, msg) {
  try {
    const note = require('../engine/lib/note');
    const now = new Date();
    const app = envKey || 'unknown';
    if (note.history({ tailBytes: 512 * 1024 }).some((x) => x.reason_code === 'mcp_failed' && x.app === app && note.sameDay(x.time, now))) return;
    note.note({
      id: note.newId('M', now), time: now, kind: 'read connection failed', code: 'mcp_failed', signal: true, by: 'launcher',
      headline: `The ${name || app} read connection could not start: ${msg}`,
      detail: [`App: ${name || app} (${app})`, `What it said: ${msg}`, '', 'Later failures today on this machine are not recorded again.'].join('\n'),
      extra: { app },
    });
  } catch { /* the message below still reaches Claude Code */ }
}

function fail(msg, envKey = null, name = null) {
  recordFailure(envKey, name, msg);
  process.stderr.write(`SBRM toolkit Dataverse connection: ${msg}\n`);
  process.exit(1);
}

// An app this machine does not use (engine/lib/apps.js, 1.11.1): a stand-in MCP server that answers the
// handshake with no tools and never starts the CLI, so nothing signs in to that app at all. It still
// connects cleanly, so Claude Code shows no failed server.
function switchedOff(envKey, info) {
  let buf = '';
  const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id === undefined || m.id === null) continue; // a notification: nothing to answer
      if (m.method === 'initialize') {
        send({ jsonrpc: '2.0', id: m.id, result: {
          protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: `sbrm-dataverse-${envKey}`, version: 'off' },
          instructions: `The ${info.name} connection is switched off on this machine (not one of the apps chosen in /dataverse-setup). To use it, run /dataverse-setup again.`,
        } });
      } else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
      else if (m.method === 'ping') send({ jsonrpc: '2.0', id: m.id, result: {} });
      else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `the ${info.name} connection is switched off on this machine` } });
    }
  });
  process.stdin.on('end', () => process.exit(0));
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
  let use = true;
  try { use = require('../engine/lib/apps').opens(envKey); } catch { use = true; }
  if (!use) { switchedOff(envKey, info); return; }

  let cli;
  try {
    cli = resolveCli();
  } catch (e) {
    fail(`${e.message} Run /dataverse-setup.`, envKey, info.name);
  }

  const auth = spawnSync(cli.binary, ['auth', 'list'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (auth.error) fail(launchError(cli.binary, auth.error).message, envKey, info.name);
  if (!hasProfile(`${auth.stdout}\n${auth.stderr}`)) {
    fail(`nobody is signed in to Dataverse on this machine. The person signs in once: dataverse auth create --environment ${info.host}   then restart Claude Code. (/dataverse-setup walks it.)`, envKey, info.name);
  }

  const child = spawn(cli.binary, ['mcp', info.host], { stdio: 'inherit', windowsHide: true });
  child.on('error', (e) => fail(launchError(cli.binary, e).message, envKey, info.name));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code === null ? 1 : code);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}

if (require.main === module) main(process.argv[2]);

module.exports = { hasProfile };
