'use strict';
// 1.11.39 review F1 (reviews/2026-11-18_undated_plan): the apply dispatcher read the plan file once for the record it
// applies and AGAIN for the signature check, so a file changed between the reads was applied unsigned. Now one read
// gives both. Deterministic stand-in for the race: the FIRST read of the plan file returns a changed copy, every later
// read returns the signed original (see the read count below).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-oneread-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
process.env.SBRM_DV_CONFIG = path.join(HOME, 'config');
fs.mkdirSync(process.env.SBRM_DV_CONFIG, { recursive: true });

const S = require('./fake_schema');
const { dir } = require('../lib/store');

function withToolkitTables(dv, access, env) {
  const logs = [];
  const rows = Object.entries(access.people).filter(([, p]) => p.envs[env])
    .map(([email, p]) => ({ sbrm_email: email, sbrm_level: p.envs[env], sbrm_merge: false, statecode: 0 }));
  const get = dv.get.bind(dv);
  const create = dv.create ? dv.create.bind(dv) : null;
  dv.get = (p, o) => (/^sbrm_dataversewriteaccesses\?/.test(p) ? { value: rows } : get(p, o));
  dv.create = (set, body, opts) => (set === 'sbrm_dataversewritelogs' ? (logs.push(body), {}) : create(set, body, opts));
  dv.logs = logs;
  return dv;
}

const cli = require('../dataverse-write');
function deps(dv) {
  return {
    readConnection: () => dv, writeConnection: () => dv, confirm: () => ({ approved: true }),
    eventConnection: () => ({ createEvent: () => ({}) }),
    cli: () => ({ version: '1.0.81' }), io: () => ({ home: HOME, cwd: HOME, read: () => null }), guard: () => ({ present: true, blocksBypass: true }),
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

test('apply (app kind): the record applied is the one whose signature was checked, one read only', async () => {
  fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'), JSON.stringify(S.ENVS));
  fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'toolkit.json'), JSON.stringify({ warn_rows: 50 }));
  const dv = withToolkitTables(S.fakeSchemaDv(), S.ACCESS, 'fedev');
  const job = path.join(HOME, 'job.json');
  fs.writeFileSync(job, JSON.stringify({
    contract: 'sbrm-dv-job/1', kind: 'schema', env: 'fedev', solution: { uniquename: 'SBRMAdHoc' }, source: 'claude-session', reason: 'A new note column.',
    intent: { verb: 'develop', solution: 'SBRMAdHoc', objects: { columns: 1 } },
    objects: { columns: [{ table: 'sbrm_widget', type: 'text', schema_name: 'sbrm_Fresh', display: 'Fresh' }] },
  }));
  const planned = await go(['plan', job], deps(dv));
  assert.equal(planned.code, 0, planned.out);
  const id = planned.run.planId;
  const planFile = path.join(dir('plans'), `${id}.json`);
  const signed = fs.readFileSync(planFile, 'utf8');
  // The changed copy: the same plan, its date moved back past 24 hours, NOT re-signed.
  const changed = JSON.stringify({ ...JSON.parse(signed), created: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, null, 2);
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patched(f, ...rest) {
    // Read 1 is cmdApply's (env + in-flight marker only); read 2 is applyAny's, the record it applies. The race
    // F1 names is a change between that read and the signature check, so read 2 is the changed copy.
    if (path.resolve(String(f)) === path.resolve(planFile)) { reads += 1; return reads === 2 ? changed : signed; }
    return realRead.call(fs, f, ...rest);
  };
  let applied;
  try { applied = await go(['apply', id], deps(dv)); } finally { fs.readFileSync = realRead; }
  assert.equal(applied.code, 1, applied.out);
  const codes = applied.run.events.map((e) => e.reason_code);
  // Before the fix the signature check read the original (intact) while the changed record was applied: refused as
  // stale_plan, i.e. the UNSIGNED record reached apply. Now the read that is checked is the read that is applied.
  assert.ok(codes.includes('plan_tampered'), `refused as tampered, got ${codes.join(',')}: ${applied.out}`);
  assert.equal(dv.logs.length, 0, 'nothing written');
});

// Same race through the merge branch (it had no tampered-plan test at all before 1.11.39).
async function applyWithSecondReadChanged(id, d) {
  const planFile = path.join(dir('plans'), `${id}.json`);
  const signed = fs.readFileSync(planFile, 'utf8');
  const changed = JSON.stringify({ ...JSON.parse(signed), created: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, null, 2);
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patched(f, ...rest) {
    if (path.resolve(String(f)) === path.resolve(planFile)) { reads += 1; return reads === 2 ? changed : signed; }
    return realRead.call(fs, f, ...rest);
  };
  try { return await go(['apply', id], d); } finally { fs.readFileSync = realRead; }
}

test('apply (merge): the record applied is the one whose signature was checked, one read only', async () => {
  const { fakeDv, IDS } = require('./fake');
  fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'), JSON.stringify({
    donorapp: { host: 'https://example.invalid', name: 'Donor App', hipaa: false, closed_year: { msnfp_transactions: 'msnfp_bookdate' } },
  }));
  const dv = fakeDv();
  const d = {
    readConnection: () => dv, writeConnection: () => dv, confirm: () => ({ approved: true }),
    eventConnection: () => ({ createEvent: (b) => dv.create('sbrm_dataverseevents', b) }),
    cli: () => ({ version: '1.0.34' }), io: () => ({ home: HOME, cwd: HOME, read: () => null }),
  };
  const job = path.join(HOME, 'merge-job.json');
  fs.writeFileSync(job, JSON.stringify({
    contract: 'sbrm-dv-job/1', kind: 'merge', env: 'donorapp', table: 'accounts', source: 'test', reason: 'A copy of Acme.',
    intent: { verb: 'merge', pairs: 1, table: 'accounts' },
    pairs: [{ keep: { id: IDS.acme, name: 'Acme Foundation' }, duplicate: { id: IDS.acme2, name: 'Acme Foundation, Inc.' }, fill_blank: ['telephone1'] }],
  }));
  const planned = await go(['plan', job], d);
  assert.equal(planned.code, 0, planned.out);
  const applied = await applyWithSecondReadChanged(planned.run.planId, d);
  assert.equal(applied.code, 1, applied.out);
  const codes = applied.run.events.map((e) => e.reason_code);
  assert.ok(codes.includes('plan_tampered'), `refused as tampered, got ${codes.join(',')}: ${applied.out}`);
  assert.ok(!dv.calls.some((c) => c.method !== 'GET' && !/^sbrm_dataverse(events|writelogs)/.test(c.path)), 'no data written');
});
