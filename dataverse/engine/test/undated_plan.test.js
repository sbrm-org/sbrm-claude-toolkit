'use strict';
// Every apply path refuses a plan whose `created` is missing or not a date (pool card #6j32RphWwm2W5fhJ,
// from the 11/16 duperule review F8). Before: `now - new Date(undefined)` is NaN, NaN > MAX_AGE_MS is
// false, so the plan read as fresh at any age. duperule.js was fixed in 1.11.36; this covers the rest.
// Reachability: savePlan always stamps `created` inside the signed hash, so on a real machine an undated
// plan needs a forged signature. This is defence in depth, tested by signing one here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Every store/log path goes to a throwaway folder, set BEFORE the modules read it.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-undated-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const { planHash, dir } = require('../lib/store');
const { applyPlan } = require('../lib/apply');

const UNDATED = /says nothing about when it was made/;
const noConnect = () => { throw new Error('connect reached: the age check let the plan through'); };
const deps = { access: { people: {} }, connect: noConnect, confirm: () => { throw new Error('prompt reached'); } };
const BAD = { missing: undefined, 'not a date': 'yesterday-ish', empty: '' };

function refusedUndated(e) {
  assert.equal(e.name, 'ApplyRefused', e.stack);
  assert.match(e.message, UNDATED);
  assert.equal(e.code, 'stale_plan');
  return true;
}

const KINDS = [
  ['appuser', 'applyAppUser'], ['component', 'applyComponent'], ['merge', 'applyMerge'], ['merge', 'applyUnmerge'],
  ['role', 'applyRole'], ['schema', 'applySchema'], ['securityrole', 'applySecurityRole'], ['setting', 'applySetting'],
  ['duperule', 'applyDupeRule'],
];

for (const [mod, fn] of KINDS) {
  for (const [label, created] of Object.entries(BAD)) {
    test(`${fn}: a plan with ${label} created is refused as undated, before any connection`, async () => {
      const apply = require(`../lib/${mod}`)[fn];
      assert.equal(typeof apply, 'function', `${mod}.${fn} exported`);
      const plan = { host: 'example.crm.dynamics.com', env: 'hgs', kind: mod };
      if (created !== undefined) plan.created = created;
      await assert.rejects(apply(plan, deps, { id: 'p', file: path.join(HOME, 'nofile.json'), fs }), refusedUndated);
    });
  }
  test(`${fn}: a dated plan past 24 hours is still refused as stale`, async () => {
    const apply = require(`../lib/${mod}`)[fn];
    const plan = { host: 'example.crm.dynamics.com', env: 'hgs', kind: mod, created: new Date(Date.now() - 25 * 3600 * 1000).toISOString() };
    await assert.rejects(apply(plan, deps, { id: 'p', file: path.join(HOME, 'nofile.json'), fs }), (e) => {
      assert.equal(e.code, 'stale_plan');
      assert.match(e.message, /more than 24 hours old/);
      return true;
    });
  });
}

// The rows path loads by id and checks the signature first, so the undated plan is signed here the
// way savePlan signs (same key, same hash), only without `created`.
function saveSignedUndated(created) {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const body = { kind: 'rows', mode: 'update', env: 'donorapp', host: 'example.crm.dynamics.com', rows: [], nonce: Math.random().toString(16).slice(2, 18) };
  if (created !== undefined) body.created = created;
  const hash = planHash(body);
  const id = `${stamp}-${hash.slice(0, 8)}`;
  fs.writeFileSync(path.join(dir('plans'), `${id}.json`), JSON.stringify({ ...body, id, hash }, null, 2));
  return id;
}

for (const [label, created] of Object.entries(BAD)) {
  test(`applyPlan (rows): a SIGNED plan with ${label} created is refused as undated`, () => {
    const id = saveSignedUndated(created);
    assert.throws(() => applyPlan(id, deps), refusedUndated);
  });
}
