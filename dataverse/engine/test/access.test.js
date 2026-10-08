'use strict';
// Who may write, read from each environment's Dataverse Write Access table (lib/access.js, 10/7).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-access-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
process.env.SBRM_DV_CONFIG = path.join(HOME, 'config');
fs.mkdirSync(process.env.SBRM_DV_CONFIG, { recursive: true });
fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'),
  JSON.stringify({ donorapp: { host: 'https://example.invalid', name: 'Donor App', hipaa: false } }));
// No access.json on purpose: there is none any more.

const { readAccess, mergeAccessLists } = require('../lib/access');
const { accessFor } = require('../lib/resolve');
const cli = require('../dataverse-write');
const { fakeDv, IDS } = require('./fake');

const dvWith = (rows) => ({ get: () => ({ value: rows }) });

test('rows become per-person grants; absent = read; an unknown level never grants more than read', () => {
  const a = readAccess(dvWith([
    { sbrm_name: 'Alex Rivera', sbrm_email: ' Alex@Example.org ', sbrm_level: 'write', sbrm_maxrows: 40, sbrm_merge: true },
    { sbrm_email: 'kv@example.org', sbrm_level: 'superuser', sbrm_maxrows: null, sbrm_merge: false },
    { sbrm_email: 'dev@example.org', sbrm_level: ' Develop ' },
    { sbrm_email: 'old@example.org', sbrm_level: 'schema' },
    { sbrm_email: '', sbrm_level: 'admin' },
  ]), 'donorapp');
  // No row limit any more (ruled 10/7): the Rows Per Approval column is not read, so 40 changes nothing.
  assert.deepEqual(accessFor(a, 'alex@example.org', 'donorapp'), { level: 'write' });
  assert.equal(a.people['alex@example.org'].merge.donorapp, true);
  assert.equal(a.people['kv@example.org'].merge.donorapp, false, 'merge only where the row says yes');
  assert.deepEqual(accessFor(a, 'kv@example.org', 'donorapp'), { level: 'read' }, 'unknown level -> read');
  assert.deepEqual(accessFor(a, 'dev@example.org', 'donorapp'), { level: 'develop' }, 'case and spaces do not matter');
  assert.deepEqual(accessFor(a, 'old@example.org', 'donorapp'), { level: 'admin' }, 'the old name schema reads as admin (one release)');
  assert.deepEqual(accessFor(a, 'nobody@example.org', 'donorapp'), { level: 'read' });
  assert.equal(Object.keys(a.people).length, 4, 'a row with no email is ignored');
  assert.equal(a.people['alex@example.org'].name, 'Alex Rivera', 'the row name rides along (the review shows it for someone with no activity yet)');
});

test('only active rows count: a deactivated grant is no grant', () => {
  let asked = '';
  readAccess({ get: (q) => { asked = decodeURIComponent(q); return { value: [] }; } }, 'donorapp');
  assert.match(asked, /\$filter=statecode eq 0/);
});

test('an unreadable list is a refusal with its own code (fail closed), never "read access"', () => {
  const broken = { get: () => { throw new Error('Principal user is missing prvReadsbrm_dataversewriteaccess privilege'); } };
  assert.throws(() => readAccess(broken, 'donorapp'), (e) => e.code === 'access_unreadable' && /could not read the Dataverse Write Access list/.test(e.message));
});

test('several environments merge into one list (the review)', () => {
  const m = mergeAccessLists([
    readAccess(dvWith([{ sbrm_email: 'a@example.org', sbrm_level: 'write' }]), 'donorapp'),
    readAccess(dvWith([{ sbrm_email: 'a@example.org', sbrm_level: 'schema' }]), 'hgs'),
  ]);
  assert.deepEqual(m.people['a@example.org'].envs, { donorapp: 'write', hgs: 'admin' });
});

// ---- through the real CLI ----

const deps = (dv, over = {}) => ({
  readConnection: () => dv, writeConnection: () => dv, confirm: () => ({ approved: true }),
  eventConnection: () => ({ createEvent: (b) => dv.create('sbrm_dataverseevents', b) }),
  cli: () => ({ version: '1.0.81' }), io: () => ({ home: HOME, cwd: HOME, read: () => null }), ...over,
});
function go(argv, d) {
  const real = console.log;
  console.log = () => {};
  try { const code = cli.runCli(argv, d); return { code, run: cli.lastRun, out: cli.lastRun.output.join('\n') }; } finally { console.log = real; }
}
let n = 0;
function job(over = {}) {
  n += 1;
  const f = path.join(HOME, `j${n}.json`);
  fs.writeFileSync(f, JSON.stringify({
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', table: 'contacts', mode: 'update', source: 't', reason: 'T.',
    intent: { verb: 'update', count: 1, table: 'contacts', fields: ['address1_city'] },
    rows: [{ name: 'Jane Example', id: IDS.jane, body: { address1_city: `Town ${n}` } }], ...over,
  }));
  return f;
}

test('the CLI reads access from the table: a granted writer plans; with the list unreadable, nothing is planned', () => {
  const dv = fakeDv({ email: 'writer@example.org' });
  assert.equal(go(['plan', job()], deps(dv)).code, 0);
  dv.accessUnreadable = true;
  const r = go(['plan', job()], deps(dv));
  assert.equal(r.code, 1);
  assert.deepEqual([r.run.events[0].reason_code, r.run.events[0].signal], ['access_unreadable', true]);
  assert.match(r.out, /REFUSED: could not read the Dataverse Write Access list/);
});

test('a grant removed between plan and apply refuses the apply (read again at apply)', () => {
  const dv = fakeDv({ email: 'writer@example.org' });
  const planned = go(['plan', job()], deps(dv));
  for (const [id, r] of Object.entries(dv.data.sbrm_dataversewriteaccesses)) if (r.sbrm_email === 'writer@example.org') delete dv.data.sbrm_dataversewriteaccesses[id];
  const r = go(['apply', planned.run.planId], deps(dv, { confirm: () => { throw new Error('no pop-up'); } }));
  assert.equal(r.code, 1);
  assert.match(r.out, /your access to the Donor App is now read, not write/);
});

test("the toolkit's own tables need admin: a writer (or a developer) cannot touch the access list", () => {
  const dv = fakeDv({ email: 'writer@example.org' });
  const f = job({ table: 'sbrm_dataversewriteaccesses', intent: { verb: 'update', count: 1, table: 'sbrm_dataversewriteaccesses', fields: ['sbrm_level'] },
    rows: [{ name: 'writer', id: IDS.jane, body: { sbrm_level: 'schema' } }] });
  const r = go(['plan', f], deps(dv));
  assert.equal(r.code, 1);
  assert.deepEqual([r.run.events[0].reason_code, r.run.events[0].signal], ['not_permitted', true]);
  assert.match(r.out, /changed only by an admin of the toolkit/);
  const dev = fakeDv({ email: 'dev@example.org', access: { people: { 'dev@example.org': { envs: { donorapp: 'develop' } } } } });
  assert.equal(go(['plan', f], deps(dev)).code, 1, 'develop is not admin');
});

test('the Write Log and the event table are append-only, even for an admin', () => {
  const dv = fakeDv({ email: 'dgross@example.org' });
  const f = job({ table: 'sbrm_dataversewritelogs', intent: { verb: 'update', count: 1, table: 'sbrm_dataversewritelogs', fields: ['sbrm_outcome'] },
    rows: [{ name: 'x', id: IDS.jane, body: { sbrm_outcome: 'applied' } }] });
  const r = go(['plan', f], deps(dv));
  assert.equal(r.code, 1);
  assert.match(r.out, /append-only/);
});

test('whoami shows the level from the table', () => {
  const r = go(['whoami', 'donorapp'], deps(fakeDv({ email: 'writer@example.org' })));
  assert.match(r.out, /shared-path access: write \(can change records\)$/m);
  assert.match(go(['whoami', 'donorapp'], deps(fakeDv({ email: 'merger@example.org' }))).out, /write \(can change records\); may merge/);
  assert.match(go(['whoami', 'donorapp'], deps(fakeDv({ email: 'dgross@example.org' }))).out, /admin \(.*runs the toolkit\); may merge/);
});
