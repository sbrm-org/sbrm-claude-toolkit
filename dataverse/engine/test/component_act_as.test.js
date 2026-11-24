'use strict';
// A flow written ON BEHALF OF the account that owns its connections (TEST SLICE, 11/19/26; Dylan: "do the test").
// Power Automate lets only that account save or turn on such a flow (Recovery R-1324, 11/16; reproduced in Donor App
// Dev 11/19, plan 20261119-154350-19b2345a). `"act_as": "connection_owner"` on a flow create, update, on or off sends
// the one write with Dataverse's on-behalf-of header. Admin only; the account must be on the environment's own list
// of service accounts (a Write Access row with level "service"); who it is comes from live reads at plan AND apply.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-actas-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const C = require('../lib/component');
const A = require('../lib/access');
const W = require('../lib/write');
const { fakeComponentDv, IDS, OIDS, ENVS, flowCd, REF } = require('./fake_component');

const SERVICE = { fedev: ['appadmin@example.org'] };
const PEOPLE = { 'admin@example.org': { envs: { fedev: 'admin' } }, 'dev@example.org': { envs: { fedev: 'develop' } } };
const ACCESS = { people: PEOPLE, service: SERVICE };
const ctx = (over = {}) => ({ envs: ENVS, access: ACCESS, warnRows: 50, readEnv: () => { throw new Error('no dev read expected'); }, ...over });
// The flow under test: 'Add Soft Credit', on SBRM App Admin's Dataverse connection, switched OFF first.
function dvAs(who = 'admin', { off = true, ...over } = {}) {
  const dv = fakeComponentDv({ email: `${who}@example.org`, host: 'https://dev.invalid', ...over });
  if (off) Object.assign(dv.data.workflows[IDS.flow], { statecode: 0, statuscode: 1 });
  dv.data.callbackregistrations = off ? [] : dv.data.callbackregistrations;
  return dv;
}
const NAME = 'Add Soft Credit';
const base = (rest) => ({ contract: 'sbrm-dv-job/1', kind: 'component', env: 'fedev', source: 'claude-session', reason: 'Test the flow as its connection owner.', ...rest });
function editedCd() {
  const cd = flowCd();
  cd.properties.definition.actions.Compose_total.inputs = 'changed by the test';
  return cd;
}
function updateJob(dv, { act_as = 'connection_owner', cd = editedCd(), ...rest } = {}) {
  const hash = C.snapshot('workflows', dv.data.workflows[IDS.flow]).hash;
  return base({ component: { set: 'workflows', id: IDS.flow, name: NAME }, mode: 'update', definition: { clientdata: cd }, snapshot_hash: hash,
    intent: { verb: 'update', component: 'flow', name: NAME, changed: ['actions'] }, ...(act_as ? { act_as } : {}), ...rest });
}
function stateJob(dv, mode, { act_as = 'connection_owner', id = IDS.flow, name = NAME } = {}) {
  const hash = C.snapshot('workflows', dv.data.workflows[id]).hash;
  return base({ component: { set: 'workflows', id, name }, mode, snapshot_hash: hash, intent: { verb: mode, component: 'flow', name }, ...(act_as ? { act_as } : {}) });
}
function createJob({ act_as = 'connection_owner', name = 'New Flow As Owner', solution = 'SBRMAdHocChanges' } = {}) {
  const cd = flowCd();
  cd.properties.definition.actions.Compose_total.description = 'Holds the total.';
  return base({ component: { set: 'workflows', name }, mode: 'create', solution, definition: { clientdata: cd, description: 'Made by the test.' },
    intent: { verb: 'create', component: 'flow', name }, ...(act_as ? { act_as } : {}) });
}
const errs = (raw) => C.validateComponentJob(raw, { envs: ENVS }).errors.join('\n');
function valid(raw) {
  const r = C.validateComponentJob(raw, { envs: ENVS });
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  return r.job;
}
async function refused(promise, re, name = 'PlanRefused') {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, name, e.stack);
    assert.match(e.message, re);
    return true;
  });
}
const nonGets = (dv) => dv.calls.filter((c) => c.method !== 'GET');
let fileN = 0;
async function applied(plan, dv, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await C.applyComponent({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, sleep: () => {}, ...over,
  }, { id: `20261119-1700${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown };
}
const TARGET = { id: IDS.appadmin, name: 'SBRM App Admin', email: 'appadmin@example.org', object_id: OIDS.appadmin };

test('the job: act_as may only be "connection_owner", on a flow create, update, on or off, into an existing solution', () => {
  const dv = dvAs();
  assert.equal(valid(updateJob(dv)).act_as, 'connection_owner');
  assert.equal(valid(updateJob(dv, { act_as: null })).act_as, null);
  assert.equal(valid(stateJob(dv, 'on')).act_as, 'connection_owner');
  assert.equal(valid(stateJob(dv, 'off')).act_as, 'connection_owner');
  assert.equal(valid(createJob()).act_as, 'connection_owner');
  assert.match(errs(updateJob(dv, { act_as: 'SBRM App Admin' })), /"act_as" may only be "connection_owner"/);
  assert.match(errs(updateJob(dv, { act_as: OIDS.appadmin })), /"act_as" may only be "connection_owner"/);
  assert.match(errs(updateJob(dv, { act_as: true })), /"act_as" may only be "connection_owner"/);
  assert.match(errs({ ...stateJob(dv, 'own'), owner: IDS.dev2 }), /"act_as" is for a flow create, update, on or off, not "own"/);
  assert.match(errs(stateJob(dv, 'delete')), /"act_as" is for a flow create, update, on or off, not "delete"/);
  assert.match(errs(createJob({ solution: { uniquename: 'SBRMNew', friendlyname: 'New' } })), /goes in an existing solution/);
  const view = dv.data.savedqueries[IDS.view];
  assert.match(errs(base({ component: { set: 'savedqueries', id: IDS.view, name: view.name }, mode: 'update', definition: { layoutxml: view.layoutxml },
    snapshot_hash: C.snapshot('savedqueries', view).hash, intent: { verb: 'update', component: 'view', name: view.name, changed: ['columns'] }, act_as: 'connection_owner' })), /"act_as" is for flows only/);
});

test('the access list: a "service" row is a service account, never a person with a level', () => {
  const rows = [
    { sbrm_name: 'Admin', sbrm_email: 'Admin@Example.org', sbrm_level: 'admin', sbrm_merge: true },
    { sbrm_name: 'SBRM App Admin', sbrm_email: ' AppAdmin@Example.org ', sbrm_level: ' Service ', sbrm_merge: true },
    { sbrm_name: 'Typo', sbrm_email: 'typo@example.org', sbrm_level: 'services', sbrm_merge: false },
  ];
  const got = A.readAccess({ get: () => ({ value: rows }) }, 'fedev');
  assert.deepEqual(Object.keys(got.people).sort(), ['admin@example.org', 'typo@example.org']);
  assert.equal(got.people['typo@example.org'].envs.fedev, 'read');
  assert.deepEqual(got.service, { fedev: ['appadmin@example.org'] });
  assert.deepEqual([...A.serviceAccounts(got, 'fedev')], ['appadmin@example.org']);
  assert.deepEqual([...A.serviceAccounts(got, 'donorapp')], []);
  assert.deepEqual([...A.serviceAccounts({ people: {} }, 'fedev')], []);
  assert.deepEqual([...A.serviceAccounts(null, 'fedev')], []);
  const merged = A.mergeAccessLists([got, { people: {}, service: { donorapp: ['x@example.org'] } }]);
  assert.deepEqual(merged.service, { fedev: ['appadmin@example.org'], donorapp: ['x@example.org'] });
  assert.equal(merged.people['appadmin@example.org'], undefined);
});

test('the write module: the on-behalf-of header is a GUID, on a flow only, and absent when nothing asks for it', () => {
  assert.deepEqual(W.behalfHeader('workflows', undefined), []);
  assert.deepEqual(W.behalfHeader('workflows', null), []);
  assert.deepEqual(W.behalfHeader('contacts', null), []);
  assert.deepEqual(W.behalfHeader('workflows', OIDS.appadmin.toUpperCase()), [`CallerObjectId: ${OIDS.appadmin}`]);
  assert.throws(() => W.behalfHeader('contacts', OIDS.appadmin), /outside a cloud flow/);
  assert.throws(() => W.behalfHeader('savedqueries', OIDS.appadmin), /outside a cloud flow/);
  assert.throws(() => W.behalfHeader('workflows', `${OIDS.appadmin}\r\nX-Other: 1`), /not a GUID/);
  assert.throws(() => W.behalfHeader('workflows', 'appadmin@example.org'), /not a GUID/);
  assert.throws(() => W.behalfHeader('workflows', ''), /not a GUID/);
});

test('the real write connection hands the header to the CLI on a flow create and update, and on nothing else', () => {
  // A stand-in CLI: Node itself, started in a folder whose `api.js` records the arguments it was given.
  const T = require('../lib/ticket');
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-actas-cli-'));
  fs.writeFileSync(path.join(stub, 'api.js'), "require('fs').writeFileSync(require('path').join(__dirname, 'argv.json'), JSON.stringify(process.argv.slice(2))); console.log('{}');\n");
  const sent = () => JSON.parse(fs.readFileSync(path.join(stub, 'argv.json'), 'utf8'));
  const headers = (argv) => argv.flatMap((a, i) => (argv[i - 1] === '--header' ? [a] : []));
  const PLAN = '20261119-170000-abcdef12';
  T.mint(PLAN);
  const { approval } = T.take(PLAN);
  const was = process.cwd();
  process.chdir(stub);
  try {
    const dv = W.writeConnection('https://example.invalid', { binary: process.execPath, version: 'stub' }, { approval });
    dv.create('workflows', { name: 'x' }, { solution: 'SBRMAdHocChanges', behalf: OIDS.appadmin });
    assert.deepEqual(headers(sent()), ['Prefer: return=representation', 'MSCRM.SolutionUniqueName: SBRMAdHocChanges', `CallerObjectId: ${OIDS.appadmin}`]);
    dv.update('workflows', IDS.flow, { statecode: 1 }, '*', { behalf: OIDS.appadmin });
    assert.deepEqual(headers(sent()), ['If-Match: *', `CallerObjectId: ${OIDS.appadmin}`]);
    // nothing asks: no header
    dv.create('workflows', { name: 'x' }, { solution: 'SBRMAdHocChanges' });
    assert.deepEqual(headers(sent()), ['Prefer: return=representation', 'MSCRM.SolutionUniqueName: SBRMAdHocChanges']);
    dv.update('workflows', IDS.flow, { statecode: 1 }, '*');
    assert.deepEqual(headers(sent()), ['If-Match: *']);
    // any other table: refused before anything is sent
    fs.rmSync(path.join(stub, 'argv.json'));
    assert.throws(() => dv.create('contacts', { lastname: 'x' }, { behalf: OIDS.appadmin }), /outside a cloud flow/);
    assert.throws(() => dv.update('sbrm_dataversewriteaccesses', IDS.flow, { sbrm_level: 'admin' }, '*', { behalf: OIDS.appadmin }), /outside a cloud flow/);
    assert.equal(fs.existsSync(path.join(stub, 'argv.json')), false);
  } finally {
    process.chdir(was);
  }
});

test('plan: a flow with a connection the person who runs it supplies has no single owner to write as', async () => {
  const dv = dvAs('admin');
  const cd = editedCd();
  cd.properties.connectionReferences.shared_runner = { ...REF('sbrm_dataverse_appadmin'), runtimeSource: 'invoker' };
  const j = updateJob(dv, { cd });
  j.intent.changed = ['actions', 'connections'];
  await refused(C.planComponent(dv, valid(j), ctx()), /has a connection with no single owner \(one the person who runs it supplies/);
});

test('apply: the one retry Dataverse sometimes needs (R-1309) is sent as the connection owner too', async () => {
  const dv = dvAs('admin');
  dv.refuseExactTag = true;
  const { res } = await applied(await C.planComponent(dv, valid(updateJob(dv)), ctx()), dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  assert.deepEqual(nonGets(dv).map((c) => [c.method, c.etag === '*', c.behalf]), [['PATCH', false, OIDS.appadmin], ['PATCH', true, OIDS.appadmin]]);
});

test('plan: an admin, a flow on a listed service account\'s connections; the prompt names the account; reads only', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(updateJob(dv)), ctx());
  assert.deepEqual(nonGets(dv), []);
  assert.deepEqual(plan.act_as, TARGET);
  assert.equal(plan.need, 'admin');
  assert.ok(plan.need_why.includes('it is written as SBRM App Admin, not as you'), plan.need_why.join('; '));
  assert.match(C.componentHeadline(plan), /^Change the flow 'Add Soft Credit' in the Donor App Dev, written as SBRM App Admin$/);
  const summary = C.componentSummary(plan);
  assert.match(summary, /Before you approve:[\s\S]*Can't be fully undone: the flow 'Add Soft Credit' is written as SBRM App Admin, on your behalf; undo here writes as you/);
  assert.match(summary, /Written as: SBRM App Admin, on your behalf\. Dataverse keeps both names on the flow\./);
  assert.match(C.componentDetail(plan), /Written as: SBRM App Admin \(appadmin@example\.org\), on behalf of Test Person/);
  assert.deepEqual(C.planShapeProblems(plan), []);
  // the same job without act_as plans as before: no account, no line, no header later
  const plain = await C.planComponent(dv, valid(updateJob(dv, { act_as: null })), ctx());
  assert.equal(plain.act_as, null);
  assert.doesNotMatch(C.componentSummary(plain), /Written as|written as/);
});

test('plan: refused for anyone but an admin, and for any account that is not a listed service account', async () => {
  const dev = dvAs('dev');
  await refused(C.planComponent(dev, valid(updateJob(dev)), ctx()), /takes admin access in the Donor App Dev; Test Person has develop/);
  const dv = dvAs('admin');
  // no service row in this environment
  await refused(C.planComponent(dv, valid(updateJob(dv)), ctx({ access: { people: PEOPLE } })), /SBRM App Admin owns this flow's connection references but is not on the Donor App Dev's list of service accounts/);
  await refused(C.planComponent(dv, valid(updateJob(dv)), ctx({ access: { people: PEOPLE, service: { donorapp: ['appadmin@example.org'] } } })), /is not on the Donor App Dev's list of service accounts/);
  // a row for someone else does not cover this owner
  await refused(C.planComponent(dv, valid(updateJob(dv)), ctx({ access: { people: PEOPLE, service: { fedev: ['dana@example.org'] } } })), /is not on the Donor App Dev's list of service accounts/);
  // a PERSON who owns the connections is never written as, unless an admin listed them as a service account
  const d2 = dvAs('admin');
  d2.data.connectionreferences[0]._ownerid_value = IDS.dev2;
  await refused(C.planComponent(d2, valid(updateJob(d2)), ctx()), /Dana Martin owns this flow's connection references but is not on the Donor App Dev's list[\s\S]*A flow is written as another account only when that account is a listed service account/);
  // a disabled owner, and one with no Entra sign-in id
  const d3 = dvAs('admin');
  d3.data.systemusers[IDS.appadmin].isdisabled = true;
  await refused(C.planComponent(d3, valid(updateJob(d3)), ctx()), /is a disabled user/);
  const d4 = dvAs('admin');
  d4.data.systemusers[IDS.appadmin].azureactivedirectoryobjectid = null;
  await refused(C.planComponent(d4, valid(updateJob(d4)), ctx()), /has no Entra sign-in id/);
});

test('plan: refused when the flow has no single connection owner, or the person already owns its connections', async () => {
  // the person's own connections (Sync Letters runs on a connection the signed-in person owns)
  const dv = dvAs('admin');
  await refused(C.planComponent(dv, valid(stateJob(dv, 'on', { id: IDS.offflow, name: 'Sync Letters' })), ctx()), /you own this flow's connection references yourself; leave "act_as" out/);
  // two owners
  const d2 = dvAs('admin');
  const cd = editedCd();
  cd.properties.connectionReferences.shared_second = REF('sbrm_dataverse_owner2');
  const two = updateJob(d2, { cd });
  two.intent.changed = ['actions', 'connections'];
  await refused(C.planComponent(d2, valid(two), ctx()), /belong to more than one account \(SBRM App Admin and Test Person\)/);
  // no connections at all
  const d3 = dvAs('admin');
  const bare = flowCd({ refs: {}, actions: { Compose_total: { runAfter: {}, type: 'Compose', inputs: 'x' } } });
  d3.data.workflows[IDS.flow].clientdata = JSON.stringify(bare);
  await refused(C.planComponent(d3, valid(stateJob(d3, 'on')), ctx()), /uses no connection references, so there is no owner to write it as/);
});

test('apply: the save Power Automate refuses to the person lands when written as the connection owner', async () => {
  // control: as the person, the platform refuses the save (the 11/19 live finding)
  const c = dvAs('admin');
  c.connectionOwnerSaves = true;
  const plain = await applied(await C.planComponent(c, valid(updateJob(c, { act_as: null })), ctx()), c);
  assert.equal(plain.res.outcome, 'applied with problems');
  assert.match(plain.res.rows[0].outcome, /^refused: Power Automate refused: only the owner of this flow's connections \(SBRM App Admin\)/);
  assert.equal(nonGets(c)[0].behalf, undefined);

  const dv = dvAs('admin');
  dv.connectionOwnerSaves = true;
  const plan = await C.planComponent(dv, valid(updateJob(dv)), ctx());
  const { res, shown } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  const writes = nonGets(dv);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].behalf, OIDS.appadmin);
  assert.match(shown[0].summaryText, /Written as: SBRM App Admin, on your behalf/);
  const row = res.rows[0];
  assert.equal(row.outcome, 'written');
  assert.deepEqual(row.written_as, { id: IDS.appadmin, name: 'SBRM App Admin', on_behalf_of: IDS.me, read_back: { by: IDS.appadmin, on_behalf_by: IDS.me, owner: IDS.appadmin } });
  assert.ok(row.notes.includes('written as SBRM App Admin on behalf of Test Person (read back: modified by SBRM App Admin, on behalf of Test Person)'), row.notes.join(' | '));
  assert.deepEqual(res.entry.requested_as, { id: IDS.appadmin, name: 'SBRM App Admin', email: 'appadmin@example.org' });
  assert.equal(res.entry.written_as, undefined, 'the entry carries the request; the read-back is on the row');
  assert.equal(res.entry.person.email, 'admin@example.org'); // who approved it is still the person
  assert.match(res.entry.headline, /written as SBRM App Admin$/);
  assert.match(JSON.parse(dv.data.workflows[IDS.flow].clientdata).properties.definition.actions.Compose_total.inputs, /changed by the test/);
});

test('apply: turning the flow on and off as the connection owner', async () => {
  const dv = dvAs('admin');
  dv.connectionOwnerSaves = true;
  const on = await applied(await C.planComponent(dv, valid(stateJob(dv, 'on')), ctx()), dv);
  assert.equal(on.res.outcome, 'applied', JSON.stringify(on.res.rows));
  assert.equal(dv.data.workflows[IDS.flow].statecode, 1);
  assert.deepEqual(nonGets(dv).map((c) => [c.method, c.behalf, c.etag]), [['PATCH', OIDS.appadmin, '*']]);
  assert.match(on.shown[0].summaryText, /Turn on the flow 'Add Soft Credit' in the Donor App Dev, written as SBRM App Admin/);
  const off = await applied(await C.planComponent(dv, valid(stateJob(dv, 'off')), ctx()), dv);
  assert.equal(off.res.outcome, 'applied', JSON.stringify(off.res.rows));
  assert.equal(dv.data.workflows[IDS.flow].statecode, 0);
  assert.equal(nonGets(dv)[1].behalf, OIDS.appadmin);
  // control: as the person, turning it on is refused
  const c = dvAs('admin');
  c.connectionOwnerSaves = true;
  const plain = await applied(await C.planComponent(c, valid(stateJob(c, 'on', { act_as: null })), ctx()), c);
  assert.match(plain.res.rows[0].outcome, /^refused: Power Automate refused/);
});

test('apply: a new flow is created as, and owned by, the connection owner; a platform that ignores the header is caught', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(createJob()), ctx());
  assert.match(C.componentHeadline(plan), /^Create the flow 'New Flow As Owner' in the Donor App Dev, Off, in solution SBRM Ad-Hoc Changes, written as SBRM App Admin$/);
  assert.match(C.componentSummary(plan), /the new flow belongs to SBRM App Admin/);
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  const post = nonGets(dv)[0];
  assert.deepEqual([post.method, post.path, post.behalf, post.solution], ['POST', 'workflows', OIDS.appadmin, 'SBRMAdHocChanges']);
  const made = dv.data.workflows[res.rows[0].id];
  assert.equal(made._ownerid_value, IDS.appadmin);
  assert.deepEqual(res.rows[0].written_as.read_back, { by: IDS.appadmin, on_behalf_by: IDS.me, owner: IDS.appadmin });
  assert.ok(res.rows[0].notes.some((n) => /read back: created by SBRM App Admin, on behalf of Test Person/.test(n)));

  const bad = dvAs('admin');
  bad.ignoreBehalf = true;
  const r2 = await applied(await C.planComponent(bad, valid(createJob()), ctx()), bad);
  assert.equal(r2.res.outcome, 'applied with problems');
  assert.match(r2.res.rows[0].outcome, /^read-back mismatch: the new flow's owner is 99999999-9999-9999-9999-999999999999, not SBRM App Admin/);
  assert.ok(r2.res.rows[0].notes.some((n) => /asked to be written as SBRM App Admin on behalf of Test Person; the flow reads created by 99999999/.test(n)));
});

test('apply: everything is checked again from live reads; a change since the plan writes nothing', async () => {
  const fresh = async () => { const dv = dvAs('admin'); return { dv, plan: await C.planComponent(dv, valid(updateJob(dv)), ctx()) }; };
  // the service row was removed
  let { dv, plan } = await fresh();
  await refused(applied(plan, dv, { access: { people: PEOPLE } }), /is not on the Donor App Dev's list of service accounts[\s\S]*Nothing was written\.$/, 'ApplyRefused');
  assert.deepEqual(nonGets(dv), []);
  // the person is no longer an admin
  ({ dv, plan } = await fresh());
  await refused(applied(plan, dv, { access: { people: { 'admin@example.org': { envs: { fedev: 'develop' } } }, service: SERVICE } }), /takes admin access; you have develop\. Nothing was written/, 'ApplyRefused');
  assert.deepEqual(nonGets(dv), []);
  // the plan file names another account than the live connection owner
  ({ dv, plan } = await fresh());
  await refused(applied({ ...plan, act_as: { ...plan.act_as, object_id: OIDS.dev2 } }, dv), /would be written as changed since the plan \(now: SBRM App Admin\)/, 'ApplyRefused');
  await refused(applied({ ...plan, act_as: { ...plan.act_as, id: IDS.dev2 } }, dv), /would be written as changed since the plan/, 'ApplyRefused');
  assert.deepEqual(nonGets(dv), []);
  // the owner was disabled since the plan
  ({ dv, plan } = await fresh());
  dv.data.systemusers[IDS.appadmin].isdisabled = true;
  await refused(applied(plan, dv), /is a disabled user; nothing can be written as them\. Nothing was written/, 'ApplyRefused');
  assert.deepEqual(nonGets(dv), []);
});

test('apply: a plan file edited to carry act_as where none belongs is refused as tampered', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(updateJob(dv)), ctx());
  assert.deepEqual(C.planShapeProblems({ ...plan, act_as: { id: IDS.appadmin, name: 'SBRM App Admin', email: 'a@example.org', object_id: 'not-a-guid' } }), ['a write on behalf of an account that is not named properly']);
  assert.deepEqual(C.planShapeProblems({ ...plan, act_as: 'connection_owner' }), ['a write on behalf of an account that is not named properly']);
  assert.deepEqual(C.planShapeProblems({ ...plan, mode: 'own', owner_to: { id: IDS.dev2, name: 'Dana Martin' } }), ['a write on behalf of another account on something that is not a flow create, update, on or off']);
  await refused(applied({ ...plan, act_as: { ...plan.act_as, object_id: 'x' } }, dv), /It was changed after it was made/, 'ApplyRefused');
  // a view plan made to carry it
  const view = dv.data.savedqueries[IDS.view];
  const vjob = base({ component: { set: 'savedqueries', id: IDS.view, name: view.name }, mode: 'update', definition: { description: 'New note.' },
    snapshot_hash: C.snapshot('savedqueries', view).hash, intent: { verb: 'update', component: 'view', name: view.name, changed: ['description'] } });
  const vplan = await C.planComponent(dv, valid(vjob), ctx());
  await refused(applied({ ...vplan, act_as: TARGET }, dv), /a write on behalf of another account on something that is not a flow create, update, on or off/, 'ApplyRefused');
  assert.deepEqual(nonGets(dv), []);
  // an unedited plan that never asked: the write carries no header even where a service account is listed
  const plain = await C.planComponent(dv, valid(updateJob(dv, { act_as: null })), ctx());
  const { res } = await applied(plain, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  assert.equal(nonGets(dv)[0].behalf, undefined);
  assert.equal(res.rows[0].written_as, undefined);
  assert.equal(res.entry.written_as, undefined);
  assert.equal(res.entry.requested_as, undefined);
});

// ---------- round 2 (blind review 11/19/26, receipt reviews\2026-11-19_act_as) ----------

// A read of who the flow was stamped by that fails, for the F1 tests.
function failStampRead(dv) {
  const { DataverseError } = require('../lib/cli');
  const get = dv.get;
  dv.get = (p, o) => {
    if (/_createdonbehalfby_value/.test(String(p))) throw new DataverseError('The request timed out', { code: 'timeout' });
    return get(p, o);
  };
}

test('review F1: a write whose name read-back fails is a read-back mismatch, never "written" (create and update)', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(createJob()), ctx());
  failStampRead(dv);
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /^read-back mismatch: whose name the flow carries could not be read back, so it is not shown to be written as SBRM App Admin/);
  assert.equal(res.rows[0].written_as.read_back, null);
  const d2 = dvAs('admin');
  const p2 = await C.planComponent(d2, valid(updateJob(d2)), ctx());
  failStampRead(d2);
  const r2 = await applied(p2, d2);
  assert.equal(r2.res.outcome, 'applied with problems');
  assert.match(r2.res.rows[0].outcome, /whose name the flow carries could not be read back/);
});

test('review F6: update, on and off under the wrong name are a read-back mismatch, not a note', async () => {
  for (const make of [(dv) => updateJob(dv), (dv) => stateJob(dv, 'on')]) {
    const dv = dvAs('admin');
    dv.ignoreBehalf = true; // the platform drops the header: the write lands as the person
    const { res } = await applied(await C.planComponent(dv, valid(make(dv)), ctx()), dv);
    assert.equal(res.outcome, 'applied with problems', JSON.stringify(res.rows));
    assert.match(res.rows[0].outcome, /^read-back mismatch: the flow reads modified by 99999999-9999-9999-9999-999999999999 on behalf of nobody, not by SBRM App Admin on behalf of Test Person/);
    assert.equal(res.rows[0].written_as.read_back.by, IDS.me);
  }
  const dv = dvAs('admin', { off: false });
  dv.ignoreBehalf = true;
  const off = await applied(await C.planComponent(dv, valid(stateJob(dv, 'off')), ctx()), dv);
  assert.match(off.res.rows[0].outcome, /^read-back mismatch: the flow reads modified by 99999999/);
});

test('review F8: admin, the service list, the owner and the flow are read again after the approval; a change then writes nothing', async () => {
  const waiting = /changed while the approval was waiting/;
  const run = async (job, during, over = {}) => {
    const dv = dvAs('admin');
    const plan = await C.planComponent(dv, valid(job(dv)), ctx());
    let after = false;
    const access = () => (after && over.access ? over.access : ACCESS);
    await refused(applied(plan, dv, { access, confirm: () => { after = true; if (during) during(dv); return { approved: true }; } }), over.re || waiting, 'ApplyRefused');
    assert.deepEqual(nonGets(dv), [], 'nothing was written');
  };
  const update = (dv) => updateJob(dv);
  // the service row is taken away (the test's off switch)
  await run(update, null, { access: { people: PEOPLE }, re: /is not on the Donor App Dev's list of service accounts[\s\S]*changed while the approval was waiting/ });
  await run(() => createJob(), null, { access: { people: PEOPLE } });
  // the person stops being an admin
  await run(update, null, { access: { people: { 'admin@example.org': { envs: { fedev: 'develop' } } }, service: SERVICE }, re: /takes admin access; you have develop \(changed while the approval was waiting\)/ });
  // the connection reference changes hands, or its owner is switched off
  await run(update, (dv) => { dv.data.connectionreferences[0]._ownerid_value = IDS.dev2; }, { re: /Dana Martin owns this flow's connection references but is not on[\s\S]*changed while the approval was waiting/ });
  await run(update, (dv) => { dv.data.systemusers[IDS.appadmin].isdisabled = true; }, { re: /is a disabled user[\s\S]*changed while the approval was waiting/ });
  // the flow itself is switched on, or handed to someone else
  await run(update, (dv) => { Object.assign(dv.data.workflows[IDS.flow], { statecode: 1, statuscode: 2 }); }, { re: /was turned on or off, changed owner, or is no longer a cloud flow \(changed while the approval was waiting\)/ });
  await run((dv) => stateJob(dv, 'on'), (dv) => { dv.data.workflows[IDS.flow]._ownerid_value = IDS.dev2; });
});

test('review F10: the prompt never says both that undo cannot and can be done; turning on names who turns it on', async () => {
  const dv = dvAs('admin');
  for (const job of [updateJob(dv), stateJob(dv, 'on'), createJob()]) {
    const s = C.componentSummary(await C.planComponent(dv, valid(job), ctx()));
    assert.match(s, /Can't be fully undone/);
    assert.doesNotMatch(s, /Can be undone with revert/);
    assert.match(s, /Undo .*, but it is written as you, not as SBRM App Admin: Power Automate may refuse it/);
  }
  const live = dvAs('admin', { off: false });
  const offS = C.componentSummary(await C.planComponent(live, valid(stateJob(live, 'off')), ctx()));
  assert.match(offS, /Undo turns it back on, but it is written as you/);
  const onS = C.componentSummary(await C.planComponent(dv, valid(stateJob(dv, 'on')), ctx()));
  assert.match(onS, /It is turned on as SBRM App Admin, the owner of its connections\./);
  assert.doesNotMatch(onS, /they turn it on themselves/);
  assert.match(C.componentSummary(await C.planComponent(dv, valid(updateJob(dv)), ctx())), /The definition before this change is kept in full in the Write Log/);
  // unchanged without act_as
  assert.match(C.componentSummary(await C.planComponent(dv, valid(updateJob(dv, { act_as: null })), ctx())), /Can be undone with revert: the definition before this change/);
  assert.match(C.componentSummary(await C.planComponent(dv, valid(stateJob(dv, 'on', { act_as: null })), ctx())), /they turn it on themselves/);
});

test('review F11: a cancelled entry carries the request (requested_as) and no claim that anything was written as anyone', async () => {
  const dv = dvAs('admin');
  const { res } = await applied(await C.planComponent(dv, valid(updateJob(dv)), ctx()), dv, { confirm: () => ({ approved: false }) });
  assert.equal(res.outcome, 'cancelled');
  assert.deepEqual(nonGets(dv), []);
  assert.deepEqual(res.entry.requested_as, { id: IDS.appadmin, name: 'SBRM App Admin', email: 'appadmin@example.org' });
  assert.equal(res.entry.written_as, undefined);
  assert.deepEqual(res.entry.rows, []);
});

test('review F15: an email listed as a person AND as a service account is never written as', async () => {
  const both = { people: { ...PEOPLE, 'appadmin@example.org': { envs: { fedev: 'write' } } }, service: SERVICE };
  const dv = dvAs('admin');
  await refused(C.planComponent(dv, valid(updateJob(dv)), ctx({ access: both })), /SBRM App Admin is on the Donor App Dev's Write Access list as a person as well as a service account/);
  // listed properly at plan, a person row added before the apply
  const plan = await C.planComponent(dv, valid(updateJob(dv)), ctx());
  await refused(applied(plan, dv, { access: both }), /as a person as well as a service account[\s\S]*Nothing was written/, 'ApplyRefused');
  assert.deepEqual(nonGets(dv), []);
  // the list as read from the table: both rows for one email put it in both places
  const got = A.readAccess({ get: () => ({ value: [
    { sbrm_name: 'App Admin', sbrm_email: 'appadmin@example.org', sbrm_level: 'write', sbrm_merge: false },
    { sbrm_name: 'App Admin', sbrm_email: 'appadmin@example.org', sbrm_level: 'service', sbrm_merge: false },
  ] }) }, 'fedev');
  assert.ok(got.people['appadmin@example.org'] && A.serviceAccounts(got, 'fedev').has('appadmin@example.org'));
});

test('review F2: an owner whose enabled state does not read as enabled is refused, not taken as fine', async () => {
  for (const v of [undefined, null, 'false']) {
    const dv = dvAs('admin');
    if (v === undefined) delete dv.data.systemusers[IDS.appadmin].isdisabled; else dv.data.systemusers[IDS.appadmin].isdisabled = v;
    await refused(C.planComponent(dv, valid(updateJob(dv)), ctx()), /could not be read as an enabled user; nothing can be written as them/);
  }
});

test('review F3 + F4: at apply the record must still be a cloud flow, in the state and hands the plan read', async () => {
  let dv = dvAs('admin');
  let plan = await C.planComponent(dv, valid(updateJob(dv)), ctx());
  dv.data.workflows[IDS.flow].category = 0;
  await refused(applied(plan, dv), /is not a cloud flow \(category 0\), so nothing is written as another account/, 'ApplyRefused');
  assert.deepEqual(nonGets(dv), []);
  // F4: a definition change normally survives its flow being switched on since the plan; written as another account it does not
  dv = dvAs('admin');
  plan = await C.planComponent(dv, valid(updateJob(dv)), ctx());
  Object.assign(dv.data.workflows[IDS.flow], { statecode: 1, statuscode: 2 });
  await refused(applied(plan, dv), /was turned on or off, or changed owner, since the plan/, 'ApplyRefused');
  dv = dvAs('admin');
  plan = await C.planComponent(dv, valid(updateJob(dv)), ctx());
  dv.data.workflows[IDS.flow]._ownerid_value = IDS.dev2;
  await refused(applied(plan, dv), /was turned on or off, or changed owner, since the plan/, 'ApplyRefused');
  assert.deepEqual(nonGets(dv), []);
});

// ---------- round 3 (blind review 11/23/26, reviews\2026-11-19_act_as_r2) ----------

test('round-2 F1: a definition saved while the prompt is open is never turned on, off or saved as the service account', async () => {
  const edit = (dv) => {
    const cd = flowCd();
    cd.properties.definition.actions.Compose_total.inputs = 'saved in the designer while the prompt was open';
    dv.data.workflows[IDS.flow].clientdata = JSON.stringify(cd);
  };
  for (const [make, off] of [[(dv) => stateJob(dv, 'on'), true], [(dv) => stateJob(dv, 'off'), false], [(dv) => updateJob(dv), true]]) {
    const dv = dvAs('admin', { off });
    const plan = await C.planComponent(dv, valid(make(dv)), ctx());
    await refused(applied(plan, dv, { confirm: () => { edit(dv); return { approved: true }; } }),
      /was edited while the approval was waiting \(its definition no longer matches the snapshot\)\. Nothing was written; make a new plan\./, 'ApplyRefused');
    assert.deepEqual(nonGets(dv), [], `nothing was written (${plan.mode})`);
  }
  // control: nothing saved meanwhile, the turn-on goes through
  const dv = dvAs('admin');
  const ok = await applied(await C.planComponent(dv, valid(stateJob(dv, 'on')), ctx()), dv);
  assert.equal(ok.res.outcome, 'applied', JSON.stringify(ok.res.rows));
});

test('round-2 F2: a read-back that fails after the write still reads whose name the flow carries', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(updateJob(dv)), ctx());
  const { DataverseError } = require('../lib/cli');
  let wrote = false;
  const update = dv.update;
  dv.update = (...a) => { const r = update(...a); wrote = true; return r; };
  const get = dv.get;
  dv.get = (p, o) => {
    if (wrote && !/_createdonbehalfby_value/.test(String(p))) throw new DataverseError('Service unavailable', { status: 503 });
    return get(p, o);
  };
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /^read-back failed: the write went through but 'Add Soft Credit' could not be read back: Service unavailable; it did read back written as SBRM App Admin\. Read it before doing anything else$/);
  assert.deepEqual(res.rows[0].written_as.read_back, { by: IDS.appadmin, on_behalf_by: IDS.me, owner: IDS.appadmin });
  // the platform dropped the header: the failure line says so too
  const d2 = dvAs('admin');
  d2.ignoreBehalf = true;
  const p2 = await C.planComponent(d2, valid(updateJob(d2)), ctx());
  let w2 = false;
  const u2 = d2.update;
  d2.update = (...a) => { const r = u2(...a); w2 = true; return r; };
  const g2 = d2.get;
  d2.get = (p, o) => { if (w2 && !/_createdonbehalfby_value/.test(String(p))) throw new DataverseError('Service unavailable', { status: 503 }); return g2(p, o); };
  const r2 = await applied(p2, d2);
  assert.match(r2.res.rows[0].outcome, /^read-back failed: [\s\S]*; and the flow reads modified by 99999999-9999-9999-9999-999999999999 on behalf of nobody, not by SBRM App Admin on behalf of Test Person\. Read it/);
});

test('round-2 F4: Power Automate refusing a write sent as the connection owner says so, never "they do it themselves"', async () => {
  const { DataverseError } = require('../lib/cli');
  for (const mode of ['update', 'on']) {
    const dv = dvAs('admin');
    const plan = await C.planComponent(dv, valid(mode === 'update' ? updateJob(dv) : stateJob(dv, 'on')), ctx());
    dv.update = () => { throw new DataverseError('Flow client error returned with status code "Forbidden" and details "{"error":{"code":"ConnectionAuthorizationFailed"}}"', { status: 403, code: '0x80060467' }); };
    const { res } = await applied(plan, dv);
    assert.equal(res.outcome, 'applied with problems');
    const want = mode === 'update' ? 'save this flow' : 'turn this flow on';
    assert.equal(res.rows[0].outcome, `refused: Power Automate refused the write sent on behalf of SBRM App Admin, the owner of this flow's connections: it did not let the toolkit ${want} as them. Nothing changed. Read the flow before planning again, and tell Dylan (writing as a service account is a test slice).`);
    assert.doesNotMatch(res.rows[0].outcome, /does it there|Sharing their connection/);
  }
});
