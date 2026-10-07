'use strict';
// doctor: the health check for one machine (DESIGN.md §7 D4, D4a). Answers "is the Dataverse setup on
// this computer working right now?" without writing any data. Every check returns
//   { label, status: 'ok' | 'fail' | 'info', detail }
// and the run is recorded as one event: health_passed, health_failed, or drift (signal) when a foreign
// Dataverse connection or hook is found. A pass is the heartbeat the review reads.
//
// Inputs are injected (connections, the CLI, the files) so every check is tested without a real
// machine; dataverse-write.js wires the real ones.

const path = require('path');
const { whoAmI, accessFor } = require('./resolve');
const { resolveAccess } = require('./access');

const DATAVERSE = /dataverse|crm\.dynamics\.com/i;
// Anything the toolkit plugin itself ships carries one of these; everything else is foreign (D4a).
const TOOLKIT_MARKERS = [/sbrm-claude-toolkit/i, /CLAUDE_PLUGIN_ROOT/];

function isToolkit(text) {
  return TOOLKIT_MARKERS.some((re) => re.test(text));
}

// ---- D4a drift: one definition of "foreign", shared with /dataverse-setup step 6 ----

// io = { home, cwd, read(file) -> parsed JSON or null }
function scanDrift(io) {
  const found = [];
  // `scope` and `project` say how to remove it: `claude mcp remove <name> --scope <scope>`, run from
  // `project` for local and project scope (the scope belongs to that folder).
  const servers = (obj, where, scope, project = null) => {
    for (const [name, cfg] of Object.entries((obj && obj.mcpServers) || {})) {
      const text = `${name} ${JSON.stringify(cfg)}`;
      if (DATAVERSE.test(text) && !isToolkit(text)) found.push({ kind: 'connection', name, where, scope, project });
    }
  };
  const claudeJson = io.read(path.join(io.home, '.claude.json'));
  if (claudeJson) {
    servers(claudeJson, 'user scope (~/.claude.json)', 'user');
    for (const [proj, cfg] of Object.entries(claudeJson.projects || {})) {
      servers(cfg, `local scope, ${proj === io.home ? 'home folder' : proj}`, 'local', proj);
    }
  }
  for (const dirName of [...new Set([io.home, io.cwd])]) {
    servers(io.read(path.join(dirName, '.mcp.json')), `project scope, ${path.join(dirName, '.mcp.json')}`, 'project', dirName);
  }
  const settingsFiles = [
    path.join(io.home, '.claude', 'settings.json'), path.join(io.home, '.claude', 'settings.local.json'),
    path.join(io.cwd, '.claude', 'settings.json'), path.join(io.cwd, '.claude', 'settings.local.json'),
  ];
  for (const f of [...new Set(settingsFiles)]) {
    const s = io.read(f);
    for (const [event, groups] of Object.entries((s && s.hooks) || {})) {
      for (const g of groups || []) {
        for (const h of g.hooks || []) {
          const text = String(h.command || '');
          if (DATAVERSE.test(text) && !isToolkit(text)) found.push({ kind: 'hook', name: text.slice(0, 160), where: `${event} hook in ${f}`, file: f, event });
        }
      }
    }
  }
  return found;
}

// ---- the checks ----

// deps = { envs, access, cli() -> {version}, connect(env) -> read dv, io, pin (expected CLI version or null),
//          pending() -> { events, logs } }
// Every failing check names its fix (10/7): setup is "run doctor, do the fixes it names, run it again".
// A fix is a command to run, a step the person takes, or "ask Dylan" where only he can fix it.
const INSTALL = (pin) => `npm install -g @microsoft/dataverse@${pin || 'latest'}`;
const SIGN_IN = (host) => `dataverse auth create --environment ${host}   (the person signs in in their browser; add --deviceCode if no browser opens)`;
const THREATLOCKER = 'ThreatLocker tray icon > Rapid Check-in; if still blocked, request access for that file (Windows; approval is per file, so each new CLI version needs it)';

function doctor(deps) {
  const checks = [];
  const add = (label, status, detail = '', fix = null) => checks.push({ label, status, detail, fix });
  let person = null;
  const reached = [];

  // 1. the CLI (STARTED, not just found: ThreatLocker can block a found file)
  let cliOk = false;
  try {
    const c = deps.cli();
    cliOk = true;
    if (deps.pin && c.version !== deps.pin) add('Dataverse CLI', 'fail', `version ${c.version}, the toolkit expects ${deps.pin}`, `${INSTALL(deps.pin)}, then run the health check again${process.platform === 'win32' ? `; if it is then blocked: ${THREATLOCKER}` : ''}`);
    else add('Dataverse CLI', 'ok', `version ${c.version || 'unknown'}`);
  } catch (e) {
    add('Dataverse CLI', 'fail', e.message, e.code === 'cli_blocked' ? THREATLOCKER : `${INSTALL(deps.pin)} (Node must be installed first; /dataverse-setup walks it)`);
  }

  // 2. signed in, per environment; 3. access; 4. the log tables
  if (cliOk) {
    for (const [env, info] of Object.entries(deps.envs)) {
      let dv;
      let me;
      try {
        dv = deps.connect(env);
        me = whoAmI(dv);
      } catch (e) {
        const level = null; // this app did not answer, so its Write Access list cannot be read either
        // No role in an app is normal for most staff; it fails where they are meant to write, or where
        // they SAID they use it (`doctor --apps`, gap 3: else a forgotten sign-in reads as "fine").
        if (deps.apps && deps.apps.includes(env)) add(`Signed in: ${info.name}`, 'fail', `you use the ${info.name} but Dataverse did not answer: ${e.message.slice(0, 160)}`, `${SIGN_IN(info.host)}; if it still does not answer, ask Dylan to check your security role in the ${info.name}`);
        else if (level === 'write' || level === 'schema') add(`Signed in: ${info.name}`, 'fail', `you have ${level} access here but Dataverse did not answer: ${e.message}`, `${SIGN_IN(info.host)}; if it still does not answer, ask Dylan to check your security role in the ${info.name}`);
        else add(`Signed in: ${info.name}`, 'info', `no answer (fine if you don't use the ${info.name}): ${e.message.slice(0, 120)}`);
        continue;
      }
      person = person || me;
      reached.push(env);
      let acc;
      try {
        acc = accessFor(resolveAccess(deps.access, dv, env), me.email, env);
      } catch (e) {
        // The Write Access list cannot be read here: writes in this app are refused (fail closed).
        add(`Access list: ${info.name}`, deps.apps && deps.apps.includes(env) ? 'fail' : 'info', e.message, `ask Dylan: your role cannot read the Write Access list in the ${info.name}`);
        acc = { level: 'read', maxRows: null };
      }
      add(`Signed in: ${info.name}`, 'ok', `${me.fullname}; shared-path access ${acc.level}${acc.level === 'read' ? '' : `, up to ${acc.maxRows === null ? 'any number of' : acc.maxRows} rows per approval`}`);
      for (const [set, label] of [['sbrm_dataversewritelogs', 'Write Log'], ['sbrm_dataverseevents', 'event table']]) {
        try {
          dv.get(`${set}?$top=1&$select=createdon`);
          if (acc.level !== 'read') add(`${label}: ${info.name}`, 'ok', 'reachable');
        } catch (e) {
          add(`${label}: ${info.name}`, acc.level === 'read' ? 'info' : 'fail', e.message.slice(0, 160), acc.level === 'read' ? null : `ask Dylan: the ${label} table or your role's access to it in the ${info.name}`);
        }
      }
    }
    if (!reached.length) {
      const first = Object.values(deps.envs)[0];
      add('Any app', 'fail', 'Dataverse did not answer in any app; you are probably not signed in', first ? SIGN_IN(first.host) : 'run /dataverse-setup');
    }
  }

  // 5. nothing stuck on this machine: first send what is waiting to every app that answered, then count
  if (deps.sendPending && reached.length) {
    try { deps.sendPending(reached); } catch { /* whatever did not go is counted below */ }
  }
  const p = deps.pending();
  if (p.events || p.logs) add('Waiting on this machine', 'fail', `${p.logs} Write Log row(s) and ${p.events} event(s) not yet sent`, 'they go up the next time this machine reaches that app; if they are still here after a passing sign-in, tell Dylan');
  else add('Waiting on this machine', 'ok', 'nothing');

  // 6. drift (D4a)
  const drift = scanDrift(deps.io);
  if (drift.length) {
    for (const d of drift) {
      const fix = d.kind === 'connection'
        ? `with the person's OK: claude mcp remove ${d.name} --scope ${d.scope}${d.project ? `   (run from ${d.project})` : ''}`
        : `with the person's OK: remove that ${d.event} hook entry from ${d.file} (keep everything else in the file)`;
      add(`Extra Dataverse ${d.kind}`, 'fail', `${d.name} (${d.where}); the toolkit's should be the only one`, fix);
    }
  } else add('Dataverse connections', 'ok', "only the toolkit's");

  // 7. the guard (DESIGN.md F15): it ships beside the engine, it really blocks a session reaching the write side (skipping the pop-up) when fed
  // one the way Claude Code feeds it, and no settings file switches hooks off. Whether Claude Code has
  // the plugin enabled is not visible from here; the drift check and setup cover that side.
  if (deps.guard) {
    const g = deps.guard();
    if (!g.present) add('Guard', 'fail', 'the toolkit guard is missing from this install', 'ask Dylan: the SBRM toolkit plugin needs reinstalling or updating');
    else if (!g.blocksBypass) add('Guard', 'fail', `the toolkit guard did not block a test bypass of the pop-up (${g.detail || 'no detail'})`, 'ask Dylan: the guard is broken in this install; do not write to Dataverse until it is fixed');
    else if (g.hooksOff) add('Guard', 'fail', `hooks are switched off in ${g.hooksOff}, so the guard never runs`, `with the person's OK: set "disableAllHooks" to false (or remove it) in ${g.hooksOff}`);
    else add('Guard', 'ok', 'blocks a test bypass of the pop-up; hooks are on');
  } else add('Guard', 'info', 'not checked');

  const failed = checks.filter((c) => c.status === 'fail');
  const code = drift.length ? 'drift' : failed.length ? 'health_failed' : 'health_passed';
  return { checks, failed, code, person, reached };
}

function render(result) {
  const mark = { ok: 'ok  ', fail: 'FAIL', info: '--  ' };
  const lines = result.checks.flatMap((c) => [
    `  ${mark[c.status]}  ${c.label}${c.detail ? `: ${c.detail}` : ''}`,
    ...(c.status === 'fail' && c.fix ? [`        fix: ${c.fix}`] : []),
  ]);
  const verdict = result.failed.length
    ? `${result.failed.length} problem(s). ${result.code === 'drift' ? 'An extra Dataverse connection or hook is on this machine. ' : ''}This has been recorded for Dylan.`
    : 'Everything checked is working.';
  return ['', 'Dataverse health check', '', ...lines, '', verdict, ''].join('\n');
}

module.exports = { doctor, render, scanDrift, isToolkit };
