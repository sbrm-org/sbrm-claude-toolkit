'use strict';
// Duplicate-detection rules (kind "duperule", 11/16/26, Dylan: "lets do the duplicate-rule job"), on a fake Dataverse
// (test/fake_duperule.js). The case that asked for it: the donor app's "Contacts with the same first name and last
// name" rule, which the Fundraise Up connector matches through; Dylan's Option 1 makes it first + last + ZIP (first 5
// characters), blanks ignored on all three. The module is called directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Never touch the real store (CLAUDE.md trap), even though this file only plans and applies in-process.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-duperule-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const D = require('../lib/duperule');
const { dupRuleCall } = require('../lib/write');
const { fakeDupeDv, IDS, ENVS, ACCESS } = require('./fake_duperule');

const NAME_RULE = 'Contacts with the same first name and last name';
const OPTION_1 = [
  { attribute: 'firstname', operatorcode: 0, ignoreblankvalues: true },
  { attribute: 'lastname', operatorcode: 0, ignoreblankvalues: true },
  { attribute: 'address1_postalcode', operatorcode: 1, operatorparam: 5, ignoreblankvalues: true },
];
const userOf = { admin: 'admin@example.org', dev: 'dev@example.org', reader: 'nobody@example.org' };
const dvAs = (who = 'admin', over = {}) => fakeDupeDv({ email: userOf[who], ...over });
const ctx = (over = {}) => ({ envs: ENVS, access: ACCESS, warnRows: 50, ...over });

function job(over = {}) {
  return {
    contract: 'sbrm-dv-job/1', kind: 'duperule', env: 'donorapp', mode: 'update',
    rule: { id: IDS.nameRule, name: NAME_RULE }, definition: { conditions: OPTION_1 },
    source: 'claude-session', reason: 'Fundraise Up matches on this rule; add ZIP so same-name donors are not merged.',
    intent: { verb: 'update', rule: NAME_RULE, changed: ['conditions'] }, ...over,
  };
}

function valid(raw) {
  const r = D.validateDupeRuleJob(raw, { envs: ENVS });
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  return r.job;
}

async function refused(promise, re, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, 'PlanRefused', e.stack);
    assert.match(e.message, re);
    if (code) assert.equal(e.code, code);
    return true;
  });
}

const nonGets = (dv) => dv.calls.filter((c) => c.method !== 'GET');
const condsOf = (dv, id) => dv.data.duplicateruleconditions.filter((c) => c._regardingobjectid_value === id);
const ruleOf = (dv, id) => dv.data.duplicaterules.find((r) => r.duplicateruleid === id);

let fileN = 0;
async function applied(plan, dv, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  let slept = 0;
  const res = await D.applyDupeRule({ ...plan, created: new Date().toISOString() }, {
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, sleep: () => { slept += 1; }, ...over,
  }, { id: `20261116-1500${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown, slept, fileGone: !fs.existsSync(file) };
}

// ---------- the job file ----------

test('validate: Option 1 passes; deletes, bad match types and intent mismatch are refused', () => {
  const j = valid(job());
  assert.equal(j.kind, 'duperule');
  assert.deepEqual(j.definition.conditions.map((c) => c.attribute), ['firstname', 'lastname', 'address1_postalcode']);
  assert.equal(j.definition.conditions[2].operatorparam, 5);
  assert.equal(j.definition.conditions[0].operatorparam, null);
  const c0 = (over) => ({ definition: { conditions: [{ attribute: 'firstname', operatorcode: 0, ignoreblankvalues: true, ...over }] } });
  const cases = [
    [{ mode: 'delete' }, /never deleted/],
    [{ mode: 'rename' }, /"mode" must be one of/],
    [{ kind: 'setting' }, /"kind" must be "duperule"/],
    [{ env: 'nowhere' }, /"env" must be one of/],
    [{ rule: { id: 'x', name: NAME_RULE } }, /rule.id must be the rule's GUID/],
    [c0({ operatorcode: 9 }), /operatorcode must be one of/],
    [c0({ operatorcode: 1 }), /needs "operatorparam"/],
    [c0({ operatorcode: 1, operatorparam: 0 }), /needs "operatorparam"/],
    [c0({ operatorparam: 5 }), /takes no "operatorparam"/],
    [c0({ ignoreblankvalues: 'yes' }), /ignoreblankvalues must be true or false/],
    [c0({ attribute: 'FirstName' }), /logical name/],
    [c0({ matchingattributename: 'lastname' }), /unknown key "matchingattributename"/],
    [{ definition: { conditions: [] } }, /1 to 10 conditions/],
    [{ definition: { conditions: [OPTION_1[0], OPTION_1[0]] } }, /same condition twice/],
    [{ definition: { colour: 'red' } }, /unknown key "colour"/],
    [{ definition: undefined }, /"definition" is required/],
    [{ mode: 'off', intent: { verb: 'off', rule: NAME_RULE } }, /takes no "definition"/],
    [{ intent: { verb: 'update', rule: 'Other', changed: ['conditions'] } }, /intent does not match.*rule says "Other"/],
    [{ intent: { verb: 'off', rule: NAME_RULE, changed: ['conditions'] } }, /intent does not match.*verb says "off"/],
    [{ intent: { verb: 'update', rule: NAME_RULE } }, /changed must list/],
    [{ reason: 'two\nlines' }, /"reason" must be one line/],
  ];
  for (const [over, re] of cases) {
    const r = D.validateDupeRuleJob({ ...job(), ...over }, { envs: ENVS });
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(over).slice(0, 90)}: ${r.errors.join(' | ')}`);
  }
  const create = valid({ ...job(), mode: 'create', rule: { name: 'Contacts with the same Mobile Phone', table: 'contact' },
    definition: { conditions: [{ attribute: 'mobilephone', operatorcode: 0, ignoreblankvalues: true }] }, intent: { verb: 'create', rule: 'Contacts with the same Mobile Phone' } });
  assert.equal(create.rule.table, 'contact');
  const r = D.validateDupeRuleJob({ ...job(), mode: 'create', rule: { name: 'X', table: 'contact' }, definition: { iscasesensitive: false }, intent: { verb: 'create', rule: 'X' } }, { envs: ENVS });
  assert.ok(r.errors.some((e) => /needs definition.conditions/.test(e)), r.errors.join(' | '));
});

// ---------- plan ----------

test('plan: reads only; Option 1 shows now and after, says the rule pauses, and names the Fundraise Up connector', async () => {
  const dv = dvAs('admin');
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  assert.deepEqual(nonGets(dv), []);
  assert.equal(plan.need, 'admin');
  assert.deepEqual(plan.changed, ['conditions']);
  assert.equal(plan.rule.table, 'contact');
  assert.equal(plan.before.published, true);
  assert.equal(plan.after.published, true);
  assert.equal(plan.connector, true);
  assert.deepEqual([...plan.condition_ids].sort(), [IDS.first, IDS.last].sort());
  const s = D.dupeRuleSummary(plan);
  assert.match(s, /Change the duplicate rule 'Contacts with the same first name and last name' in the Donor App: conditions/);
  assert.match(s, /firstname: Exact Match, blanks NOT ignored/);
  assert.match(s, /address1_postalcode: Same First Characters \(5\), blanks ignored/);
  assert.match(s, /nobody gets this rule's duplicate warning and the Fundraise Up connector does not match donors on it/);
});

test('plan: admin only; a develop-level person is refused', async () => {
  await refused(D.planDupeRule(dvAs('dev'), valid(job()), ctx()), /takes admin access.*has develop/, 'not_permitted');
});

test('plan: refuses an unknown column, a match type that does not fit the column, a managed or cross-table rule, a wrong name, no change, and a wrong intent.changed', async () => {
  const withConds = (conditions) => valid(job({ definition: { conditions } }));
  await refused(D.planDupeRule(dvAs(), withConds([{ attribute: 'zipcode', operatorcode: 0, ignoreblankvalues: true }]), ctx()), /contact has no column "zipcode"/, 'invalid_job');
  await refused(D.planDupeRule(dvAs(), withConds([{ attribute: 'birthdate', operatorcode: 1, operatorparam: 3, ignoreblankvalues: true }]), ctx()), /birthdate is a DateTime column; Same First Characters works on String or Memo/);
  await refused(D.planDupeRule(dvAs(), withConds([{ attribute: 'firstname', operatorcode: 3, ignoreblankvalues: true }]), ctx()), /Same Date works on DateTime/);
  await refused(D.planDupeRule(dvAs(), valid(job({ rule: { id: IDS.managedRule, name: 'Leads with the same e-mail' }, intent: { verb: 'update', rule: 'Leads with the same e-mail', changed: ['conditions'] } })), ctx()), /managed rule/, 'not_permitted');
  await refused(D.planDupeRule(dvAs(), valid(job({ rule: { id: IDS.crossRule, name: 'Contacts matching leads' }, intent: { verb: 'update', rule: 'Contacts matching leads', changed: ['conditions'] } })), ctx()), /same-table rules only/);
  await refused(D.planDupeRule(dvAs(), valid(job({ rule: { id: IDS.emailRule, name: NAME_RULE } })), ctx()), /is named 'Contacts with the same e-mail address'/);
  const same = [{ attribute: 'lastname', operatorcode: 0, ignoreblankvalues: false }, { attribute: 'firstname', operatorcode: 0, ignoreblankvalues: false }];
  await refused(D.planDupeRule(dvAs(), withConds(same), ctx()), /already reads exactly that/, 'every_row_refused');
  await refused(D.planDupeRule(dvAs(), valid(job({ definition: { conditions: OPTION_1, iscasesensitive: true } })), ctx()), /intent.changed says conditions, but the job changes case, conditions/, 'intent_mismatch');
  await refused(D.planDupeRule(dvAs(), valid(job({ definition: { name: 'Contacts with the same e-mail address' }, intent: { verb: 'update', rule: NAME_RULE, changed: ['name'] } })), ctx()), /another duplicate rule is already named/);
  await refused(D.planDupeRule(dvAs(), valid({ ...job(), mode: 'on', definition: undefined, intent: { verb: 'on', rule: NAME_RULE } }), ctx()), /already published/);
});

// ---------- apply ----------

test('apply Option 1: unpublish (unbound), wait, replace the conditions, publish, wait; reads back exactly; logs before and after', async () => {
  const dv = dvAs();
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  dv.calls.length = 0;
  const { res, shown, slept, fileGone } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows[0]));
  assert.ok(fileGone);
  assert.equal(shown.length, 1);
  const writes = nonGets(dv).map((c) => `${c.method} ${c.path.replace(/\(.*$/, '')}`);
  // New conditions before the old ones go (a failed add never leaves a rule with no conditions).
  assert.deepEqual(writes, ['POST UnpublishDuplicateRule', 'POST duplicateruleconditions', 'POST duplicateruleconditions',
    'POST duplicateruleconditions', 'DELETE duplicateruleconditions', 'DELETE duplicateruleconditions', 'POST duplicaterules']);
  assert.equal(nonGets(dv)[1].body['regardingobjectid@odata.bind'], `/duplicaterules(${IDS.nameRule})`);
  assert.match(nonGets(dv).at(-1).path, /^duplicaterules\(0c16fb72-.*\)\/Microsoft\.Dynamics\.CRM\.PublishDuplicateRule$/);
  assert.ok(slept >= 2, 'it waited for the async jobs');
  const zip = condsOf(dv, IDS.nameRule).find((c) => c.baseattributename === 'address1_postalcode');
  assert.deepEqual([zip.operatorcode, zip.operatorparam, zip.ignoreblankvalues, zip.matchingattributename], [1, 5, true, 'address1_postalcode']);
  assert.ok(condsOf(dv, IDS.nameRule).every((c) => c.ignoreblankvalues));
  assert.equal(ruleOf(dv, IDS.nameRule).statuscode, 2);
  const row = res.rows[0];
  assert.equal(row.outcome, 'written');
  assert.equal(row.before.conditions.length, 2);
  assert.equal(row.after.conditions.length, 3);
  assert.equal(res.entry.mode, 'duperule');
});

test('apply refuses when the rule or its conditions changed since the plan; nothing is written', async () => {
  const dv = dvAs();
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  ruleOf(dv, IDS.nameRule).iscasesensitive = true;
  await assert.rejects(applied(plan, dv), /has changed since the plan/);
  assert.deepEqual(nonGets(dv), []);
});

test('apply: a publish still running after the wait is reported as written-and-publishing, not failed', async () => {
  const dv = dvAs();
  dv.neverPublishes = true;
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied');
  assert.match(res.rows[0].outcome, /still publishing/);
  // While it still publishes, a new plan is refused; once the platform finishes, the undo still works (advisor 11/16).
  await refused(D.planDupeRuleRevert(dv, { ...res.entry, plan_id: '20261116-150050-abcdef01' }, ctx()), /still publishing/);
  Object.assign(ruleOf(dv, IDS.nameRule), { statecode: 1, statuscode: 2 });
  const back = await D.planDupeRuleRevert(dv, { ...res.entry, plan_id: '20261116-150050-abcdef01' }, ctx());
  assert.deepEqual(back.after.conditions.map((c) => c.attribute).sort(), ['firstname', 'lastname']);
});

test('apply: a rule that does not read back what was written is reported, never called written', async () => {
  const dv = dvAs();
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  dv.dropsConditions = true;
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /^read-back mismatch/);
  assert.equal(res.written, 0);
});

test('apply: a failed condition add leaves the OLD conditions in place, never a rule with none', async () => {
  const dv = dvAs();
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  dv.failOn = 'create duplicateruleconditions';
  await applied(plan, dv);
  assert.deepEqual(condsOf(dv, IDS.nameRule).map((c) => c.baseattributename).sort(), ['firstname', 'lastname']);
});

test('apply: a failure after the unpublish says the rule is UNPUBLISHED, and revert puts the before back', async () => {
  const dv = dvAs();
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  dv.failOn = 'create duplicateruleconditions';
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /failed: boom.*UNPUBLISHED now/);
  dv.failOn = null;
  const entry = { ...res.entry, plan_id: '20261116-150000-abcdef01' };
  const back = await D.planDupeRuleRevert(dv, entry, ctx());
  assert.equal(back.after.published, true);
  const { res: r2 } = await applied(back, dv);
  assert.equal(r2.outcome, 'applied', JSON.stringify(r2.rows[0]));
  const now = condsOf(dv, IDS.nameRule).map((c) => `${c.baseattributename}:${c.ignoreblankvalues}`).sort();
  assert.deepEqual(now, ['firstname:false', 'lastname:false']);
  assert.equal(ruleOf(dv, IDS.nameRule).statuscode, 2);
});

test('revert of Option 1 puts the name-only rule back, and refuses once someone has changed the rule since', async () => {
  const dv = dvAs();
  const { res } = await applied(await D.planDupeRule(dv, valid(job()), ctx()), dv);
  const entry = { ...res.entry, plan_id: '20261116-150100-abcdef01' };
  const back = await D.planDupeRuleRevert(dv, entry, ctx());
  assert.equal(back.reverts_plan_id, '20261116-150100-abcdef01');
  assert.deepEqual(back.after.conditions.map((c) => c.attribute).sort(), ['firstname', 'lastname']);
  ruleOf(dv, IDS.nameRule).description = 'someone else';
  await refused(D.planDupeRuleRevert(dv, entry, ctx()), /changed since plan/, 'snapshot_moved');
});

test('create: a new published rule (Dev lacks the mobile-phone rule); undo turns it off, never deletes', async () => {
  const dv = dvAs();
  const name = 'Contacts with the same Mobile Phone';
  const plan = await D.planDupeRule(dv, valid({ ...job(), mode: 'create', rule: { name, table: 'contact' },
    definition: { conditions: [{ attribute: 'mobilephone', operatorcode: 0, ignoreblankvalues: true }] }, intent: { verb: 'create', rule: name } }), ctx());
  assert.match(plan.severity.lines.join(' '), /Lasting: a new duplicate rule/);
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows[0]));
  const made = dv.data.duplicaterules.find((r) => r.name === name);
  assert.equal(made.statuscode, 2);
  assert.equal(made.excludeinactiverecords, true);
  const back = await D.planDupeRuleRevert(dv, { ...res.entry, plan_id: '20261116-150200-abcdef01' }, ctx());
  assert.equal(back.mode, 'off');
  const { res: r2 } = await applied(back, dv);
  assert.equal(r2.outcome, 'applied');
  assert.equal(made.statuscode, 0);
  assert.ok(dv.data.duplicaterules.includes(made), 'never deleted');
  await refused(D.planDupeRule(dvAs(), valid({ ...job(), mode: 'create', rule: { name: NAME_RULE, table: 'contact' }, definition: { conditions: OPTION_1 }, intent: { verb: 'create', rule: NAME_RULE } }), ctx()), /already exists/);
});

test('off and on: unpublish only, publish only; each undoes the other', async () => {
  const dv = dvAs();
  const off = await D.planDupeRule(dv, valid({ ...job(), mode: 'off', definition: undefined, intent: { verb: 'off', rule: NAME_RULE } }), ctx());
  dv.calls.length = 0;
  const { res } = await applied(off, dv);
  assert.equal(res.outcome, 'applied');
  assert.deepEqual(nonGets(dv).map((c) => c.path), ['UnpublishDuplicateRule']);
  assert.equal(ruleOf(dv, IDS.nameRule).statuscode, 0);
  const on = await D.planDupeRuleRevert(dv, { ...res.entry, plan_id: '20261116-150300-abcdef01' }, ctx());
  assert.equal(on.mode, 'on');
  dv.calls.length = 0;
  const { res: r2 } = await applied(on, dv);
  assert.equal(r2.outcome, 'applied');
  assert.equal(nonGets(dv).length, 1);
  assert.equal(ruleOf(dv, IDS.nameRule).statuscode, 2);
});

test('apply: a plan file edited after it was made is refused before anything is read or written', async () => {
  const dv = dvAs();
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  dv.calls.length = 0;
  const bad = { ...plan, after: { ...plan.after, conditions: [{ attribute: 'firstname', operatorcode: 7, operatorparam: null, ignoreblankvalues: true }] } };
  await assert.rejects(applied(bad, dv), /changed after it was made/);
  assert.deepEqual(dv.calls, []);
});

// ---------- blind review 11/16 (reviews/2026-11-16_duperule) ----------

test('review F1: an unpublish still pending after the wait says it may still land, and "on" can bring the rule back', async () => {
  const dv = fakeDupeDv({ email: userOf.admin, unpublishReads: Infinity });
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /were NOT changed, but the unpublish job may still land.*mode "on"/);
  assert.doesNotMatch(res.rows[0].outcome, /nothing else was changed/);
  assert.equal(res.written, 0);
  assert.deepEqual(condsOf(dv, IDS.nameRule).map((c) => c.baseattributename).sort(), ['firstname', 'lastname']);
  Object.assign(ruleOf(dv, IDS.nameRule), { statecode: 0, statuscode: 0 }); // the job lands later
  const on = await D.planDupeRule(fakeDupeDv({ email: userOf.admin, d: dv.data }), valid({ ...job(), mode: 'on', definition: undefined, intent: { verb: 'on', rule: NAME_RULE } }), ctx());
  assert.equal(on.after.published, true);
});

test('review F3/F4: a condition changed while the prompt is open stops the apply before any write; deletes carry the read tag', async () => {
  const dv = dvAs();
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  dv.calls.length = 0;
  await assert.rejects(applied(plan, dv, { confirm: () => { dv.touch('duplicateruleconditions', IDS.first, {}); return { approved: true }; } }), /changed while the approval was open/);
  assert.deepEqual(nonGets(dv), []);
  const dv2 = dvAs();
  const { res } = await applied(await D.planDupeRule(dv2, valid(job()), ctx()), dv2);
  assert.ok(nonGets(dv2).filter((c) => c.method === 'DELETE').every((c) => /^W\/"\d+"$/.test(c.etag)), 'never If-Match *');
  assert.deepEqual([...res.rows[0].conditions_removed].sort(), [IDS.first, IDS.last].sort());
  assert.equal(res.rows[0].conditions_added.length, 3);
});

test('review F5: a failed read-back after the unpublish still says UNPUBLISHED and how to bring it back', async () => {
  const dv = dvAs();
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  dv.failOn = 'create duplicateruleconditions';
  dv.breakReadsOnFail = true;
  const { res } = await applied(plan, dv);
  assert.equal(res.rows[0].after, null);
  assert.match(res.rows[0].outcome, /UNPUBLISHED and could not be read back.*mode "on"/);
});

test('review F7/F8: the connector warning comes from the app and table, not the plan file; a plan with no date is refused', async () => {
  const dv = dvAs();
  const plan = await D.planDupeRule(dv, valid(job()), ctx());
  const { shown } = await applied({ ...plan, connector: false }, dv);
  assert.match(shown[0].summaryText, /Fundraise Up connector matches donors/);
  const dv2 = dvAs();
  const p2 = await D.planDupeRule(dv2, valid(job()), ctx());
  await assert.rejects(D.applyDupeRule({ ...p2, created: undefined }, { access: ACCESS, connect: () => dv2, confirm: () => ({ approved: true }) }, { id: 'x', file: path.join(HOME, 'nofile.json'), fs }), /says nothing about when it was made/);
});

test('review F13: an undo names what it actually changes', async () => {
  const dv = dvAs();
  const rename = valid(job({ definition: { description: 'ZIP added 11/16' }, intent: { verb: 'update', rule: NAME_RULE, changed: ['description'] } }));
  const { res } = await applied(await D.planDupeRule(dv, rename, ctx()), dv);
  const back = await D.planDupeRuleRevert(dv, { ...res.entry, plan_id: '20261116-150400-abcdef01' }, ctx());
  assert.deepEqual(back.intent.changed, ['description']);
  assert.deepEqual(back.changed, ['description']);
});

test('write.js: Unpublish is unbound with the rule in the body; Publish is bound; anything but a GUID is refused', () => {
  assert.deepEqual(dupRuleCall('unpublish', IDS.nameRule.toUpperCase()), { method: 'POST', path: 'UnpublishDuplicateRule', body: { DuplicateRuleId: IDS.nameRule } });
  assert.deepEqual(dupRuleCall('publish', IDS.nameRule), { method: 'POST', path: `duplicaterules(${IDS.nameRule})/Microsoft.Dynamics.CRM.PublishDuplicateRule`, body: {} });
  assert.throws(() => dupRuleCall('publish', 'x) or (1'), /not a GUID/);
  assert.throws(() => dupRuleCall('delete', IDS.nameRule), /refusing duplicate rule verb/);
});
