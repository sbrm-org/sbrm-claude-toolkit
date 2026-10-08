'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// The signing key lives in the store: never the real one in a test.
process.env.SBRM_DV_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-store-'));
const { canonical, planHash, savePlan, loadPlan } = require('../lib/store');
const { headline, summary, detail, nounCase } = require('../lib/render');

function samplePlan(over = {}) {
  return {
    contract: 'sbrm-dv-job/1', kind: 'rows', env: 'donorapp', app: 'Donor App', table: 'contacts', mode: 'update',
    source: 'test', reason: 'Returned mail.', identity: { fullname: 'Test Person', email: 't@example.org', systemuserid: 'x' },
    labels: { singular: 'Contact', plural: 'Contacts' }, amount_total: null, refused: [],
    rows: [
      { name: 'Jane', id: 'a', body: { address1_city: 'SB' }, warnings: [], changes: [{ column: 'address1_city', label: 'City', old_text: '(blank)', new_text: 'SB' }] },
      { name: 'Bob', id: 'b', body: { address1_city: 'SB' }, warnings: [], changes: [{ column: 'address1_city', label: 'City', old_text: 'Goleta', new_text: 'SB' }] },
    ],
    ...over,
  };
}

test('canonical JSON sorts keys at every depth and keeps array order', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
});

test('the hash covers record ids, not only bodies (the gap in the Python token)', () => {
  const a = samplePlan();
  const b = samplePlan();
  b.rows[0].id = 'z';
  assert.deepEqual(a.rows.map((r) => r.body), b.rows.map((r) => r.body));
  assert.notEqual(planHash(a), planHash(b));
});

test('a saved plan loads intact; an edited one does not', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-'));
  const env = { SBRM_DV_HOME: home };
  const { id, file } = savePlan(samplePlan(), { now: new Date(2026, 9, 6, 17, 5, 9), env });
  assert.match(id, /^20261006-170509-[0-9a-f]{8}$/);
  assert.equal(loadPlan(id, { env }).intact, true);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.rows[0].id = 'someone-else';
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.equal(loadPlan(id, { env }).intact, false);
  assert.throws(() => loadPlan('../../etc/passwd', { env }), /not a plan id/);
});

test('the same plan saved twice in one second gets two different ids', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-'));
  const env = { SBRM_DV_HOME: home };
  const now = new Date(2026, 9, 6, 17, 5, 9);
  const a = savePlan(samplePlan(), { now, env });
  const b = savePlan(samplePlan(), { now, env });
  assert.notEqual(a.id, b.id);
  assert.equal(loadPlan(a.id, { env }).intact, true);
  assert.equal(loadPlan(b.id, { env }).intact, true);
});

test('headlines: update, add, mark inactive; nouns keep acronyms', () => {
  assert.equal(headline(samplePlan()), 'Update 2 contacts in the Donor App');
  assert.equal(headline(samplePlan({ mode: 'create', rows: [samplePlan().rows[0]] })), 'Add 1 contact to the Donor App');
  const deact = samplePlan({ rows: [{ name: 'x', body: { statecode: 1, statuscode: 2 }, warnings: [], changes: [] }] });
  assert.equal(headline(deact), 'Mark 1 contact inactive in the Donor App');
  assert.equal(nounCase('EBT Loads'), 'EBT loads');
  assert.equal(nounCase('Gifts'), 'gifts');
});

test('summary rolls up by column and always shows warnings, refusals and the reason', () => {
  const p = samplePlan({ refused: [{ name: 'Gone', why: 'the record is inactive' }] });
  p.rows[1].warnings.push('check this one');
  const s = summary(p);
  assert.match(s, /^Update 2 contacts in the Donor App/);
  assert.match(s, /City: set to "SB" on 2 contacts/);
  assert.match(s, /Needs a look \(1\):\n  Bob: check this one/);
  assert.match(s, /Left out, will NOT be written \(1\):\n  Gone: the record is inactive/);
  assert.match(s, /Reason given: Returned mail\.$/);
  assert.ok(!/[–—]/.test(s), 'ASCII only, no dashes the Windows console mangles');
});

test('a single changed row shows old -> new in the summary, not just the new value', () => {
  const p = samplePlan({ rows: [samplePlan().rows[1]] });
  assert.match(summary(p), /^ {2}City: Goleta -> SB$/m);
  const c = samplePlan({ mode: 'create', rows: [samplePlan().rows[0]] });
  assert.match(summary(c), /^ {2}City: SB$/m);
});

test('detail lists every change row by row', () => {
  const d = detail(samplePlan(), { id: 'P1' });
  assert.match(d, /1\. Jane\n     City: \(blank\) -> SB/);
  assert.match(d, /2\. Bob\n     City: Goleta -> SB/);
  assert.match(d, /Requested by: Test Person \(t@example\.org\)/);
});

test('plans are SIGNED with this machine key: created is covered, and another key does not verify (1.10.1)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-'));
  const env = { SBRM_DV_HOME: home };
  const { id, file } = savePlan(samplePlan(), { env });
  const key = path.join(home, 'config', 'plan.key');
  assert.match(fs.readFileSync(key, 'utf8'), /^[0-9a-f]{64}$/, 'a 256-bit key is made on first use');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.created = new Date(Date.now() + 3600 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.equal(loadPlan(id, { env }).intact, false, 'editing created breaks the signature');
  // Recomputing a plain SHA-256 (what anyone could do before) no longer verifies.
  const crypto = require('crypto');
  const { hash, id: _i, ...rest } = rec; // eslint-disable-line no-unused-vars
  rec.hash = crypto.createHash('sha256').update(canonical(rest)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.equal(loadPlan(id, { env }).intact, false, 'an unkeyed hash is not a signature');
  // The same plan under another machine's key does not verify.
  const other = { SBRM_DV_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-')) };
  const saved = savePlan(samplePlan(), { env });
  fs.mkdirSync(path.join(other.SBRM_DV_HOME, 'plans'), { recursive: true });
  fs.copyFileSync(saved.file, path.join(other.SBRM_DV_HOME, 'plans', path.basename(saved.file)));
  assert.equal(loadPlan(saved.id, { env: other }).intact, false);
});

test('the signing key: many runs at once agree on one key; a damaged key stops the run instead of being replaced', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-race-'));
  const { spawnSync } = require('child_process');
  const script = `process.env.SBRM_DV_HOME=${JSON.stringify(home)};const s=require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store.js'))});console.log(s.planHash({a:1}))`;
  const runs = Array.from({ length: 6 }, () => require('child_process').spawn(process.execPath, ['-e', script]));
  return Promise.all(runs.map((p) => new Promise((res) => { let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', () => res(out.trim())); }))).then((hashes) => {
    assert.equal(new Set(hashes).size, 1, `every run signed with the same key: ${hashes.join(' ')}`);
    fs.writeFileSync(path.join(home, 'config', 'plan.key'), 'short');
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /plan signing key .* is damaged/);
    assert.equal(fs.readFileSync(path.join(home, 'config', 'plan.key'), 'utf8'), 'short', 'never silently replaced');
  });
});
