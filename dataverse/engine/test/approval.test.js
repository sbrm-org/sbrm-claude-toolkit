'use strict';
// The approval through the REAL command path (DESIGN.md §10n, 1.11.0): with no `confirm` injected, apply
// writes only on a good one-time ticket (minted by the guard when Claude Code asks the person), and a batch
// runs each plan on its own ticket.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-approval-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
process.env.SBRM_DV_CONFIG = path.join(HOME, 'config');
fs.mkdirSync(process.env.SBRM_DV_CONFIG, { recursive: true });

const { fakeDv, IDS } = require('./fake');
fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'),
  JSON.stringify({ donorapp: { host: 'https://example.invalid', name: 'Donor App', hipaa: false } }));

const cli = require('../dataverse-write');
const ticket = require('../lib/ticket');

const EVENTS = 'sbrm_dataverseevents';
// No `confirm`: the ticket path is the one that runs.
const deps = (dv) => ({ readConnection: () => dv, writeConnection: () => dv, eventConnection: () => ({ createEvent: (b) => dv.create(EVENTS, b) }) });
const writes = (dv) => dv.calls.filter((c) => c.method !== 'GET' && !/^sbrm_dataverse(writelogs|events)/.test(c.path));

async function quiet(fn) {
  const real = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = real; }
}

let n = 0;
async function planId(dv, who = IDS.jane, name = 'Jane Example') {
  n += 1;
  const f = path.join(HOME, `job-${n}.json`);
  fs.writeFileSync(f, JSON.stringify({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'update', source: 'test', reason: 'Test.',
    intent: { verb: 'update', count: 1, table: 'contacts', fields: ['address1_city'] },
    rows: [{ name, id: who, body: { address1_city: `Town ${n}` } }],
  }));
  assert.equal(await quiet(() => cli.runCli(['plan', f], deps(dv))), 0);
  return cli.lastRun.planId;
}

test('no ticket: apply is refused as a signal event and nothing is written', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await planId(dv);
  const code = await quiet(() => cli.runCli(['apply', id], deps(dv)));
  assert.equal(code, 1);
  assert.deepEqual(writes(dv), []);
  const e = cli.lastRun.events.find((x) => x.reason_code === 'no_approval');
  assert.ok(e, 'recorded as no_approval');
  assert.equal(e.signal, true);
  assert.match(e.detail, /not approved in Claude Code's permission prompt/);
});

test('a good ticket: the apply writes and uses the ticket up; the same apply again is refused', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await planId(dv);
  ticket.mint(id);
  assert.equal(await quiet(() => cli.runCli(['apply', id], deps(dv))), 0);
  assert.equal(writes(dv).length, 1);
  assert.equal(ticket.check(id).ok, false, 'used up');
});

test('a ticket for another plan does not approve this one', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const a = await planId(dv);
  const b = await planId(dv);
  ticket.mint(a);
  assert.equal(await quiet(() => cli.runCli(['apply', b], deps(dv))), 1);
  assert.deepEqual(writes(dv), []);
  ticket.take(a);
});

test('a batch: each plan runs on its own ticket, in order; one without a ticket fails alone', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  // a and b change Jane and Bob; c changes Bob too, which still stands because b (no ticket) never writes.
  const a = await planId(dv);
  const b = await planId(dv, IDS.bob, 'Bob Sample');
  const c = await planId(dv, IDS.bob, 'Bob Sample');
  ticket.mint(a);
  ticket.mint(c);
  const code = await quiet(() => cli.runBatch(['apply', a, b, c], deps(dv)));
  assert.equal(code, 1, 'the worst exit code');
  assert.equal(writes(dv).length, 2, 'a and c written, b refused');
});

test('an approval answered after the ticket ran out is refused as routine approval_expired, not a bypass', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await planId(dv);
  ticket.mint(id, { now: Date.now() - ticket.TTL_MS - 1000 });
  assert.equal(await quiet(() => cli.runCli(['apply', id], deps(dv))), 1);
  assert.deepEqual(writes(dv), []);
  const e = cli.lastRun.events.find((x) => x.reason_code === 'approval_expired');
  assert.ok(e, 'recorded as approval_expired');
  assert.equal(e.signal, false);
  assert.match(JSON.stringify(e), /ticket made \d{4}-\d\d-\d\dT[\d:.]+Z, checked \d{4}-\d\d-\d\dT[\d:.]+Z, 60\d s apart/, 'the recorded refusal carries the ticket\'s times (#6hqFhJfV8GRW459J)');
});

// 1.11.10 (guard_review/DESIGN.md §2a): the engine hands the approval it took into the write connection it opens,
// and lib/write.js checks it on every write. Here the connection is wrapped so each write asks: is the approval I
// was handed one ticket.verify() accepts, right now?
function gatedDeps(dv, seen) {
  const WRITES = ['create', 'update', 'remove', 'merge', 'metadata', 'publish'];
  return {
    ...deps(dv),
    writeConnection: (host, cli, o) => new Proxy(dv, {
      get(t, k) {
        if (WRITES.includes(k)) return (...a) => { seen.push(!!(o && typeof o.approval === 'function' && ticket.verify(o.approval()))); return t[k](...a); };
        return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
      },
    }),
  };
}

test('the write connection holds the approval the apply took, verified at every write (1.11.10)', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const id = await planId(dv);
  ticket.mint(id);
  const seen = [];
  assert.equal(await quiet(() => cli.runCli(['apply', id], gatedDeps(dv, seen))), 0);
  assert.ok(seen.length >= 1, 'it wrote');
  assert.ok(seen.every(Boolean), 'every write carried a verified approval');
});

test('a batch: each plan\'s writes carry that plan\'s verified approval (1.11.10)', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const a = await planId(dv);
  const b = await planId(dv, IDS.bob, 'Bob Sample');
  ticket.mint(a);
  ticket.mint(b);
  const seen = [];
  assert.equal(await quiet(() => cli.runBatch(['apply', a, b], gatedDeps(dv, seen))), 0);
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(Boolean));
});

test('a batch takes every ticket as it starts, so a slow early plan cannot make a later one expire', async () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const a = await planId(dv);
  const b = await planId(dv, IDS.bob, 'Bob Sample');
  ticket.mint(a);
  ticket.mint(b);
  let firstTake = null;
  const spy = { take: (k) => { if (!firstTake) firstTake = k; return ticket.take(k); }, check: ticket.check };
  assert.equal(await quiet(() => cli.runBatch(['apply', a, b], { ...deps(dv), ticket: spy })), 0);
  assert.equal(ticket.check(a).ok || ticket.check(b).ok, false, 'both used');
  assert.equal(firstTake, a);
  assert.equal(writes(dv).length, 2);
});

test('the prompt for a batch resolve names every item it closes (1.11.10)', () => {
  const { approvalText } = require('../../guard/guard');
  assert.equal(approvalText({ verb: 'resolve', keys: ['resolve-D-1003'] }), 'Close D-1003');
  assert.equal(approvalText({ verb: 'resolve', keys: ['resolve-D-1082', 'resolve-D-1083', 'resolve-D-1084'] }),
    'Close 3 items: D-1082, D-1083, D-1084');
});

test('the prompt names a duplicate rule and every condition it ends with (1.11.36)', () => {
  const { approvalText } = require('../../guard/guard');
  const store = require('../lib/store');
  const put = (id, rec) => fs.writeFileSync(path.join(store.dir('plans'), `${id}.json`), JSON.stringify(rec));
  const conds = [{ attribute: 'address1_postalcode', operatorcode: 1, operatorparam: 5, ignoreblankvalues: true }, { attribute: 'firstname', operatorcode: 0, ignoreblankvalues: true },
    { attribute: 'telephone1', operatorcode: 2, operatorparam: 7, ignoreblankvalues: false }];
  put('20261116-160001-aaaaaaa1', { kind: 'duperule', app: 'Donor App Dev', mode: 'update', rule: { name: 'Contacts same name' }, after: { published: true, conditions: conds }, severity: { lines: [] } });
  put('20261116-160002-aaaaaaa2', { kind: 'duperule', app: 'Donor App Dev', mode: 'off', rule: { name: 'Contacts same name' }, after: { published: false, conditions: conds }, reverts_plan_id: 'x', severity: { lines: [] } });
  put('20261116-160003-aaaaaaa3', { kind: 'duperule', app: 'Donor App Dev', mode: 'create', rule: { name: 'Mobile' }, after: { published: true, conditions: [conds[1]] }, severity: { lines: ['Lasting: a new duplicate rule.'] } });
  assert.equal(approvalText({ verb: 'apply', keys: ['20261116-160001-aaaaaaa1'] }), "Change the duplicate rule 'Contacts same name' in the Donor App Dev: address1_postalcode first 5 chars (blanks ignored) + firstname exact (blanks ignored) + telephone1 last 7 chars");
  assert.equal(approvalText({ verb: 'apply', keys: ['20261116-160002-aaaaaaa2'] }), "Turn off the duplicate rule 'Contacts same name' in the Donor App Dev (an undo)");
  assert.equal(approvalText({ verb: 'apply', keys: ['20261116-160003-aaaaaaa3'] }), "Create the duplicate rule 'Mobile' in the Donor App Dev: firstname exact (blanks ignored). Lasting: a new duplicate rule.");
});

test('the prompt names an application user change and a new security role with every privilege (1.11.31)', () => {
  const { approvalText } = require('../../guard/guard');
  const store = require('../lib/store');
  const put = (id, rec) => fs.writeFileSync(path.join(store.dir('plans'), `${id}.json`), JSON.stringify(rec));
  put('20261109-150001-aaaaaaa1', { kind: 'appuser', app: 'HGS apps', action: 'create', client_id: 'd4000000-0000-0000-0000-000000000001', unit: { name: 'SBRM Homeless' }, severity: { lines: ['Lasting: x.'] } });
  put('20261109-150002-aaaaaaa2', { kind: 'appuser', app: 'HGS apps', action: 'disable', client_id: 'd4000000-0000-0000-0000-000000000001', user: { fullname: '# Job' }, severity: { lines: [] } });
  put('20261109-150003-aaaaaaa3', { kind: 'securityrole', app: 'HGS apps', action: 'create', name: '#_ sbrmapps Job (read)', writes: false,
    privileges: [{ access: 'read', table: 'sbrm_guest', depth_word: 'organization' }, { access: 'read', table: 'sbrm_bednight', depth_word: 'organization' }], severity: { lines: [] } });
  put('20261109-150004-aaaaaaa4', { kind: 'securityrole', app: 'HGS apps', action: 'delete', name: '#_ sbrmapps Job (read)', reverts_plan_id: 'x', severity: { lines: [] } });
  put('20261109-150005-aaaaaaa5', { kind: 'role', app: 'HGS apps', rows: [{ action: 'add', role: { name: '#_ sbrmapps Job (read)' }, user: { fullname: '# Job', email: null, client_id: 'd4000000-0000-0000-0000-000000000001' } }], severity: { lines: [] } });
  assert.equal(approvalText({ verb: 'apply', keys: ['20261109-150001-aaaaaaa1'] }), 'Create an application user for the Entra app d4000000-0000-0000-0000-000000000001 (business unit SBRM Homeless) in the HGS apps. Lasting: x.');
  assert.equal(approvalText({ verb: 'apply', keys: ['20261109-150002-aaaaaaa2'] }), 'Switch off the application user # Job (Entra app d4000000-0000-0000-0000-000000000001) in the HGS apps');
  assert.equal(approvalText({ verb: 'apply', keys: ['20261109-150003-aaaaaaa3'] }), "Create the security role '#_ sbrmapps Job (read)' in the HGS apps (read only): read sbrm_guest (organization), read sbrm_bednight (organization); plus the baseline Dataverse gives every role (Read on plug-ins, Read, Create and Write on SharePoint data)");
  assert.equal(approvalText({ verb: 'apply', keys: ['20261109-150004-aaaaaaa4'] }), "Delete the security role '#_ sbrmapps Job (read)' in the HGS apps (an undo)");
  assert.equal(approvalText({ verb: 'apply', keys: ['20261109-150005-aaaaaaa5'] }), "Add '#_ sbrmapps Job (read)' to # Job (application user d4000000-0000-0000-0000-000000000001) in the HGS apps");
});

test('the prompt names every privilege taken off an existing role, who holds it, and what an undo gives back (1.11.43)', () => {
  const { approvalText } = require('../../guard/guard');
  const store = require('../lib/store');
  const put = (id, rec) => fs.writeFileSync(path.join(store.dir('plans'), `${id}.json`), JSON.stringify(rec));
  // Holders as the live HGS plan read 11/23/26: enabled people, application users and teams (disabled accounts apart).
  put('20261123-150001-aaaaaaa1', { kind: 'securityrole', app: 'HGS apps', action: 'remove', name: '#_ SBRM Normal',
    privileges: [{ access: 'create', table: 'sbrm_waitlistcount', depth_word: 'organization' }, { access: 'create', table: 'sbrm_mealcount', depth_word: 'organization' }],
    holders: { people: Array.from({ length: 12 }, (_, i) => `P${i}`), apps: ['# SBRM Package Tracker'], teams: ['Homeless Program'], disabled: 12 },
    severity: { lines: ['Ends access: 12 people, 1 application user and 1 team lose it.'] } });
  put('20261123-150002-aaaaaaa2', { kind: 'securityrole', app: 'HGS apps', action: 'remove', name: '#_ SBRM Idle',
    privileges: [{ access: 'create', table: 'sbrm_guest', depth_word: 'organization' }], holders: { people: ['One'], teams: [] }, severity: { lines: [] } });
  put('20261123-150003-aaaaaaa3', { kind: 'securityrole', app: 'HGS apps', action: 'restore', name: '#_ SBRM Normal', reverts_plan_id: '20261123-150001-aaaaaaa1',
    privileges: [{ name: 'prvCreatesbrm_WaitlistCount', id: 'x', depth: 'Global' }], severity: { lines: [] },
    holders: { people: ['P1', 'P2'], apps: ['# SBRM Package Tracker'], teams: ['Homeless Program'], disabled: 3 } });
  assert.equal(approvalText({ verb: 'apply', keys: ['20261123-150001-aaaaaaa1'] }),
    "Take create on sbrm_waitlistcount (organization), create on sbrm_mealcount (organization) off the security role '#_ SBRM Normal' in the HGS apps; the role is held by 12 people, 1 application user and 1 team. Ends access: 12 people, 1 application user and 1 team lose it.");
  // A plan from before the holder split (no `apps`) still reads cleanly.
  assert.equal(approvalText({ verb: 'apply', keys: ['20261123-150002-aaaaaaa2'] }),
    "Take create on sbrm_guest (organization) off the security role '#_ SBRM Idle' in the HGS apps; the role is held by 1 person, 0 application users and 0 teams");
  assert.equal(approvalText({ verb: 'apply', keys: ['20261123-150003-aaaaaaa3'] }),
    "Give prvCreatesbrm_WaitlistCount (Global) back to the security role '#_ SBRM Normal' in the HGS apps; the role is held by 2 people, 1 application user and 1 team (an undo)");
});
