'use strict';
// The app development kinds through the REAL command line (DESIGN.md §10): check, plan, show, apply (the
// pop-up stubbed), the Write Log row, revert. The module tests (schema.test.js, component.test.js) drive the
// modules directly; this proves the CLI wiring: dispatch by kind, the access read from the Write Access
// table, warn_rows from toolkit.json, the readEnv for the "tried in Donor App Dev first?" check, the log.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-cliapp-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
process.env.SBRM_DV_CONFIG = path.join(HOME, 'config');
fs.mkdirSync(process.env.SBRM_DV_CONFIG, { recursive: true });

const S = require('./fake_schema');
const K = require('./fake_component');
const C = require('../lib/component');

function writeConfig(envs, warnRows = 50) {
  fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'), JSON.stringify(envs));
  fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'toolkit.json'), JSON.stringify({ warn_rows: warnRows }));
}

// A builder's fake, plus the toolkit's own tables as the CLI reads and writes them: the Write Access rows
// (from that fake's ACCESS fixture), Write Log rows (create + look-up by plan id), nothing else changed.
function withToolkitTables(dv, access, env) {
  const logs = [];
  const rows = Object.entries(access.people).filter(([, p]) => p.envs[env])
    .map(([email, p]) => ({ sbrm_email: email, sbrm_level: p.envs[env], sbrm_merge: false, statecode: 0 }));
  const get = dv.get.bind(dv);
  const create = dv.create ? dv.create.bind(dv) : null;
  dv.get = (p, o) => {
    if (/^sbrm_dataversewriteaccesses\?/.test(p)) return { value: rows };
    const m = /^sbrm_dataversewritelogs\?\$select=[^&]+&\$filter=(.*)$/.exec(p);
    if (m) {
      const id = (/sbrm_planid eq '([^']+)'/.exec(decodeURIComponent(m[1])) || [])[1];
      const mine = logs.filter((r) => r.sbrm_planid === id);
      return mine.length ? { value: mine } : get(p, o);
    }
    return get(p, o);
  };
  dv.create = (set, body, opts) => {
    if (set === 'sbrm_dataversewritelogs') { logs.push(body); return {}; }
    return create(set, body, opts);
  };
  dv.logs = logs;
  return dv;
}

const cli = require('../dataverse-write');
const events = [];
function deps(dv, over = {}) {
  return {
    readConnection: () => dv, writeConnection: () => dv, confirm: () => ({ approved: true }),
    eventConnection: () => ({ createEvent: (b) => { events.push(b); return {}; } }),
    cli: () => ({ version: '1.0.81' }), io: () => ({ home: HOME, cwd: HOME, read: () => null }), guard: () => ({ present: true, blocksBypass: true }),
    ...over,
  };
}
async function go(argv, d) {
  const real = console.log;
  console.log = () => {};
  try {
    const code = await cli.runCli(argv, d);
    return { code, run: cli.lastRun, out: cli.lastRun.output.join('\n') };
  } finally { console.log = real; }
}
let n = 0;
function file(obj) {
  n += 1;
  const f = path.join(HOME, `job-${n}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('kind schema through the CLI: check, plan (warnings first), show, apply with the pop-up, logged, revert', async () => {
  writeConfig(S.ENVS);
  const dv = withToolkitTables(S.fakeSchemaDv(), S.ACCESS, 'fedev');
  const job = file({
    contract: 'sbrm-dv-job/1', kind: 'schema', env: 'fedev', solution: { uniquename: 'SBRMAdHoc' }, source: 'claude-session', reason: 'A new note column.',
    intent: { verb: 'develop', solution: 'SBRMAdHoc', objects: { columns: 2 } },
    objects: { columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh' }, { action: 'update', table: 'sbrm_widget', column: 'sbrm_code', set: { display: 'Widget Code' } }] },
  });
  assert.equal((await go(['check', job], deps(dv))).code, 0);
  const planned = await go(['plan', job], deps(dv));
  assert.equal(planned.code, 0, planned.out);
  assert.match(planned.out, /Before you approve:/);
  assert.match(planned.out, /! Lasting: /, 'a new column is lasting');
  const id = planned.run.planId;
  const shown = await go(['show', id], deps(dv));
  assert.equal(shown.code, 0);
  let popup = null;
  const applied = await go(['apply', id], deps(dv, { confirm: (x) => { popup = x; return { approved: true }; } }));
  assert.equal(applied.code, 0, applied.out);
  assert.match(popup.summaryText, /^Before you approve:/);
  assert.equal(dv.logs.length, 1);
  assert.equal(dv.logs[0].sbrm_mode, 'schema');
  assert.equal(dv.logs[0].sbrm_planid, id);
  // Undo: the label goes back; the new column stays (only an admin delete removes it).
  const undo = await go(['revert', id, 'fedev'], deps(dv));
  assert.equal(undo.code, 0, undo.out);
  assert.match(undo.out, new RegExp(`Undo of plan ${id}`));
});

test('kind schema through the CLI: a writer is refused and the refusal is recorded', async () => {
  writeConfig(S.ENVS);
  const dv = withToolkitTables(S.fakeSchemaDv({ email: 'writer@example.org' }), S.ACCESS, 'fedev');
  const job = file({
    contract: 'sbrm-dv-job/1', kind: 'schema', env: 'fedev', solution: { uniquename: 'SBRMAdHoc' }, source: 'claude-session', reason: 'x.',
    intent: { verb: 'develop', solution: 'SBRMAdHoc', objects: { columns: 1 } },
    objects: { columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh' }] },
  });
  const r = await go(['plan', job], deps(dv));
  assert.equal(r.code, 1);
  assert.match(r.out, /takes develop access/);
  assert.equal(r.run.events[0].reason_code, 'not_permitted');
});

test('kind component through the CLI: snapshot, plan (Not tried in Donor App Dev first), apply, logged, revert', async () => {
  writeConfig(K.ENVS);
  const dv = withToolkitTables(K.fakeComponentDv({ email: 'dev@example.org' }), K.ACCESS, 'donorapp');
  // The read Claude builds from: the snapshot command saves the definition and prints the hash.
  const snap = await go(['snapshot', 'donorapp', 'savedqueries', K.IDS.view], deps(dv));
  assert.equal(snap.code, 0, snap.out);
  const hash = /snapshot_hash: ([0-9a-f]{64})/.exec(snap.out)[1];
  assert.equal(hash, C.snapshot('savedqueries', dv.data.savedqueries[K.IDS.view]).hash);
  const layout = K.LAYOUT.replace('<cell name="fullname" width="300" /><cell name="emailaddress1" width="150" />', '<cell name="emailaddress1" width="150" /><cell name="fullname" width="300" />');
  const job = file({
    contract: 'sbrm-dv-job/1', kind: 'component', env: 'donorapp', source: 'claude-session', reason: 'Email first.',
    component: { set: 'savedqueries', id: K.IDS.view, name: 'Active Donors' }, mode: 'update', definition: { layoutxml: layout }, snapshot_hash: hash,
    intent: { verb: 'update', component: 'view', name: 'Active Donors', changed: ['columns'] },
  });
  const planned = await go(['plan', job], deps(dv, { readConnection: () => dv }));
  assert.equal(planned.code, 0, planned.out);
  assert.match(planned.out, /! Not tried in Donor App Dev first/);
  const id = planned.run.planId;
  const applied = await go(['apply', id], deps(dv));
  assert.equal(applied.code, 0, applied.out);
  assert.equal(dv.logs.length, 1);
  assert.equal(dv.logs[0].sbrm_mode, 'component');
  const undo = await go(['revert', id, 'donorapp'], deps(dv));
  assert.equal(undo.code, 0, undo.out);
});

test('snapshot refuses a bad set or id without reading anything', async () => {
  writeConfig(K.ENVS);
  const dv = withToolkitTables(K.fakeComponentDv(), K.ACCESS, 'donorapp');
  const r = await go(['snapshot', 'donorapp', 'contacts', K.IDS.view], deps(dv));
  assert.equal(r.code, 2);
  assert.match(r.out, /snapshot <env> <set> <id>/);
});

test('snapshot never saves a flow that holds a plain-text secret (1.10.1)', async () => {
  writeConfig(K.ENVS);
  const dv = withToolkitTables(K.fakeComponentDv({ email: 'dev@example.org' }), K.ACCESS, 'donorapp');
  const r = await go(['snapshot', 'donorapp', 'workflows', K.IDS.secretflow], deps(dv));
  assert.equal(r.code, 1);
  assert.match(r.out, /holds a secret in plain text .*Nothing was saved/);
  const jobs = path.join(process.env.SBRM_DV_HOME, 'jobs');
  assert.ok(!fs.existsSync(jobs) || !fs.readdirSync(jobs).some((f) => f.includes(K.IDS.secretflow)), 'no file written');
});
