'use strict';
// A component create that makes its own NEW solution (1.11.41, Dylan 11/18/26: the Bed Board page goes in a new solution,
// "Another toolkit release"). `solution` on a create may be {uniquename, friendlyname}: an existing SBRM solution is used
// as before; a missing one is created under the environment's SBRM publisher in the same apply, just before the
// component, as a schema job already does. A bare string still names an existing solution only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-newsol-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const C = require('../lib/component');
const { fakeComponentDv, IDS, ENVS, b64 } = require('./fake_component');

const ENVS_NODEV = { ...ENVS, soberliving: { host: 'https://donor.invalid', name: 'Sober Living app', publisher: IDS.pub } };
const ACCESS = { people: { 'admin@example.org': { envs: { soberliving: 'admin' } }, 'dev@example.org': { envs: { soberliving: 'develop' } } } };
const ctx = (over = {}) => ({ envs: ENVS_NODEV, access: ACCESS, warnRows: 50, readEnv: () => { throw new Error('no dev read expected'); }, ...over });
const dvAs = (who = 'admin', over = {}) => fakeComponentDv({ email: `${who}@example.org`, ...over });

const NAME = 'sbrm_/BedBoard/BedBoard.html';
const PAGE = '<!DOCTYPE html>\n<html><body><p>Beds</p></body></html>\n';
const NEW_SOL = { uniquename: 'SBRMRecoveryBedBoard', friendlyname: 'SBRM Recovery Bed Board' };

function job({ solution = NEW_SOL, name = NAME, ...rest } = {}) {
  return {
    contract: 'sbrm-dv-job/1', kind: 'component', env: 'soberliving', source: 'claude-session', reason: 'A page that shows every bed.',
    component: { set: 'webresourceset', name }, mode: 'create', solution,
    definition: { content: b64(PAGE), webresourcetype: 1, displayname: 'Bed Board' },
    intent: { verb: 'create', component: 'web resource', name }, ...rest,
  };
}
const errs = (raw) => C.validateComponentJob(raw, { envs: ENVS_NODEV }).errors.join('\n');
function valid(raw) {
  const r = C.validateComponentJob(raw, { envs: ENVS_NODEV });
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  return r.job;
}
const nonGets = (dv) => dv.calls.filter((c) => c.method !== 'GET');
const solRows = (dv, u) => dv.data.solutions.filter((s) => s.uniquename.toLowerCase() === u.toLowerCase());

let fileN = 0;
async function applied(plan, dv, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await C.applyComponent({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, sleep: () => {}, ...over,
  }, { id: `20261118-1600${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown };
}

test('a create may name its solution as {uniquename, friendlyname}; a bare string still works; other modes take neither', () => {
  assert.deepEqual(valid(job()).solution, 'SBRMRecoveryBedBoard');
  assert.equal(valid(job()).solution_friendlyname, 'SBRM Recovery Bed Board');
  assert.equal(valid(job({ solution: 'SBRMAdHocChanges' })).solution_friendlyname, null);
  assert.equal(valid(job({ solution: { uniquename: 'SBRMAdHocChanges' } })).solution_friendlyname, null);
  assert.match(errs(job({ solution: { uniquename: 'Bad Name', friendlyname: 'x' } })), /"solution\.uniquename" must be letters, digits and _/);
  assert.match(errs(job({ solution: { uniquename: 'SBRMX', friendlyname: '' } })), /"solution\.friendlyname" must be one line of text/);
  assert.match(errs(job({ solution: { uniquename: 'SBRMX', friendlyname: 'a\nb' } })), /"solution\.friendlyname" must be one line of text/);
  assert.match(errs(job({ solution: { uniquename: 'SBRMX', friendlyname: 'x'.repeat(257) } })), /at most 256 characters/);
  assert.match(errs(job({ solution: { uniquename: 'SBRMX', friendlyname: 'X', version: '2' } })), /unknown key "solution\.version"/);
  assert.match(errs(job({ solution: ['SBRMX'] })), /"solution" is required for a create/);
});

test('plan: a missing solution with a friendly name is created by this change, and the prompt says so; reads only', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(job()), ctx());
  assert.deepEqual(nonGets(dv), []);
  assert.deepEqual(plan.solution, { id: null, uniquename: 'SBRMRecoveryBedBoard', name: 'SBRM Recovery Bed Board', create: true, publisher: IDS.pub });
  const summary = C.componentSummary(plan);
  assert.match(summary, /Create the web resource 'sbrm_\/BedBoard\/BedBoard\.html' in the Sober Living app in solution SBRM Recovery Bed Board \(a new solution, made by this change\)/);
  assert.match(summary, /creates the solution 'SBRM Recovery Bed Board' \(SBRMRecoveryBedBoard\) under the SBRM publisher/);
  assert.match(C.componentDetail(plan), /Solution: SBRM Recovery Bed Board \(SBRMRecoveryBedBoard\), created by this change/);
});

test('plan: a missing solution named only by its unique name is refused, as before', async () => {
  const dv = dvAs('admin');
  await assert.rejects(C.planComponent(dv, valid(job({ solution: 'SBRMRecoveryBedBoard' })), ctx()), /there is no solution "SBRMRecoveryBedBoard"/);
  await assert.rejects(C.planComponent(dv, valid(job({ solution: { uniquename: 'SBRMRecoveryBedBoard' } })), ctx()), /there is no solution "SBRMRecoveryBedBoard"/);
});

test('plan: an object naming an EXISTING SBRM solution uses it (no new solution); a managed or foreign one is refused', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(job({ solution: { uniquename: 'SBRMAdHocChanges', friendlyname: 'whatever' } })), ctx());
  assert.equal(plan.solution.create, false);
  assert.equal(plan.solution.uniquename, 'SBRMAdHocChanges');
  assert.doesNotMatch(C.componentSummary(plan), /new solution/);
  await assert.rejects(C.planComponent(dv, valid(job({ solution: { uniquename: 'msdynce_Fundraising', friendlyname: 'x' } })), ctx()), /managed/);
  await assert.rejects(C.planComponent(dv, valid(job({ solution: { uniquename: 'Crfb496', friendlyname: 'x' } })), ctx()), /not under the SBRM publisher/);
});

test('plan: making a new solution is a develop change on its own; the web resource still needs admin', async () => {
  const dv = dvAs('dev');
  await assert.rejects(C.planComponent(dv, valid(job()), ctx()), /takes admin access .*\(a new web resource\)/);
});

test('apply: the solution is POSTed under the SBRM publisher, read back, then the web resource is created in it and published', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(job()), ctx());
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows[0]));
  const w = nonGets(dv);
  assert.equal(w.length, 3);
  assert.equal(w[0].method, 'POST');
  assert.equal(w[0].path, 'solutions');
  assert.deepEqual(w[0].body, {
    uniquename: 'SBRMRecoveryBedBoard', friendlyname: 'SBRM Recovery Bed Board', version: '1.0.0.0',
    description: "Made through the SBRM toolkit's app development path (Shared Dataverse Write). First change: A page that shows every bed.",
    'publisherid@odata.bind': `/publishers(${IDS.pub})`,
  });
  assert.equal(w[1].path, 'webresourceset');
  assert.equal(w[1].solution, 'SBRMRecoveryBedBoard');
  assert.equal(w[2].path, 'PublishXml');
  const s = solRows(dv, 'SBRMRecoveryBedBoard');
  assert.equal(s.length, 1);
  assert.equal(s[0]._publisherid_value, IDS.pub);
  assert.match(res.rows[0].notes.join(' '), /created the solution 'SBRM Recovery Bed Board' \(SBRMRecoveryBedBoard\)/);
  assert.equal(res.entry.rows[0].new_solution, 'SBRMRecoveryBedBoard');
});

test('apply: a solution of that name made since the plan (or while the prompt was open) is refused, nothing written', async () => {
  for (const when of ['before', 'during']) {
    const dv = dvAs('admin');
    const plan = await C.planComponent(dv, valid(job()), ctx());
    const make = () => dv.data.solutions.push({ solutionid: '50000000-0000-0000-0000-000000000009', uniquename: 'SBRMRecoveryBedBoard', friendlyname: 'Someone', ismanaged: false, _publisherid_value: IDS.pub });
    if (when === 'before') make();
    let asked = 0;
    const confirm = () => { asked += 1; if (when === 'during') make(); return { approved: true }; };
    await assert.rejects(applied(plan, dv, { confirm }), (e) => {
      assert.equal(e.name, 'ApplyRefused', when);
      assert.match(e.message, when === 'before' ? /the solution SBRMRecoveryBedBoard now exists \(made since the plan\)/ : /the solution SBRMRecoveryBedBoard was made while the approval was waiting/, when);
      return true;
    });
    assert.equal(asked, when === 'before' ? 0 : 1, `${when}: a change already refused is never put to the person`);
    assert.deepEqual(nonGets(dv), [], when);
  }
});

test('apply: a solution that reads back under another publisher stops before the web resource is created', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(job()), ctx());
  dv.solutionPublisherOnCreate = IDS.otherpub;
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /failed: the solution SBRMRecoveryBedBoard did not read back as an unmanaged SBRM solution/);
  assert.equal(nonGets(dv).filter((c) => c.path === 'webresourceset').length, 0, 'no web resource created');
});

test('apply: when the web resource create fails after the solution was made, the outcome says the empty solution stays', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(job()), ctx());
  dv.failCreateOf = 'webresourceset';
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /^failed: /);
  assert.match(res.rows[0].notes.join(' '), /the solution 'SBRM Recovery Bed Board' \(SBRMRecoveryBedBoard\) was created and stays \(empty\)/);
});

// ---------- review 2026-11-18_new_solution (Codex seat) ----------

const { DataverseError } = require('../lib/cli');

test('review F1: a solution POST that timed out never adopts a same-named solution someone else made meanwhile', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(job()), ctx());
  dv.timeoutOnWrite = 'before'; // the solution POST times out and does not land
  const inner = dv.metadata;
  dv.metadata = (...a) => {
    dv.data.solutions.push({ solutionid: '50000000-0000-0000-0000-000000000077', uniquename: 'SBRMRecoveryBedBoard', friendlyname: 'Someone else', description: 'theirs', ismanaged: false, _publisherid_value: IDS.pub });
    return inner(...a);
  };
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /failed: the solution SBRMRecoveryBedBoard did not read back as the one this change made/);
  assert.equal(nonGets(dv).filter((c) => c.path === 'webresourceset').length, 0, 'nothing put in their solution');
});

test('review F1 (control): a solution POST that timed out but DID land is found and used', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(job()), ctx());
  dv.timeoutOnWrite = 'after';
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows[0]));
  assert.equal(solRows(dv, 'SBRMRecoveryBedBoard').length, 1);
});

test('review F2: an existing solution swapped for another while the approval was waiting is refused, nothing written', async () => {
  for (const solution of ['SBRMAdHocChanges', { uniquename: 'SBRMAdHocChanges', friendlyname: 'x' }]) {
    const dv = dvAs('admin');
    const plan = await C.planComponent(dv, valid(job({ solution })), ctx());
    const confirm = () => {
      dv.data.solutions = dv.data.solutions.filter((s) => s.uniquename !== 'SBRMAdHocChanges');
      dv.data.solutions.push({ solutionid: '50000000-0000-0000-0000-000000000088', uniquename: 'SBRMAdHocChanges', friendlyname: 'Foreign', ismanaged: false, _publisherid_value: IDS.otherpub });
      return { approved: true };
    };
    await assert.rejects(applied(plan, dv, { confirm }), /the solution SBRMAdHocChanges changed while the approval was waiting/);
    assert.deepEqual(nonGets(dv), [], JSON.stringify(solution));
  }
});

test('review F3: a solution POST that succeeded but could not be read back is said in the outcome', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(job()), ctx());
  const realGet = dv.get;
  dv.get = (p, o) => {
    if (dv.calls.some((c) => c.path === 'solutions' && c.method === 'POST') && /^solutions\?/.test(p)) throw new DataverseError('The service is temporarily unavailable', { code: '0x80072322', status: 503 });
    return realGet(p, o);
  };
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].notes.join(' '), /the solution 'SBRM Recovery Bed Board' \(SBRMRecoveryBedBoard\) was sent and may exist; look for it in the maker portal before planning again/);
  assert.equal(nonGets(dv).filter((c) => c.path === 'webresourceset').length, 0);
});

test('a plan file edited to make a solution under another publisher, or with a bad name, is refused', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(job()), ctx());
  assert.deepEqual(C.planShapeProblems(plan), []);
  for (const tampered of [
    { ...plan, solution: { ...plan.solution, publisher: 'not-a-guid' } },
    { ...plan, solution: { ...plan.solution, uniquename: 'Bad Name' } },
    { ...plan, solution: { ...plan.solution, name: 'a\nb' } },
    { ...plan, mode: 'update', solution: plan.solution },
  ]) {
    assert.notDeepEqual(C.planShapeProblems(tampered), [], JSON.stringify(tampered.solution));
  }
});
