#!/usr/bin/env node
'use strict';
// The shared Dataverse write engine (job contract `sbrm-dv-job/1`).
//
//   check  <job.json>   file-level validation only, no Dataverse calls
//   plan   <job.json>   validate + resolve live (reads only) + save a plan record, print it
//   show   <plan-id>    every change in a saved plan, row by row
//   whoami <env>        who Dataverse says you are, and your access in the shared path
//   snapshot <env> <set> <id>   read a view / form / sitemap / flow and its hash, for a component job (§10e)
//   apply  <plan-id>... re-check, the approval (Claude Code prompt + ticket), write, read back, log (CONTRACT.md §5, §9)
//   revert <plan-id> [env]  plan the undo of an applied plan (CONTRACT.md §10); apply it as usual
//   doctor              the health check for this machine (DESIGN.md §7 D4, D4a)
//   report "<words>" [--plan <id>] [--env <env>]   the person says something is wrong (§7 D3)
//   review [--days N] [--brief]                    Dylan's view of the whole toolkit (§7 D5)
//   resolve <number> <resolution> "<note>" [--fixed-in <version>]   Dylan closes an open item (§7 D7)
//
// The job file is a REQUEST; nothing in it is trusted. Everything shown for approval is
// computed here from the job plus live reads.
//
// EVERY command runs inside runCli() (DESIGN.md §7): one run id, what the run printed, and ONE place
// where a refusal or crash is printed AND recorded as an event. Commands never print their own
// refusals; they throw them, so no refusal can leave without a record (test/cli.test.js proves it).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateJob } = require('./lib/contract');
const { readConnection, resolveCli, launchError, DataverseError } = require('./lib/cli');
const health = require('./lib/health');
const review = require('./lib/review');
const log = require('./lib/log');
const merge = require('./lib/merge');
const { readAccess, resolveAccess, mergeAccessLists } = require('./lib/access');
const { planJob, whoAmI, accessFor, PlanRefused } = require('./lib/resolve');
const { savePlan, loadPlan, home, dir, PLAN_ID } = require('./lib/store');
const { gitExposure } = require('./lib/safety');
const { summary, detail } = require('./lib/render');
const { applyPlan, ApplyRefused } = require('./lib/apply');
const { writeConnection } = require('./lib/write');
const ticket = require('./lib/ticket');
const { planRevert, findEntry } = require('./lib/revert');
const { readEntries } = require('./lib/log');
const events = require('./lib/events');
const blocks = require('./lib/blocks');
const levels = require('./lib/levels');

// App development kinds (DESIGN.md §10): each one module with the same contract as lib/merge.js.
// Loaded on first use, so a rows or merge run never pays for them.
const APP_KINDS = {
  schema: () => {
    const m = require('./lib/schema');
    return { label: 'app change (tables, columns, choices)', validate: m.validateSchemaJob, plan: m.planSchema, summary: m.schemaSummary, detail: m.schemaDetail, apply: m.applySchema, revert: m.planSchemaRevert };
  },
  component: () => {
    const m = require('./lib/component');
    return { label: 'app change (view, form, sitemap, flow)', validate: m.validateComponentJob, plan: m.planComponent, summary: m.componentSummary, detail: m.componentDetail, apply: m.applyComponent, revert: m.planComponentRevert };
  },
};
const appKind = (kind) => (Object.prototype.hasOwnProperty.call(APP_KINDS, kind) ? APP_KINDS[kind]() : null);

// The machine as doctor sees it (D4a drift reads Claude Code's own config files).
function realIo() {
  return {
    home: os.homedir(),
    cwd: process.cwd(),
    read(file) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
    },
  };
}

// The guard beside this engine, fed a test apply exactly as Claude Code feeds it (stdin JSON, exit 2 =
// blocked), plus a look for disableAllHooks in the person's settings. Nothing is written.
function realGuard() {
  const { spawnSync } = require('child_process');
  const file = path.join(__dirname, '..', 'guard', 'guard.js');
  if (!fs.existsSync(file)) return { present: false };
  // A session reaching the write side without the CLI (which would skip the pop-up) must be blocked.
  const lib = path.join(__dirname, 'lib', 'write').replace(/\\/g, '/');
  const probe = JSON.stringify({ tool_name: 'Bash', tool_input: { command: `node -e "const { ${['write', 'Connection'].join('')} } = require('${lib}')"` } });
  // SBRM_GUARD_PROBE: these test calls are doctor's own, not blocks of the person's work, so the guard keeps
  // no record of them (1.11.6). Set on the guard's process here; a session command cannot set it for the hook.
  const probeEnv = { ...process.env, SBRM_GUARD_PROBE: '1' };
  let r = spawnSync(process.execPath, [file], { input: probe, encoding: 'utf8', windowsHide: true, env: probeEnv });
  // Then the way the HOOK runs it: `bash run.sh`, with whatever `bash` this machine finds first (1.10.1: on
  // Windows a WSL bash ahead of Git Bash could not start the launcher, and a hook that cannot start fails
  // open). Both must block.
  const launcher = path.join(__dirname, '..', 'guard', 'run.sh');
  let via = 'node';
  if (r.status === 2 && fs.existsSync(launcher)) {
    const h = spawnSync('bash', [launcher], { input: probe, encoding: 'utf8', windowsHide: true, env: { ...probeEnv, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..', '..') } });
    if (h.status !== 2) { r = h; via = 'bash run.sh (as the hook runs it)'; }
  }
  // 1.11.0: an apply in a mode where Claude Code does not ask must be refused (nothing is minted for it).
  if (r.status === 2) {
    const apply = JSON.stringify({ tool_name: 'Bash', permission_mode: 'bypassPermissions', tool_input: { command: `node "${path.join(__dirname, 'dataverse-write.js').replace(/\\/g, '/')}" apply 20000101-000000-00000000` } });
    const m = spawnSync(process.execPath, [file], { input: apply, encoding: 'utf8', windowsHide: true, env: probeEnv });
    if (m.status !== 2) { r = m; via = 'node (an apply in bypassPermissions mode)'; }
  }
  let hooksOff = null;
  for (const f of [path.join(os.homedir(), '.claude', 'settings.json'), path.join(os.homedir(), '.claude', 'settings.local.json')]) {
    try { if (JSON.parse(fs.readFileSync(f, 'utf8')).disableAllHooks === true) hooksOff = f; } catch { /* absent or unreadable */ }
  }
  return { present: true, blocksBypass: r.status === 2, detail: `${via}: exit ${r.status}${r.error ? ` (${r.error.code || r.error.message})` : ''}`, hooksOff };
}

// doctor's CLI check STARTS the binary (finding it is not enough: ThreatLocker can block a found file).
function realCli() {
  const { spawnSync } = require('child_process');
  const c = resolveCli();
  const r = spawnSync(c.binary, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw launchError(c.binary, r.error);
  return c;
}

// The environment URLs this machine holds a SAVED sign-in for (`dataverse auth list`), or null if the CLI
// cannot say. Reads only.
function realAuthList() {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync(resolveCli().binary, ['auth', 'list'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return `${r.stdout || ''}\n${r.stderr || ''}`.match(/https:\/\/[^\s/]+\/?/gi) || [];
  } catch {
    return null;
  }
}

// No `confirm` here (1.11.0, DESIGN.md §10n): the person approves in Claude Code's permission prompt and
// the engine checks the guard's one-time ticket (lib/ticket.js) instead. Tests inject `confirm` to stand in
// for an approval; the ticket path runs only when none is injected.
const DEFAULT_DEPS = {
  readConnection, writeConnection, eventConnection: events.eventConnection,
  cli: realCli, io: realIo, guard: realGuard,
};

// The approval for one key (a plan id, or resolve-D-1003): the guard's ticket is USED UP as the command
// starts (blind review 10/8: checking first and taking at the write let a long merge or schema run, or the
// earlier plans of a batch, outlive the ticket, and logged that as the person's "cancel"). The ticket's
// clock therefore covers only the time the person took to answer. A batch takes all its tickets at once
// (runBatch) and hands them in as `deps.approved`. No good ticket: refused before anything is read.
function approvalFor(deps, key) {
  if (deps.confirm) return deps.confirm;
  const r = deps.approved && deps.approved.has(key) ? deps.approved.get(key) : (deps.ticket || ticket).take(key);
  if (!r.ok) throw new ApplyRefused(ticket.refusalText(r.why), r.why === 'expired' ? 'approval_expired' : 'no_approval');
  return () => ({ approved: true });
}

function configDir() {
  return process.env.SBRM_DV_CONFIG || path.join(__dirname, '..');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// `access` is a READER, not data: who may write lives in each environment's Dataverse Write Access table
// (10/7, lib/access.js), read through the person's own connection once it exists. There is no access.json.
// warnRows: no cap on a change's size (ruled 10/7); over this many rows, pairs or objects it is flagged
// "Large change" at plan and in the pop-up (lib/severity.js).
function config() {
  const noNotes = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
  const w = Number(toolkitConfig().warn_rows);
  return {
    envs: noNotes(readJson(path.join(configDir(), 'envs.json'))),
    access: (dv, env) => readAccess(dv, env),
    warnRows: Number.isInteger(w) && w > 0 ? w : 50,
  };
}

// A refusal raised by the CLI itself. `nothing` says what did not happen ("planned" / "written").
class Refusal extends Error {
  constructor(code, title, reasons, { nothing = code === 'usage' ? 'done' : 'planned', exitCode = 1 } = {}) {
    super(`${title}: ${reasons.join(' ')}`);
    this.name = 'Refusal';
    this.code = code;
    this.title = title;
    this.reasons = reasons;
    this.nothing = nothing;
    this.exitCode = exitCode;
  }
}

function loadJob(file, envs) {
  let raw;
  try {
    raw = readJson(file);
  } catch (e) {
    return { errors: [`cannot read ${file} as JSON: ${e.message}`] };
  }
  // Four kinds: rows (CONTRACT.md §2a), merge (DESIGN.md §8c), schema and component (§10e).
  if (raw && raw.kind === 'merge') return merge.validateMergeJob(raw, { envs });
  const app = raw && appKind(raw.kind);
  return app ? app.validate(raw, { envs }) : validateJob(raw, { envs });
}

function jobRefusal(errors) {
  const code = errors.some((e) => /^intent does not match/.test(e)) ? 'intent_mismatch' : 'invalid_job';
  return new Refusal(code, 'the job file is not valid', errors);
}

// Client information stays in the Microsoft tenant (lib/safety.js). Returns a refusal reason or null.
function storeExposure() {
  const s = gitExposure(home());
  return s.exposed
    ? `the engine's store (${home()}) is inside a git-tracked folder (${s.repo}); plans and logs hold client records. Point SBRM_DV_HOME outside it.`
    : null;
}

function jobExposure(file, envInfo) {
  if (!envInfo.hipaa) return null;
  const s = gitExposure(file);
  return s.exposed
    ? `this job file is for the ${envInfo.name}, which holds HIPAA client records, and it sits in a git-tracked folder (${s.repo}). Client information never goes where git can carry it. Save the job file in ${path.join(home(), 'jobs')} instead, and delete this copy.`
    : null;
}

function refuseIfExposed(reasons, nothing) {
  const r = reasons.filter(Boolean);
  if (r.length) throw new Refusal('client_info_exposed', 'client information would be exposed', r, { nothing });
}

function connect(run, deps, kind, host) {
  const dv = kind === 'write' ? deps.writeConnection(host) : deps.readConnection(host);
  run.connected = true;
  return dv;
}

function cmdCheck(run, deps, file) {
  const { envs } = config();
  const { errors, job } = loadJob(file, envs);
  if (errors.length) throw jobRefusal(errors);
  run.env = job.env;
  refuseIfExposed([jobExposure(file, envs[job.env])]);
  const app = appKind(job.kind);
  console.log(job.kind === 'merge'
    ? `\nThe job file is valid: merge ${job.pairs.length} pair(s) of ${job.table} (${envs[job.env].name}).`
    : app ? `\nThe job file is valid: an ${app.label} in the ${envs[job.env].name}.`
      : `\nThe job file is valid: ${job.mode} ${job.rows.length} row(s) in ${job.table} (${envs[job.env].name}).`);
  console.log('Live checks (access, columns, targets, duplicates) run at `plan`.\n');
  return 0;
}

// A read connection to ANOTHER environment, for the "tried in Donor App Dev first?" check (lib/proven.js).
function readEnvFor(run, deps, envs) {
  const conns = {};
  return (env) => conns[env] || (conns[env] = deps.readConnection(envs[env].host));
}

function cmdPlan(run, deps, file) {
  const { envs, access, warnRows } = config();
  const { errors, job } = loadJob(file, envs);
  if (errors.length) throw jobRefusal(errors);
  run.env = job.env;
  refuseIfExposed([storeExposure(), jobExposure(file, envs[job.env])]);
  const dv = connect(run, deps, 'read', envs[job.env].host);
  if (job.kind === 'merge') return planMergeCmd(run, dv, job, { envs, access, warnRows });
  const app = appKind(job.kind);
  if (app) return planAppCmd(run, dv, job, app, { envs, access, warnRows, readEnv: readEnvFor(run, deps, envs) });
  const planned = planJob(dv, job, { envs, access, warnRows });
  // A delete plan is async (the linked-record inventory reads in parallel).
  return planned && typeof planned.then === 'function' ? planned.then((p) => reportPlan(run, p)) : reportPlan(run, planned);
}

function reportPlan(run, plan) {
  run.person = plan.identity;
  const { id, file: planFile } = savePlan(plan);
  run.planId = id;
  console.log('\n' + summary(plan));
  console.log(`\nPlan ${id} saved (${planFile}).`);
  console.log(`Every change, row by row: node "${path.resolve(__filename)}" show ${id}`);
  console.log(`To write it: node "${path.resolve(__filename)}" apply ${id}`);
  console.log('Nothing has been written. Apply asks for approval in Claude Code; only a Yes there writes.\n');
  return 0;
}

// An app development plan (DESIGN.md §10): kind schema or component.
async function planAppCmd(run, dv, job, app, ctx) {
  const plan = await app.plan(dv, job, ctx);
  run.person = plan.identity;
  const { id, file: planFile } = savePlan(plan);
  run.planId = id;
  console.log('\n' + app.summary(plan));
  console.log(`\nPlan ${id} saved (${planFile}).`);
  console.log(`Every change in full: node "${path.resolve(__filename)}" show ${id}`);
  console.log(`To write it: node "${path.resolve(__filename)}" apply ${id}`);
  console.log('Nothing has been changed. Apply asks for approval in Claude Code; only a Yes there writes.\n');
  return 0;
}

// A merge plan (async: the inventory reads run in parallel).
async function planMergeCmd(run, dv, job, { envs, access, warnRows }) {
  const plan = await merge.planMerge(dv, job, { envs, access, warnRows });
  run.person = plan.identity;
  const { id, file: planFile } = savePlan(plan);
  run.planId = id;
  console.log('\n' + merge.mergeSummary(plan));
  console.log(`\nPlan ${id} saved (${planFile}).`);
  console.log(`Every pair, record by record: node "${path.resolve(__filename)}" show ${id}`);
  console.log(`To merge: node "${path.resolve(__filename)}" apply ${id}`);
  console.log('Nothing has been merged. Apply asks for approval in Claude Code; only a Yes there merges.\n');
  return 0;
}

// Undo of a merge (DESIGN.md §8f): the rebuild, planned from the merge's Write Log entry.
async function planUnmergeCmd(run, dv, entry, mergeId, note, { envs, access }) {
  const plan = await merge.planUnmerge(dv, entry, { envs, access });
  run.person = plan.identity;
  const { id, file: planFile } = savePlan(plan);
  run.planId = id;
  console.log(`\nUndo of merge plan ${mergeId}${note}:\n`);
  console.log(merge.unmergeSummary(plan));
  console.log(`\nPlan ${id} saved (${planFile}).`);
  console.log(`To write it: node "${path.resolve(__filename)}" apply ${id}`);
  console.log('Nothing has been written. Apply asks for approval in Claude Code; only a Yes there writes.\n');
  return 0;
}

async function applyMergeCmd(run, deps, id, record, file) {
  const { access } = config();
  const fn = record.kind === 'unmerge' ? merge.applyUnmerge : merge.applyMerge;
  const res = await fn(record, { access, connect: (host) => connect(run, deps, 'write', host), confirm: deps.confirm }, { id, file, fs });
  run.person = res.person;
  const logged = log.writeEntry(res.entry, res.dv);
  run.wroteLog = true;
  if (res.outcome === 'cancelled') {
    console.log(`\nCancelled. Nothing was ${record.kind === 'unmerge' ? 'written' : 'merged'}. The plan is kept: apply it again, or make a new one.`);
  } else {
    const verb = record.kind === 'unmerge' ? ['written', 'not written'] : ['merged', 'not merged'];
    console.log(`\n${res.outcome.toUpperCase()}: ${res.written} ${verb[0]}, ${res.rows.length - res.written} ${verb[1]}, ${res.left_out.length} left out.\n`);
    for (const r of res.rows) console.log(`  ${r.outcome === 'written' ? 'OK ' : '!! '} ${r.name}${r.outcome === 'written' ? '' : `  ${r.outcome}`}`);
  }
  console.log(logged.rowOk
    ? `\nLogged in Dataverse: Dataverse Write Log row "${logged.key}"${record.kind === 'merge' ? ' (both records in full as they were, and every moved record)' : ` (undoes plan ${record.reverts_plan_id})`}.`
    : `\nNOT logged in Dataverse yet (${logged.error || 'unknown error'}). The row is parked on this machine and retried at the next apply here.`);
  console.log(`Local copy: ${logged.local}\n`);
  if (!logged.rowOk) events.record(run, { kind: 'parked', code: 'parked', headline: `Write Log row for merge plan ${id} could not be written: ${logged.error || 'unknown error'}` });
  return res.outcome === 'applied' ? 0 : 1;
}

// Apply an app development plan (DESIGN.md §10). Same shape as a merge apply: the module re-checks, shows
// the pop-up and writes; this writes the log entry it hands back.
async function applyAppCmd(run, deps, id, record, file, app) {
  const { access } = config();
  const res = await app.apply(record, { access, connect: (host) => connect(run, deps, 'write', host), confirm: deps.confirm }, { id, file, fs });
  run.person = res.person;
  const logged = log.writeEntry(res.entry, res.dv);
  run.wroteLog = true;
  if (res.outcome === 'cancelled') {
    console.log(`\nCancelled. Nothing was changed.${res.entry.note ? ` (${res.entry.note})` : ''} The plan is kept: apply it again, or make a new one.`);
  } else {
    console.log(`\n${res.outcome.toUpperCase()}: ${res.written} done, ${res.rows.length - res.written} not done, ${res.left_out.length} left out.\n`);
    for (const r of res.rows) console.log(`  ${r.outcome === 'written' ? 'OK ' : '!! '} ${r.name}${r.outcome === 'written' ? '' : `  ${r.outcome}`}`);
  }
  console.log(logged.rowOk
    ? `\nLogged in Dataverse: Dataverse Write Log row "${logged.key}"${record.reverts_plan_id ? ` (undoes plan ${record.reverts_plan_id})` : ''}.`
    : `\nNOT logged in Dataverse yet (${logged.error || 'unknown error'}). The row is parked on this machine and retried at the next apply here.`);
  console.log(`Local copy: ${logged.local}\n`);
  if (!logged.rowOk) events.record(run, { kind: 'parked', code: 'parked', headline: `Write Log row for plan ${id} could not be written: ${logged.error || 'unknown error'}` });
  return res.outcome === 'applied' ? 0 : 1;
}

function readLocal(id) {
  const logDir = dir('log');
  for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith('.md'))) {
    try {
      const hit = readEntries(path.join(logDir, f)).find((e) => e.plan_id === id && e.outcome !== 'cancelled');
      if (hit) return hit;
    } catch { /* unreadable file: skip */ }
  }
  return null;
}

// The env a plan wrote to: the local log on this machine first, then each env's log table.
function locate(run, deps, id, envs) {
  const local = readLocal(id);
  if (local && envs[local.env]) return { env: local.env, local };
  for (const env of Object.keys(envs)) {
    let entry = null;
    try { entry = findEntry(connect(run, deps, 'read', envs[env].host), id); } catch { entry = null; }
    if (entry) return { env, entry };
  }
  return null;
}

// Undo of an app change: the module plans it from the log entry (DESIGN.md §10e).
async function planAppRevertCmd(run, dv, entry, id, note, app, ctx) {
  const plan = await app.revert(dv, entry, ctx);
  run.person = plan.identity;
  const { id: planId, file: planFile } = savePlan(plan);
  run.planId = planId;
  console.log(`\nUndo of plan ${id}${note}:\n`);
  console.log(app.summary(plan));
  console.log(`\nPlan ${planId} saved (${planFile}).`);
  console.log(`To write it: node "${path.resolve(__filename)}" apply ${planId}`);
  console.log('Nothing has been changed. Apply asks for approval in Claude Code; only a Yes there writes.\n');
  return 0;
}

function cmdRevert(run, deps, id, envArg) {
  const { envs, access, warnRows } = config();
  if (!PLAN_ID.test(id)) throw new Refusal('usage', 'the undo', [`not a plan id: ${id}`], { exitCode: 2 });
  if (envArg && !envs[envArg]) throw new Refusal('usage', 'the undo', [`unknown env "${envArg}"; one of: ${Object.keys(envs).join(', ')}`], { exitCode: 2 });
  refuseIfExposed([storeExposure()]);
  const found = envArg ? { env: envArg } : locate(run, deps, id, envs);
  if (!found) throw new Refusal('nothing_to_undo', 'the undo', [`no applied entry for plan ${id} in any environment's log or this machine's local log`]);
  run.env = found.env;
  const dv = connect(run, deps, 'read', envs[found.env].host);
  // The Dataverse row is the record of what happened; this machine's local copy covers a row
  // that is still parked here waiting to land.
  let entry = found.entry || findEntry(dv, id);
  let note = '';
  if (!entry) {
    entry = found.local || readLocal(id);
    if (entry) note = " (read from this machine's local log: its Dataverse row has not landed yet)";
  }
  // The entry must belong to the environment it was read from: an undo plans, checks access and writes in
  // ONE environment (10/7 final re-verify: a mismatched entry read access from the wrong app's list).
  if (entry && entry.env !== found.env) {
    throw new Refusal('not_permitted', 'the undo', [`the log entry for plan ${id} says it ran in "${entry.env}" but was found in "${found.env}"; nothing was planned. Ask Dylan.`]);
  }
  if (entry && entry.mode === 'merge') return planUnmergeCmd(run, dv, entry, id, note, { envs, access });
  const app = entry && appKind(entry.mode);
  if (app) return planAppRevertCmd(run, dv, entry, id, note, app, { envs, access, warnRows, readEnv: readEnvFor(run, deps, envs) });
  const res = planRevert(dv, entry, { envs, access, warnRows });
  run.person = res.plan.identity;
  const jobFile = path.join(dir('jobs'), `revert-${id}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(res.raw, null, 2), 'utf8');
  const { id: planId, file: planFile } = savePlan(res.plan);
  run.planId = planId;
  console.log(`\nUndo of plan ${id}${note}:\n`);
  console.log(summary(res.plan));
  console.log(`\nPlan ${planId} saved (${planFile}). Undo job: ${jobFile}`);
  console.log(`Every change, row by row: node "${path.resolve(__filename)}" show ${planId}`);
  console.log(`To write it: node "${path.resolve(__filename)}" apply ${planId}`);
  console.log('Nothing has been written. Apply asks for approval in Claude Code; only a Yes there writes.\n');
  return 0;
}

function cmdShow(run, deps, id) {
  run.planId = id;
  const { record, intact } = loadPlan(id);
  run.env = record.env;
  run.person = record.identity;
  if (!intact) console.log('\n!! This plan file was changed after it was made. It will be refused at apply.\n');
  const app = appKind(record.kind);
  console.log('\n' + (record.kind === 'merge' ? merge.mergeDetail(record, { id }) : record.kind === 'unmerge' ? merge.unmergeSummary(record) : app ? app.detail(record, { id }) : detail(record, { id })) + '\n');
  if (!intact) {
    events.record(run, { kind: 'refused', code: 'plan_tampered', headline: `Plan ${id} was changed after it was made (seen by show)` });
    return 1;
  }
  return 0;
}

function cmdApply(run, deps, id) {
  const { record } = loadPlan(id); // a missing plan refuses here, before anything else
  run.planId = id;
  run.env = record.env;
  deps = { ...deps, confirm: approvalFor(deps, id) };
  const done = inflight(id, record);
  let out;
  try { out = applyAny(run, deps, id); } catch (e) { done(); throw e; }
  return out && typeof out.then === 'function' ? out.then((v) => { done(); return v; }, (e) => { done(); throw e; }) : (done(), out);
}

function applyAny(run, deps, id) {
  const { access } = config();
  run.planId = id;
  const { record } = loadPlan(id);
  run.env = record.env;
  run.person = record.identity; // provisional: apply refuses a different signed-in person
  refuseIfExposed([storeExposure()], 'written');
  // The server written to is the one the toolkit names for the plan's app, never only the plan's word for
  // it (10/7 third pass: a plan could say "Donor App" and point at another environment's host).
  const { envs: knownEnvs } = config();
  if (!knownEnvs[record.env] || knownEnvs[record.env].host !== record.host || knownEnvs[record.env].name !== record.app) {
    throw new ApplyRefused(`this plan's app (${record.app || '?'}) and server (${record.host || '?'}) do not match the toolkit's list for "${record.env}". Make a new plan.`, 'plan_tampered');
  }
  if (record.kind === 'merge' || record.kind === 'unmerge') {
    const { intact, file } = loadPlan(id);
    if (!intact) throw new ApplyRefused('this plan file was changed after it was made. Make a new plan.', 'plan_tampered');
    return applyMergeCmd(run, deps, id, record, file);
  }
  const app = appKind(record.kind);
  if (app) {
    const { intact, file } = loadPlan(id);
    if (!intact) throw new ApplyRefused('this plan file was changed after it was made. Make a new plan.', 'plan_tampered');
    return applyAppCmd(run, deps, id, record, file, app);
  }
  const res = applyPlan(id, { access, connect: (host) => connect(run, deps, 'write', host), confirm: deps.confirm });
  // A delete apply is async (its linked-record re-check reads in parallel); everything else is not.
  return res && typeof res.then === 'function' ? res.then((r) => reportApply(run, id, r)) : reportApply(run, id, res);
}

// An apply in flight leaves a marker in the store's pending folder until it returns. A marker an hour old
// means the run was cut off part-way (a command time limit, a closed laptop): the next run of the engine on
// this machine files it as a signal event, so Dylan sees which plan to check (10/7 third pass: a killed
// apply left no Write Log entry at all).
function inflight(id, record) {
  const file = path.join(dir('pending'), `inflight--${id}.marker`);
  try { fs.writeFileSync(file, JSON.stringify({ plan_id: id, env: record.env, app: record.app, kind: record.kind, table: record.table, started: new Date().toISOString() }), 'utf8'); } catch { /* best effort */ }
  return () => { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } };
}

function reportInterrupted(run) {
  let files = [];
  try { files = fs.readdirSync(dir('pending')).filter((f) => f.startsWith('inflight--')); } catch { return; }
  for (const f of files) {
    const p = path.join(dir('pending'), f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs < 6 * 3600 * 1000) continue; // six hours: longer than any apply (schema runs stop at 25 min)
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      events.record(run, { kind: 'interrupted', code: 'interrupted', env: m.env, headline: `An apply of plan ${m.plan_id} (${m.kind} on ${m.table} in the ${m.app}) was cut off part-way on this machine; check what landed (it may have no Write Log entry)` });
      fs.rmSync(p, { force: true });
    } catch { /* leave it for the next run */ }
  }
}

// The guard could not run on this machine (1.11.6, DESIGN.md §11, candidate 3): guard/run.sh's fallback leaves
// one plain line per call in events/guard_down.log (it may have no node to do more). Each engine run turns
// what is there into ONE open item and removes the file; the rename is the claim, so two runs cannot both.
function reportGuardDown(run) {
  const file = path.join(dir('events'), 'guard_down.log');
  if (!fs.existsSync(file)) return;
  const claimed = `${file}.${process.pid}.claimed`;
  try { fs.renameSync(file, claimed); } catch { return; }
  try {
    const rows = fs.readFileSync(claimed, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
    if (!rows.length) return;
    const reasons = [...new Set(rows.map((r) => r[1] || 'unknown'))];
    const tools = [...new Set(rows.map((r) => r[2]).filter(Boolean))];
    events.record(run, {
      kind: 'guard could not run', code: 'guard_down', env: 'machine',
      headline: `The guard could not run on this machine ${rows.length} time(s) (${reasons.join('; ')}): it fell back to blocking anything that names Dataverse`,
      detail: [
        `First: ${rows[0][0]}   Last: ${rows[rows.length - 1][0]}   Calls: ${rows.length}`,
        `Why: ${reasons.join('; ')}`, `Tools: ${tools.join(', ') || 'not known'}`, '',
        'Fix: /dataverse-setup (or start Claude Code from a terminal where node works); then doctor.', '',
        'Last 50 lines (time, why, tool):', ...rows.slice(-50).map((r) => `  ${r.join('  ')}`),
      ].join('\n'),
    });
  } catch { /* the file is gone either way; the next fallback call starts a new one */ } finally {
    fs.rmSync(claimed, { force: true });
  }
}

function reportApply(run, id, res) {
  run.person = res.person || run.person;
  run.wroteLog = true; // the Write Log entry is this outcome's record (applied, with problems, or cancelled)
  if (res.outcome === 'cancelled') {
    console.log(`\nCancelled. Nothing was written.${res.note ? ` (${res.note})` : ''} The plan is kept: apply it again, or make a new one.`);
  } else {
    console.log(`\n${res.outcome.toUpperCase()}: ${res.written} written, ${res.failed} not written, ${res.left_out.length} left out.\n`);
    for (const r of res.rows) console.log(`  ${r.outcome === 'written' ? 'OK ' : '!! '} ${r.name}  ${r.id}${r.outcome === 'written' ? '' : `  ${r.outcome}`}`);
  }
  console.log(res.logged.rowOk
    ? `\nLogged in Dataverse: Dataverse Write Log row "${res.logged.key}".`
    : `\nNOT logged in Dataverse yet (${res.logged.error || 'unknown error'}). The row is parked on this machine and retried at the next apply here.`);
  if (res.logged.flushed) console.log(`Also landed ${res.logged.flushed} earlier parked log row(s).`);
  console.log(`Local copy: ${res.logged.local}\n`);
  if (!res.logged.rowOk) {
    events.record(run, { kind: 'parked', code: 'parked', headline: `Write Log row for plan ${id} could not be written: ${res.logged.error || 'unknown error'}` });
  }
  return res.outcome === 'applied' ? 0 : 1;
}

function cmdWhoami(run, deps, env) {
  const { envs, access } = config();
  if (!envs[env]) throw new Refusal('usage', 'whoami', [`unknown env "${env}"; one of: ${Object.keys(envs).join(', ')}`], { exitCode: 2 });
  run.env = env;
  const dvW = connect(run, deps, 'read', envs[env].host);
  const me = whoAmI(dvW);
  run.person = me;
  const full = resolveAccess(access, dvW, env);
  const acc = accessFor(full, me.email, env);
  const mayMerge = levels.atLeast(acc.level, 'admin') || (levels.atLeast(acc.level, 'write') && (((full.people || {})[me.email] || {}).merge || {})[env] === true);
  console.log(`\n${me.fullname} <${me.email}> in the ${envs[env].name}`);
  console.log(`  shared-path access: ${acc.level} (${levels.PLAIN[acc.level]})${mayMerge ? '; may merge' : ''}\n`);
  return 0;
}

// snapshot <env> <set> <id>: READ a view, form, sitemap or flow as it stands now and save its definition
// for editing (DESIGN.md §10e). The hash goes into the component job's `snapshot_hash`, so a plan made from
// this read is refused if anyone changes the component in between. Nothing is written to Dataverse.
function cmdSnapshot(run, deps, args) {
  const [env, set, id] = args;
  const { envs } = config();
  const component = require('./lib/component');
  if (!envs[env] || !Object.prototype.hasOwnProperty.call(component.SETS, set) || !/^[0-9a-f-]{36}$/i.test(String(id || ''))) {
    throw new Refusal('usage', 'snapshot', [`snapshot <env> <set> <id>; env one of ${Object.keys(envs).join(', ')}; set one of ${Object.keys(component.SETS).join(', ')}; id the component's GUID`], { exitCode: 2 });
  }
  run.env = env;
  refuseIfExposed([storeExposure()]);
  const dv = connect(run, deps, 'read', envs[env].host);
  const snap = component.readSnapshot(dv, set, id.toLowerCase());
  // A flow holding a secret in plain text is never copied to disk (10/7 third pass): the same refusal as
  // its plan, naming where the secret sits, never its value.
  if (set === 'workflows' && snap.definition.clientdata) {
    let cd = null;
    try { cd = typeof snap.definition.clientdata === 'string' ? JSON.parse(snap.definition.clientdata) : snap.definition.clientdata; } catch { cd = null; }
    const where = cd ? component.flowSecrets(cd) : [];
    if (where.length) throw new Refusal('not_permitted', 'snapshot', [`the flow holds a secret in plain text (${where.join(', ')}); move it to a Secret environment variable first. Nothing was saved.`]);
  }
  const file = path.join(dir('jobs'), `snapshot-${env}-${set}-${snap.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ env, set, ...snap }, null, 2), 'utf8');
  console.log(`\n${snap.name || snap.id} (${set}) in the ${envs[env].name}`);
  console.log(`  snapshot_hash: ${snap.hash}`);
  console.log(`  definition saved for editing: ${file}`);
  console.log('Nothing was changed. Put the hash in the component job; a change made since this read refuses the plan.\n');
  return 0;
}

// query <app> <table> [--select a,b] [--filter "..."] [--orderby "..."] [--expand "..."] [--max N] [--csv] [--name x]:
// a READ-ONLY bulk read into a file for the person's Claude to process with a script (lib/query.js; 1.11.8, Dylan
// 10/9/26: "especially daian will need to do reads over hundreds of rows"). Only the count, columns and path are
// printed, never the rows. Same sign-in and permissions as every other read. Nothing is written to Dataverse.
const QUERY_USAGE = 'query <app> <table set> [--select col,col] [--filter "<OData filter>"] [--orderby "<col> desc"] [--expand "<nav>($select=...)"] [--max N] [--csv] [--name label]';

function cmdQuery(run, deps, args) {
  const query = require('./lib/query');
  const { pos, opt } = options(args, ['select', 'filter', 'orderby', 'expand', 'max', 'csv', 'name']);
  const [env, set, extra] = pos;
  const { envs } = config();
  const bad = query.validate({ env, set, opt, envs });
  if (extra !== undefined) bad.push(`unexpected "${extra}": put the query in --select / --filter / --orderby / --expand`);
  if (bad.length) throw new Refusal('usage', 'query', [...bad, QUERY_USAGE], { exitCode: 2, nothing: 'read' });
  run.env = env;
  const dir = query.readsDir();
  const exposed = query.exposure(dir);
  if (exposed) throw new Refusal('client_info_exposed', 'query', [exposed, 'Point SBRM_DV_READS at a folder outside git and OneDrive.'], { nothing: 'read' });
  const purged = query.purge(dir);
  const dv = connect(run, deps, 'read', envs[env].host);
  let result;
  try {
    result = query.read(dv, set, opt);
  } catch (e) {
    if (e instanceof DataverseError) throw new Refusal('bad_query', 'query', [e.message, 'Check the table set, column and filter names (the describe tool lists them).'], { nothing: 'read' });
    throw e;
  }
  const file = query.save(dir, { env, set, opt, result });
  const cols = query.columns(result.rows);
  console.log(`\nRead ${result.rows.length} rows of ${set} from the ${envs[env].name} into:\n  ${file}`);
  if (result.truncated) console.log(`  Stopped at --max ${result.max}: more rows exist. Narrow the filter or raise --max.`);
  console.log(`  Columns (${cols.length}): ${cols.slice(0, 40).join(', ')}${cols.length > 40 ? ', ...' : ''}`);
  console.log(`Nothing was changed. Read the file with a script, not into the chat. Files in ${dir} are deleted after ${query.KEEP_DAYS} days${purged ? ` (${purged} older file(s) deleted now)` : ''}.\n`);
  return 0;
}

// "--name value" options after the positional arguments.
function options(args, names) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < args.length; i += 1) {
    const m = /^--([a-z-]+)$/.exec(args[i]);
    if (m && names.includes(m[1])) { opt[m[1]] = args[i + 1] === undefined || /^--/.test(args[i + 1]) ? true : args[(i += 1)]; }
    else if (m) throw new Refusal('usage', 'usage', [`unknown option --${m[1]}`], { exitCode: 2 });
    else pos.push(args[i]);
  }
  return { pos, opt };
}

function pendingLogCount() {
  return fs.readdirSync(dir('pending')).filter((f) => f.endsWith('.json')).length;
}

function toolkitConfig() {
  try { return readJson(path.join(configDir(), 'toolkit.json')); } catch { return {}; }
}

function cmdDoctor(run, deps, args = []) {
  const { envs, access } = config();
  const { opt } = options(args, ['apps']);
  let apps = null;
  if (opt.apps) {
    apps = String(opt.apps === true ? '' : opt.apps).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = apps.filter((a) => !envs[a]);
    if (!apps.length || unknown.length) throw new Refusal('usage', 'doctor', [`--apps takes app keys separated by commas; one or more of: ${Object.keys(envs).join(', ')}${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`], { exitCode: 2 });
  }
  const dvs = {};
  const conn = (env) => dvs[env] || (dvs[env] = connect(run, deps, 'read', envs[env].host));
  // Apps this machine has written to (its local log): a no-answer there is a failure, not "fine".
  const used = [...new Set(recentLocal(1000).map((e) => e.env).filter((x) => envs[x]))];
  // A machine that chose its apps (lib/apps.js, 1.11.1) is checked in those apps only, plus any it has
  // written to or that --apps names: each app checked is a sign-in, and on a Mac every one can pop up.
  const chosen = require('./lib/apps').read();
  if (chosen && !apps) apps = chosen.filter((a) => envs[a]);
  const checkEnvs = chosen ? Object.fromEntries(Object.entries(envs).filter(([k]) => chosen.includes(k) || used.includes(k) || (apps || []).includes(k))) : envs;
  const result = health.doctor({
    envs: checkEnvs, access, apps, cli: deps.cli, connect: conn, io: deps.io(), pin: toolkitConfig().cli_version || null, guard: deps.guard,
    used,
    chosen: chosen ? chosen.filter((a) => envs[a]) : null,
    profiles: chosen ? (deps.authList || realAuthList)() : null,
    pending: () => ({ events: events.pendingCount(), logs: pendingLogCount() }),
    sendPending: (reached) => {
      for (const env of reached) {
        events.flush(deps.eventConnection(envs[env].host), env);
        if (fs.readdirSync(dir('pending')).some((f) => f.startsWith(`${env}--`))) log.flushPending(deps.writeConnection(envs[env].host), env);
      }
    },
  });
  run.person = result.person;
  run.env = result.reached[0] || null;
  console.log(health.render(result));
  // "4 x Extra Dataverse connection; 2 x Extra Dataverse hook", not the same label four times.
  const counts = new Map();
  for (const c of result.failed) {
    const key = c.label.replace(/:.*$/, '');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const headline = result.failed.length
    ? `Health check: ${result.failed.length} problem(s): ${[...counts].map(([k, v]) => (v > 1 ? `${v} x ${k}` : k)).join('; ')}`
    : 'Health check: pass';
  // A health check is about the MACHINE: filed as env 'machine' (it still goes to the app that answered).
  events.record(run, { kind: 'health check', code: result.code, headline, env: 'machine' });
  return result.failed.length ? 1 : 0;
}

// The env a report belongs to: --env, the plan's, this machine's latest Write Log entry, else the first.
function reportEnv(envs, opt) {
  if (opt.env) {
    if (!envs[opt.env]) throw new Refusal('usage', 'report', [`unknown env "${opt.env}"; one of: ${Object.keys(envs).join(', ')}`], { exitCode: 2 });
    return opt.env;
  }
  if (opt.plan) {
    try { return loadPlan(opt.plan).record.env; } catch { /* applied or not on this machine */ }
    const e = readLocal(opt.plan);
    if (e && envs[e.env]) return e.env;
  }
  const latest = recentLocal(1)[0];
  return latest && envs[latest.env] ? latest.env : Object.keys(envs)[0];
}

function recentLocal(n) {
  const logDir = dir('log');
  const all = [];
  for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith('.md'))) {
    try { all.push(...readEntries(path.join(logDir, f))); } catch { /* skip */ }
  }
  return all.sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, n);
}

function recentEvents(n) {
  try {
    return fs.readFileSync(path.join(dir('events'), 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).slice(-n).reverse();
  } catch { return []; }
}

// Send what is waiting for this env and read back the number the table gave the event (null = still on
// this machine).
function sendAndNumber(run, deps, envs, env, ev) {
  try {
    const dv = connect(run, deps, 'read', envs[env].host);
    const sent = events.flush(deps.eventConnection(envs[env].host), env);
    if (sent.error) return null;
    const hit = (dv.get(`${events.EVENT_SET}?$select=sbrm_number&$filter=${encodeURIComponent(`sbrm_eventid eq '${ev.event_id}'`)}`).value || [])[0];
    return hit ? hit.sbrm_number : null;
  } catch { return null; /* stays on this machine; said by the caller */ }
}

function recentContext() {
  const recentBlocks = blocks.recent(5);
  return [
    'Recent events on this machine (newest first):',
    ...(recentEvents(5).map((e) => `  ${e.time}  ${e.kind}  ${e.reason_code || ''}  ${e.headline}`)),
    '', 'Recent writes on this machine (newest first):',
    ...(recentLocal(3).map((e) => `  ${e.time}  ${e.headline}  ${e.outcome}  plan ${e.plan_id}`)),
    '', 'Guard blocks on this machine, last 24 hours (newest first):',
    ...(recentBlocks.length ? recentBlocks.map(blocks.line) : ['  none']),
  ];
}

// `report --blocked <id> "<what Claude was doing>"` (1.11.6, DESIGN.md §11): filed by the person's Claude, on
// its own, when the guard blocked a call it judges legitimate. The block's own record (the call as the guard
// saw it, the rule, the folder, the version) is attached from this machine; the sentence is Claude's and is
// labelled so, never presented as the person's words. One report per block.
function reportBlock(run, deps, id, words, opt) {
  const b = blocks.find(id);
  if (!b) throw new Refusal('usage', 'report', [`no guard block ${id} is recorded on this machine (the id is in the block message: B-<date>-<time>-<6 letters>)`], { exitCode: 2 });
  const earlier = blocks.reported(id);
  if (earlier) {
    run.reported = true;
    console.log(`\nBlock ${id} was already reported (${earlier.time}). Nothing new was filed.\n`);
    return 0;
  }
  const { envs } = config();
  const env = b.env && envs[b.env] ? b.env : reportEnv(envs, opt);
  run.env = env;
  const said = words || '(Claude gave no description)';
  const context = [
    'Filed by the person\'s Claude after a guard block it judged legitimate. The description is Claude\'s, not the person\'s words.',
    `Claude's description: ${said}`, '',
    blocks.describe(b), '',
    ...recentContext(),
  ].join('\n');
  const ev = events.record(run, {
    kind: 'blocked by guard', code: 'false_block', words: `Claude: ${said}`,
    headline: `Guard block looks wrong [${b.rule}]: ${b.tool}, toolkit ${b.toolkit}`, detail: context, extra: { block_id: id, block_rule: b.rule },
  });
  run.reported = true;
  const number = sendAndNumber(run, deps, envs, env, ev);
  if (number) console.log(`\nReported as ${number}: the blocked call, the rule and the toolkit version are attached for Dylan.\n`);
  else console.log('\nReport saved on this machine; it is sent (and gets its number) the next time this machine reaches Dataverse.\n');
  return 0;
}

function cmdReport(run, deps, args) {
  const { pos, opt } = options(args, ['plan', 'env', 'blocked']);
  const words = pos.join(' ').trim();
  if (opt.blocked !== undefined) {
    if (opt.blocked === true) throw new Refusal('usage', 'report', ['name the block: report --blocked <block id> "<what you were doing>"'], { exitCode: 2 });
    return reportBlock(run, deps, String(opt.blocked), words, opt);
  }
  if (!words) throw new Refusal('usage', 'report', ['say what went wrong, in the person\'s own words: report "<words>"'], { exitCode: 2 });
  const { envs } = config();
  const env = reportEnv(envs, opt);
  run.env = env;
  if (opt.plan) run.planId = String(opt.plan);
  const context = [`Their words: ${words}`, '', ...recentContext()].join('\n');
  const ev = events.record(run, { kind: 'report', code: 'report', words, headline: `Report: "${words.slice(0, 150)}"`, detail: context });
  run.reported = true; // finish() stays quiet: this command says where the report went itself
  const number = sendAndNumber(run, deps, envs, env, ev);
  if (number) {
    console.log(`\nReported as ${number}. It carries the person's words, the recent runs on this machine and the versions.`);
    console.log(`Dylan sees it in his review. If it's urgent, message him and mention ${number}.\n`);
  } else {
    console.log('\nReport saved on this machine; it is sent (and gets its number) the next time this machine reaches Dataverse.');
    console.log('If it\'s urgent, message Dylan directly: nothing here can notify him.\n');
  }
  return 0;
}

const LETTER_ENV = { D: 'donorapp', H: 'hgs', R: 'recovery', S: 'soberliving', F: 'fedev' };

// One environment's Write Log and events, in review's shape (createdby resolved to email + name).
function readEnvRows(dv, env, since) {
  const users = new Map();
  const who = (id) => {
    if (!id) return { email: null, name: 'unknown' };
    if (!users.has(id)) {
      try {
        const u = dv.get(`systemusers(${id})?$select=fullname,internalemailaddress`);
        users.set(id, { email: String(u.internalemailaddress || '').toLowerCase(), name: u.fullname });
      } catch { users.set(id, { email: null, name: id }); }
    }
    return users.get(id);
  };
  const win = encodeURIComponent(`createdon ge ${since}`);
  const logs = (dv.get(`sbrm_dataversewritelogs?$select=sbrm_planid,sbrm_name,sbrm_outcome,sbrm_written,sbrm_notwritten,sbrm_leftout,_createdby_value,createdon&$filter=${win}`).value || [])
    .map((r) => ({ env, ...who(r._createdby_value), time: r.createdon, planid: r.sbrm_planid, headline: r.sbrm_name, outcome: r.sbrm_outcome, written: r.sbrm_written, notwritten: r.sbrm_notwritten, leftout: r.sbrm_leftout }));
  const evFilter = encodeURIComponent(`createdon ge ${since} or sbrm_status eq 'open'`);
  const evs = (dv.get(`sbrm_dataverseevents?$select=sbrm_number,sbrm_name,sbrm_kind,sbrm_reasoncode,sbrm_signal,sbrm_status,sbrm_words,sbrm_planid,sbrm_versions,sbrm_machine,_createdby_value,createdon&$filter=${evFilter}`).value || [])
    .map((r) => ({ env, ...who(r._createdby_value), time: r.createdon, number: r.sbrm_number, kind: r.sbrm_kind, code: r.sbrm_reasoncode, signal: !!r.sbrm_signal, status: r.sbrm_status, headline: r.sbrm_name, words: r.sbrm_words, planid: r.sbrm_planid, versions: r.sbrm_versions, machine: r.sbrm_machine }));
  return { logs, events: evs };
}

function cmdReview(run, deps, args) {
  const { opt } = options(args, ['days', 'brief']);
  const days = opt.days ? Number(opt.days) : 7;
  if (!Number.isInteger(days) || days < 1) throw new Refusal('usage', 'review', ['--days must be a whole number of days'], { exitCode: 2 });
  const { envs, access } = config();
  const now = new Date();
  // Read far enough back for the silence rule, whatever the window.
  const since = new Date(now - Math.max(days, 60) * 24 * 3600 * 1000).toISOString();
  const logs = [];
  const lists = [];
  const evs = [];
  const notes = [];
  for (const [env, info] of Object.entries(envs)) {
    try {
      const dv = connect(run, deps, 'read', info.host);
      if (!run.env) run.env = env;
      const got = readEnvRows(dv, env, since);
      try { lists.push(resolveAccess(access, dv, env)); } catch (e) { notes.push(`Could not read the ${info.name} Write Access list: ${e.message.slice(0, 120)}`); }
      logs.push(...got.logs);
      evs.push(...got.events);
    } catch (e) {
      notes.push(`Could not read the ${info.name}: ${e.message.slice(0, 160)}`);
    }
  }
  const people = {};
  for (const r of [...logs, ...evs]) if (r.email) people[r.email] = r.name;
  const s = review.summarize({ now, days, access: mergeAccessLists(lists), logs, events: evs, people, toolkit: blocks.toolkitVersion() });
  if (opt.brief) console.log(review.brief(s) + (notes.length ? ` (${notes.length} app(s) could not be read)` : ''));
  else {
    console.log('\n' + review.render(s, { generatedBy: run.person ? run.person.fullname : null }));
    for (const n of notes) console.log(`\n!! ${n}`);
    console.log('');
  }
  return notes.length === Object.keys(envs).length ? 1 : 0;
}

// `apps` shows, `apps donorapp,fedev` sets, `apps all` clears which apps this machine opens a read
// connection to (lib/apps.js, 1.11.1). Narrows reads only; grants nothing. Takes effect at the next start.
function cmdApps(run, deps, args) {
  const { envs } = config();
  const appsLib = require('./lib/apps');
  const arg = (args[0] || '').trim();
  if (!arg) {
    const now = appsLib.read();
    console.log(`\nRead connections on this machine: ${now ? now.map((a) => envs[a] ? envs[a].name : a).join(', ') : 'every app'}.\n`);
    return 0;
  }
  if (arg === 'all') {
    appsLib.clear();
    console.log('\nThis machine will connect to every app. Quit Claude Code completely and reopen it for this to take effect.\n');
    return 0;
  }
  const list = [...new Set(arg.split(',').map((s) => s.trim()).filter(Boolean))];
  const unknown = list.filter((a) => !envs[a]);
  if (!list.length || unknown.length) throw new Refusal('usage', 'apps', [`apps <keys separated by commas> | all; one or more of: ${Object.keys(envs).join(', ')}${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`], { exitCode: 2, nothing: 'changed' });
  appsLib.write(list);
  console.log(`\nThis machine will connect to: ${list.map((a) => envs[a].name).join(', ')}. The other apps' connections stay switched off (nothing signs in to them).`
    + '\nQuit Claude Code completely and reopen it for this to take effect.\n');
  return 0;
}

const RESOLUTIONS = ['fixed', 'not a bug', 'access granted', "won't fix"];

function cmdResolve(run, deps, args) {
  const { pos, opt } = options(args, ['fixed-in']);
  const [number, resolution, ...rest] = pos;
  const note = rest.join(' ').trim();
  const m = /^([DHRSF])-(\d{4,})$/.exec(String(number || '').toUpperCase());
  const okResolution = RESOLUTIONS.includes(resolution) || /^duplicate of [DHRSF]-\d{4,}$/i.test(String(resolution || ''));
  if (!m || !okResolution || !note) {
    throw new Refusal('usage', 'resolve', [`resolve <number> <resolution> "<note>" [--fixed-in <version>]; number like D-1003; resolution one of: ${RESOLUTIONS.join(', ')}, "duplicate of D-1001"`], { exitCode: 2 });
  }
  const { envs, access } = config();
  const env = LETTER_ENV[m[1]];
  if (!envs[env]) throw new Refusal('usage', 'resolve', [`${number}: no ${env} in the toolkit's environment list`], { exitCode: 2 });
  run.env = env;
  const dv = connect(run, deps, 'write', envs[env].host);
  const me = whoAmI(dv);
  run.person = me;
  if (!levels.atLeast(accessFor(resolveAccess(access, dv, env), me.email, env).level, 'admin')) {
    throw new Refusal('not_permitted', 'resolve', [`only a toolkit admin resolves (ruled 10/7); ${me.fullname} is not an admin in the ${envs[env].name}`], { nothing: 'changed' });
  }
  const want = `${m[1]}-${m[2]}`;
  const hits = dv.get(`${events.EVENT_SET}?$select=sbrm_dataverseeventid,sbrm_name,sbrm_status&$filter=${encodeURIComponent(`sbrm_number eq '${want}'`)}`).value || [];
  if (hits.length !== 1) throw new Refusal('not_found', 'resolve', [`${want}: ${hits.length ? 'more than one row has that number' : 'no such item'} in the ${envs[env].name}`], { nothing: 'changed' });
  const id = hits[0].sbrm_dataverseeventid;
  const now = dv.get(`${events.EVENT_SET}(${id})?$select=sbrm_status,sbrm_name,sbrm_kind,sbrm_machine,_createdby_value,createdon`);
  if (now.sbrm_status !== 'open') throw new Refusal('not_open', 'resolve', [`${want} is not open (status: ${now.sbrm_status || 'none'})`], { nothing: 'changed' });
  // A health check describes the machine NOW: resolving one also closes the same person's earlier open
  // checks on the same machine (the review folds them under it; the pop-up lists every number).
  const repeats = now.sbrm_kind !== 'health check' ? [] : (dv.get(`${events.EVENT_SET}?$select=sbrm_dataverseeventid,sbrm_number,sbrm_kind,sbrm_machine,_createdby_value,createdon&$filter=${encodeURIComponent("sbrm_status eq 'open'")}`).value || [])
    .filter((r) => r.sbrm_dataverseeventid !== id && r.sbrm_kind === 'health check' && r._createdby_value === now._createdby_value
      && (r.sbrm_machine || '') === (now.sbrm_machine || '') && new Date(r.createdon) < new Date(now.createdon))
    .sort((a, b) => new Date(a.createdon) - new Date(b.createdon));
  const body = { sbrm_status: 'resolved', sbrm_resolution: resolution.toLowerCase(), sbrm_resolutionnote: note };
  if (opt['fixed-in'] && opt['fixed-in'] !== true) body.sbrm_fixedinversion = String(opt['fixed-in']);
  const text = [`Resolve ${want} in the ${envs[env].name}`, '', `  ${now.sbrm_name}`, '', `Resolution: ${body.sbrm_resolution}`, `Note: ${note}`,
    ...(body.sbrm_fixedinversion ? [`Fixed in: ${body.sbrm_fixedinversion}`] : []),
    ...(repeats.length ? ['', `Also closes the same machine's earlier health checks: ${repeats.map((r) => r.sbrm_number).join(', ')}`] : [])].join('\n');
  console.log(`\n${text}`);
  const answer = approvalFor(deps, `resolve-${want}`)({ summaryText: text, detailText: text, title: `SBRM: resolve ${want}?` });
  if (!answer.approved) { console.log(`\nCancelled. ${want} is still open.\n`); return 1; }
  dv.update(events.EVENT_SET, id, body, now['@odata.etag']);
  const back = dv.get(`${events.EVENT_SET}(${id})?$select=sbrm_status,sbrm_resolution`);
  if (back.sbrm_status !== 'resolved') throw new Error(`${want} did not read back as resolved (status ${back.sbrm_status})`);
  const also = [];
  for (const r of repeats) {
    const cur = dv.get(`${events.EVENT_SET}(${r.sbrm_dataverseeventid})?$select=sbrm_status`);
    if (cur.sbrm_status !== 'open') continue;
    dv.update(events.EVENT_SET, r.sbrm_dataverseeventid, { ...body, sbrm_resolutionnote: `${note} (closed with ${want}: same machine, earlier run)` }, cur['@odata.etag']);
    if (dv.get(`${events.EVENT_SET}(${r.sbrm_dataverseeventid})?$select=sbrm_status`).sbrm_status === 'resolved') also.push(r.sbrm_number);
  }
  console.log(`\n${want} resolved: ${back.sbrm_resolution}. Recorded on the item (resolved by ${me.fullname}).${also.length ? ` Also closed: ${also.join(', ')}.` : ''}\n`);
  return 0;
}

const USAGE = 'usage: dataverse-write.js check|plan <job.json> | show <plan-id> | apply <plan-id> [<plan-id> ...] | revert <plan-id> [env] | whoami <env> | snapshot <env> <set> <id> | doctor [--apps a,b] | report "<words>" | review [--days N] [--brief] | resolve <number> <resolution> "<note>" | apps [a,b | all] | query <app> <table> [--select ...] [--filter ...] [--max N] [--csv]';

function dispatch(run, deps, argv) {
  const [cmd, arg, arg2] = argv;
  const need = (x) => { if (!x) throw new Refusal('usage', 'usage', [USAGE], { exitCode: 2 }); return x; };
  switch (cmd) {
    case 'check': return cmdCheck(run, deps, need(arg));
    case 'plan': return cmdPlan(run, deps, need(arg));
    case 'show': return cmdShow(run, deps, need(arg));
    case 'whoami': return cmdWhoami(run, deps, need(arg));
    case 'snapshot': return cmdSnapshot(run, deps, argv.slice(1));
    case 'apply': return cmdApply(run, deps, need(arg));
    case 'revert': return cmdRevert(run, deps, need(arg), arg2);
    case 'doctor': return cmdDoctor(run, deps, argv.slice(1));
    case 'report': return cmdReport(run, deps, argv.slice(1));
    case 'review': return cmdReview(run, deps, argv.slice(1));
    case 'resolve': return cmdResolve(run, deps, argv.slice(1));
    case 'apps': return cmdApps(run, deps, argv.slice(1));
    case 'query': return cmdQuery(run, deps, argv.slice(1));
    default: throw new Refusal('usage', 'usage', [USAGE], { exitCode: 2 });
  }
}

// ---- the one place a refusal or crash is printed and recorded ----

function failure(run, e) {
  let kind = 'refused';
  let code = e && e.code;
  let headline;
  let exitCode = 1;
  if (e instanceof Refusal) {
    console.log(`\nREFUSED: ${e.title}. Nothing was ${e.nothing}.\n`);
    for (const r of e.reasons) console.log(`  ${r}`);
    console.log('');
    headline = `Refused (${e.title}): ${e.reasons[0] || ''}`;
    exitCode = e.exitCode;
  } else if (e instanceof PlanRefused) {
    console.log('\nREFUSED: the plan. Nothing was planned.\n');
    for (const r of e.reasons) console.log(`  ${r}`);
    console.log('');
    headline = `Refused: ${e.reasons[0] || ''}`;
  } else if (e instanceof ApplyRefused) {
    console.log(`\nREFUSED: ${e.message}\nNothing was written.\n`);
    headline = `Refused at apply: ${e.message.split('\n')[0]}`;
  } else if (code === 'access_unreadable') {
    console.log(`\nREFUSED: ${e.message}\nNothing was written.\n`);
    headline = `Refused: ${e.message.split('(')[0].trim()}`;
  } else if (code === 'no_plan') {
    console.log(`\nREFUSED: ${e.message}\nNothing was written.\n`);
    headline = `Refused: ${e.message}`;
  } else if (code === 'cli_missing' || code === 'cli_blocked') {
    kind = 'setup problem';
    console.log(`\nERROR: ${e.message}\nNothing was written.\n`);
    headline = e.message;
  } else if (e instanceof DataverseError) {
    kind = 'crash';
    code = 'dataverse_error';
    console.log(`\nERROR from Dataverse: ${e.message}\nNothing was written.\n`);
    headline = `Dataverse error: ${e.message}`;
  } else {
    kind = 'crash';
    code = 'crash';
    console.log(`\nERROR: ${e && e.message}\nNothing was written.\n`);
    headline = `Unexpected error: ${e && e.message}`;
  }
  const detailText = run.output.join('\n') + (kind === 'crash' && e && e.stack ? `\n\n${e.stack}` : '');
  // `check` is Claude's own file-level lint before a plan: its refusals are not events (10/7 review: four
  // throwaway checks queued four events for the review). A crash in check is still recorded. `query` (1.11.8)
  // likewise: a misspelt column or filter is Claude iterating on a read, not something for Dylan's review.
  if (!(/^(?:check|query)(?:\s|$)/.test(run.command || '') && kind !== 'crash')) events.record(run, { kind, code: code || 'unclassified', headline, detail: detailText });
  return exitCode;
}

// Send what is waiting, through the connection this run already proved works. Never changes the
// outcome: a send failure leaves the events on this machine for the next run.
function finish(run, deps) {
  let sent = null;
  if (run.connected && run.env && events.pendingFor(run.env).length) {
    try {
      const { envs } = config();
      if (envs[run.env]) sent = events.flush(deps.eventConnection(envs[run.env].host), run.env);
    } catch (e) {
      sent = { sent: 0, left: 1, error: e.message };
    }
  }
  if (run.events.length && !run.reported) {
    const landed = sent && !sent.error;
    console.log(landed
      ? "(Recorded for Dylan's review.)"
      : "(Recorded for Dylan's review: saved on this machine, and sent the next time it can reach Dataverse. If it's urgent, message Dylan.)");
  }
  return sent;
}

// Returns the exit code, or a Promise of it when the command is async (merges). Sync commands behave
// exactly as before; either way every refusal and crash goes through failure() and finish().
function runCli(argv, deps = DEFAULT_DEPS) {
  const run = events.newRun(argv);
  reportInterrupted(run); // an earlier apply on this machine that was cut off part-way
  reportGuardDown(run); // the guard could not run here since the last engine run
  const original = console.log;
  console.log = (...a) => { run.output.push(a.join(' ')); original(...a); };
  const done = (code) => {
    try {
      finish(run, deps);
    } finally {
      console.log = original;
    }
    module.exports.lastRun = run;
    return code;
  };
  let result;
  try {
    result = dispatch(run, deps, argv);
  } catch (e) {
    try { result = failure(run, e); } catch (e2) { console.log = original; throw e2; }
  }
  if (result && typeof result.then === 'function') {
    return result.then((code) => code, (e) => failure(run, e)).then(done, (e) => { console.log = original; throw e; });
  }
  return done(result);
}

// `apply <id> <id> ...` (1.11.0, ruled 10/8: one approval may cover several plans): Claude Code asks once
// for the whole line and the guard mints a ticket per plan; each plan then runs as its own apply, in the
// order given, with its own run, refusals and Write Log entry. Exit code: the worst of them.
async function runBatch(argv, deps = DEFAULT_DEPS) {
  if (argv[0] !== 'apply' || argv.length <= 2) return runCli(argv, deps);
  let worst = 0;
  const ids = argv.slice(1);
  // Every plan's ticket is taken NOW, so a long first plan cannot make the last one's expire.
  if (!deps.confirm) deps = { ...deps, approved: new Map(ids.map((id) => [id, (deps.ticket || ticket).take(id)])) };
  for (const [i, id] of ids.entries()) {
    console.log(`\n=== Plan ${i + 1} of ${ids.length}: ${id}`);
    worst = Math.max(worst, await runCli(['apply', id], deps));
  }
  return worst;
}

if (require.main === module) {
  // A WRITE from the real command line uses the real store and settings, never a moved one: a plan file
  // in a folder the guard does not protect could have been edited (10/7 review). Tests drive runCli()
  // in-process with their own temp store; that path is not this one.
  const verb = process.argv[2];
  // The same for the CLI it writes through (10/7 final re-verify: a substitute "CLI" named by the override
  // sees every request after the pop-up and could change the server or the body).
  if (['apply', 'resolve'].includes(verb) && (process.env.SBRM_DV_HOME || process.env.SBRM_DV_CONFIG || process.env.SBRM_DATAVERSE_CLI)) {
    console.log(`\nREFUSED: ${verb} runs only with the engine's own store, settings and Dataverse CLI (SBRM_DV_HOME / SBRM_DV_CONFIG / SBRM_DATAVERSE_CLI are set). Nothing was written.\n`);
    process.exit(1);
  }
  Promise.resolve()
    .then(() => runBatch(process.argv.slice(2)))
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      // Only reachable if recording itself failed (the store cannot be written).
      console.error(`\nERROR: ${e.message}\nNothing more was written. (This could not be recorded either.)\n`);
      process.exitCode = 1;
    });
}

module.exports = { main: runCli, runCli, runBatch, Refusal, lastRun: null };
