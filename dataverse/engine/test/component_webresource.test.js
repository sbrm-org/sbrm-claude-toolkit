'use strict';
// Web resources (task #6hwP6PqfgwVp7gWr, Dylan 11/5/26: "add script support to the toolkit"): a component job on
// `webresourceset` changes an existing text web resource's content (a form's JavaScript) or description: snapshot,
// plan with a readable diff, apply, PublishXml of that web resource only, read-back of the decoded content, revert.
// On the fake Dataverse (test/fake_component.js), whose web resources are shaped as read live in the Sober Living app
// 11/6/26 (canonical base64, CRLF, RetrieveUnpublishedMultiple answers for webresourceset).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Never touch the real store (CLAUDE.md trap).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-webres-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const C = require('../lib/component');
const { publishXml } = require('../lib/write');
const { fakeComponentDv, IDS, ENVS, ACCESS, SCRIPT, b64 } = require('./fake_component');

const ctx = (over = {}) => ({ envs: ENVS, access: ACCESS, warnRows: 50, readEnv: () => { throw new Error('no dev read expected'); }, ...over });
const userOf = { dev: 'dev@example.org', admin: 'admin@example.org' };
const dvAs = (who = 'admin', over = {}) => fakeComponentDv({ email: userOf[who], ...over });
const NAME = 'sbrm_contact.js';
// Sober Living has no dev copy; the fake's donorapp does, so cite nothing and expect the dev line there. Use an env with
// no dev copy for the routine cases.
const ENVS_NODEV = { ...ENVS, soberliving: { host: 'https://donor.invalid', name: 'Sober Living app', publisher: IDS.pub } };
const ctxNoDev = (over = {}) => ctx({ envs: ENVS_NODEV, access: { people: { 'admin@example.org': { envs: { soberliving: 'admin' } }, 'dev@example.org': { envs: { soberliving: 'develop' } } } }, ...over });

const NEW_SCRIPT = SCRIPT.replace('setVisible(true)', 'setVisible(false)').replace('};\r\n', '};\r\nForm.onSave = function () {};\r\n');

function snap(dv, id = IDS.wr) {
  return C.snapshot('webresourceset', dv.data.webresourceset[id]);
}

function wrJob(dv, { content, description, changed = ['content'], id = IDS.wr, name = NAME, env = 'soberliving', mode = 'update', ...rest } = {}) {
  const definition = {};
  if (content !== undefined) definition.content = content;
  if (description !== undefined) definition.description = description;
  return {
    contract: 'sbrm-dv-job/1', kind: 'component', env, source: 'claude-session', reason: 'Receipt Number only for Cash and Check.',
    component: { set: 'webresourceset', id, name }, mode, definition, snapshot_hash: snap(dv, id).hash,
    intent: { verb: mode, component: 'web resource', name, changed }, ...rest,
  };
}

function valid(raw, envs = ENVS_NODEV) {
  const r = C.validateComponentJob(raw, { envs });
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

let fileN = 0;
async function applied(plan, dv, over = {}) {
  fileN += 1;
  const file = path.join(HOME, `plan-${fileN}.json`);
  fs.writeFileSync(file, '{}');
  const shown = [];
  const res = await C.applyComponent({ ...plan, created: new Date().toISOString() }, {
    access: ctxNoDev().access, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, sleep: () => {}, ...over,
  }, { id: `20261106-1200${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown };
}

// ---------- validation ----------

test('web resource job: update only, content must be canonical base64 of UTF-8 text, sections are content and description', () => {
  const dv = dvAs();
  valid(wrJob(dv, { content: b64(NEW_SCRIPT) }));
  valid(wrJob(dv, { description: 'Receipt by method (11/6).', changed: ['description'] }));
  const errs = (raw) => C.validateComponentJob(raw, { envs: ENVS_NODEV }).errors.join('\n');
  for (const mode of ['create', 'delete', 'on', 'off', 'own']) {
    assert.match(errs({ ...wrJob(dv, { content: b64(NEW_SCRIPT) }), mode, intent: { verb: mode, component: 'web resource', name: NAME } }), /web resource/i, mode);
  }
  assert.match(errs(wrJob(dv, { content: 'not base64 at all!' })), /definition\.content.*base64/);
  assert.match(errs(wrJob(dv, { content: `${b64(NEW_SCRIPT)}\n` })), /definition\.content.*base64/, 'whitespace or a line break is not the canonical form');
  assert.match(errs(wrJob(dv, { content: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') })), /definition\.content.*UTF-8 text/);
  assert.match(errs(wrJob(dv, { content: '' })), /definition\.content/);
  assert.match(errs(wrJob(dv, { content: b64(NEW_SCRIPT), changed: ['script'] })), /changed names script; a web resource has: content, description/);
  assert.match(errs({ ...wrJob(dv, { content: b64(NEW_SCRIPT) }), definition: { content: b64(NEW_SCRIPT), webresourcetype: 3 } }), /unknown key "definition\.webresourcetype"/);
});

// ---------- snapshot ----------

test('web resource snapshot: the same bytes hash the same, any byte (a line ending included) does not', () => {
  const dv = dvAs();
  const a = snap(dv);
  assert.equal(a.hash, C.snapshot('webresourceset', { ...dv.data.webresourceset[IDS.wr] }).hash);
  assert.notEqual(a.hash, C.snapshot('webresourceset', { ...dv.data.webresourceset[IDS.wr], content: b64(SCRIPT.replace(/\r\n/g, '\n')) }).hash);
  assert.notEqual(a.hash, C.snapshot('webresourceset', { ...dv.data.webresourceset[IDS.wr], description: 'x' }).hash);
  assert.equal(a.name, NAME);
});

// ---------- plan ----------

test('plan of a script change: admin, a readable diff, the forms that load it, a live-code warning, publishes that web resource only, reads only', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(wrJob(dv, { content: b64(NEW_SCRIPT) })), ctxNoDev());
  assert.deepEqual(nonGets(dv), [], 'a plan reads only');
  assert.equal(plan.need, 'admin');
  assert.match(plan.need_why.join(' '), /code that runs in the app/);
  assert.deepEqual(plan.diff.sections, ['content']);
  const summary = C.componentSummary(plan);
  assert.match(summary, /Change the web resource 'sbrm_contact\.js' in the Sober Living app/);
  assert.match(summary, /Content: 5 lines -> 6 lines \(1 removed, 2 added\)/);
  assert.match(summary, /Loaded by: the form 'SBRM Donor: Contact' \(contact\)/);
  assert.match(summary, /Can't be fully undone: publishes new code in the web resource 'sbrm_contact\.js'/);
  assert.match(summary, /Published after the change \(this web resource only\)/);
  assert.deepEqual(plan.publish, { webresources: [`{${IDS.wr}}`] });
  const detail = C.componentDetail(plan);
  assert.match(detail, /^ {2}content - {3}f\.getControl\("telephone1"\)\.setVisible\(true\);$/m, 'the removed line, without its CR');
  assert.match(detail, /^ {2}content \+ {3}f\.getControl\("telephone1"\)\.setVisible\(false\);$/m);
  assert.match(detail, /^ {2}content \+ Form\.onSave = function \(\) \{\};$/m);
  assert.doesNotMatch(detail, /\r/, 'no carriage return reaches the pop-up');
  // one header per hunk (new-file line numbers), the removed line before its replacement, indentation kept
  // (NEW_SCRIPT's first "};" ends line 1, `var Form = Form || {};`, so onSave lands as the new line 2)
  assert.deepEqual(plan.diff.detail, [
    '  content @ line 2',
    '  content + Form.onSave = function () {};',
    '  content @ line 5',
    '  content -   f.getControl("telephone1").setVisible(true);',
    '  content +   f.getControl("telephone1").setVisible(false);',
  ]);
});

test('a develop person may change a web resource\'s description, not its code', async () => {
  const dv = dvAs('dev');
  await refused(C.planComponent(dv, valid(wrJob(dv, { content: b64(NEW_SCRIPT) })), ctxNoDev()), /takes admin access .* code that runs in the app/, 'not_permitted');
  const plan = await C.planComponent(dv, valid(wrJob(dv, { description: 'Receipt by method (11/6).', changed: ['description'] })), ctxNoDev());
  assert.equal(plan.need, 'develop');
  assert.deepEqual(plan.severity.lines, [], 'a description is routine');
});

test('line endings alone: one plain line, never every line of the file shown as changed', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(wrJob(dv, { content: b64(SCRIPT.replace(/\r\n/g, '\n')) })), ctxNoDev());
  assert.deepEqual(plan.diff.sections, ['content']);
  assert.ok(plan.diff.lines.some((l) => /Line endings: CRLF -> LF/.test(l)), plan.diff.lines.join('\n'));
  assert.ok(!plan.diff.detail.some((l) => /^ {2}content [-+] /.test(l)), plan.diff.detail.join('\n'));
});

test('plan refuses: an image (not text), a managed one, a renamed id, unpublished edits, a moved snapshot, no change', async () => {
  const dv = dvAs('admin');
  const img = { ...wrJob(dv, { content: b64('x'), id: IDS.wrimg, name: 'sbrm_/img/logo.png' }) };
  await refused(C.planComponent(dv, valid(img), ctxNoDev()), /only text web resources .* are changed here/, 'not_permitted');
  await refused(C.planComponent(dv, valid(wrJob(dv, { content: b64('var y;'), id: IDS.mwr, name: 'msdyn_/Common.js' })), ctxNoDev()), /MANAGED web resource/, 'not_permitted');
  await refused(C.planComponent(dv, valid(wrJob(dv, { content: b64(NEW_SCRIPT), name: 'sbrm_other.js' })), ctxNoDev()), /is named 'sbrm_contact\.js'/, 'invalid_job');
  await refused(C.planComponent(dv, valid(wrJob(dv, { content: b64(SCRIPT) })), ctxNoDev()), /already has this definition/, 'every_row_refused');
  const j = valid(wrJob(dv, { content: b64(NEW_SCRIPT) }));
  dv.data.drafts.webresourceset[IDS.wr] = { content: b64('// edited in the maker portal, not published') };
  await refused(C.planComponent(dv, j, ctxNoDev()), /has unpublished edits/, 'invalid_job');
  delete dv.data.drafts.webresourceset[IDS.wr];
  dv.touch('webresourceset', IDS.wr, { content: b64(`${SCRIPT}// changed since\r\n`) });
  await refused(C.planComponent(dv, j, ctxNoDev()), /has changed since the snapshot/, 'snapshot_moved');
});

// ---------- review 1.11.28 (C1, Codex seat, 11/6/26) ----------

test('F1: a change past the 240th character of a long line is shown in full, so two different lines never read the same', async () => {
  const dv = dvAs('admin');
  const long = `var cfg = "${'x'.repeat(300)}"; doA();`;
  dv.data.webresourceset[IDS.wr].content = b64(`${long}\r\n`);
  const plan = await C.planComponent(dv, valid(wrJob(dv, { content: b64(`${long.replace('doA()', 'doB()')}\r\n`) })), ctxNoDev());
  const minus = plan.diff.detail.find((l) => l.startsWith('  content - '));
  const plus = plan.diff.detail.find((l) => l.startsWith('  content + '));
  assert.notEqual(minus.slice(12), plus.slice(12), 'the two lines must read differently');
  assert.match(plus, /doB\(\);$/);
});

test('F2: an unpublished edit to the display name alone is a draft too: refused, never published along', async () => {
  const dv = dvAs('admin');
  const j = valid(wrJob(dv, { description: 'Receipt by method (11/6).', changed: ['description'] }));
  dv.data.drafts.webresourceset[IDS.wr] = { displayname: 'Renamed in the maker portal' };
  await refused(C.planComponent(dv, j, ctxNoDev()), /has unpublished edits/, 'invalid_job');
});

test('F5: binary content and text that spells its base64 never normalise (or hash) the same', () => {
  const bin = Buffer.from([0xff]).toString('base64');
  const text = b64(`base64:${bin}`);
  const row = (content) => ({ webresourceid: IDS.wr, name: NAME, content, description: null });
  assert.notEqual(C.snapshot('webresourceset', row(bin)).hash, C.snapshot('webresourceset', row(text)).hash);
});

// ---------- apply ----------

test('apply a script change: one PATCH of the content with If-Match, PublishXml of that web resource only, decoded read-back, full before and after logged', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(wrJob(dv, { content: b64(NEW_SCRIPT) })), ctxNoDev());
  const { res, shown } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied', JSON.stringify(res.rows));
  assert.match(shown[0].summaryText, /Can't be fully undone: publishes new code/);
  const writes = nonGets(dv);
  assert.deepEqual(writes.map((c) => `${c.method} ${c.path}`), [`PATCH webresourceset(${IDS.wr})`, 'POST PublishXml']);
  assert.equal(writes[0].etag, 'W/"1"');
  assert.deepEqual(Object.keys(writes[0].body), ['content'], 'only the content is sent');
  assert.deepEqual(writes[1].body, { webresources: [`{${IDS.wr}}`] }, 'only this web resource is published, never PublishAllXml');
  assert.equal(Buffer.from(dv.data.webresourceset[IDS.wr].content, 'base64').toString('utf8'), NEW_SCRIPT);
  const e = res.entry;
  assert.equal(e.table, 'webresourceset');
  assert.equal(e.rows[0].before.definition.content, b64(SCRIPT));
  assert.equal(e.rows[0].after.definition.content, b64(NEW_SCRIPT));
});

test('apply: a read before the publish shows through is re-read until it settles; one that never does is a mismatch, never written', async () => {
  const run = async (lag) => {
    const dv = dvAs('admin');
    dv.publishLag = lag;
    let slept = 0;
    const plan = await C.planComponent(dv, valid(wrJob(dv, { content: b64(NEW_SCRIPT) })), ctxNoDev());
    const { res } = await applied(plan, dv, { sleep: () => { slept += 1; } });
    return { row: res.rows[0], slept };
  };
  const ok = await run(2);
  assert.equal(ok.row.outcome, 'written');
  assert.equal(ok.row.after.definition.content, b64(NEW_SCRIPT));
  const never = await run(1000);
  assert.match(never.row.outcome, /read-back mismatch: the definition read back differs from what was sent \(content\)/);
});

test('apply: a failed publish is reported as saved but not published, never written', async () => {
  const dv = dvAs('admin');
  dv.publishFails = true;
  const { res } = await applied(await C.planComponent(dv, valid(wrJob(dv, { content: b64(NEW_SCRIPT) })), ctxNoDev()), dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].notes.join(' '), /saved but NOT published/);
});

test('apply refuses a plan file edited to send another field, and an edit made since the plan; nothing written', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(wrJob(dv, { content: b64(NEW_SCRIPT) })), ctxNoDev());
  await assert.rejects(applied({ ...plan, sent_fields: ['content', 'webresourcetype'], after_definition: { ...plan.after_definition, webresourcetype: 1 } }, dv, { confirm: () => { throw new Error('no pop-up'); } }), (e) => e.code === 'plan_tampered');
  dv.touch('webresourceset', IDS.wr, { content: b64(`${SCRIPT}// changed since\r\n`) });
  await assert.rejects(applied(plan, dv, { confirm: () => { throw new Error('no pop-up'); } }), (e) => e.code === 'snapshot_moved');
  assert.deepEqual(nonGets(dv).filter((c) => c.method !== 'PATCH' || !c.path.startsWith('webresourceset')), []);
  assert.equal(nonGets(dv).length, 0);
});

// ---------- revert ----------

test('revert a script change: PATCHes the logged content back and publishes, only while it still holds what was written', async () => {
  const dv = dvAs('admin');
  const { res } = await applied(await C.planComponent(dv, valid(wrJob(dv, { content: b64(NEW_SCRIPT) })), ctxNoDev()), dv);
  const entry = { ...res.entry, env: 'soberliving', plan_id: '20261106-120000-abcdef01' };
  const rp = await C.planComponentRevert(dv, entry, ctxNoDev());
  assert.match(C.componentSummary(rp), /Content: 6 lines -> 5 lines \(2 removed, 1 added\)/);
  await applied(rp, dv);
  assert.equal(Buffer.from(dv.data.webresourceset[IDS.wr].content, 'base64').toString('utf8'), SCRIPT);

  const moved = dvAs('admin');
  const r2 = await applied(await C.planComponent(moved, valid(wrJob(moved, { content: b64(NEW_SCRIPT) })), ctxNoDev()), moved);
  moved.touch('webresourceset', IDS.wr, { content: b64('// edited by someone since') });
  await refused(C.planComponentRevert(moved, { ...r2.res.entry, env: 'soberliving', plan_id: '20261106-120001-abcdef01' }, ctxNoDev()), /a revert would overwrite someone's later change/, 'snapshot_moved');
});

// ---------- the publish body ----------

test('PublishXml names the web resource by id, and refuses anything that is not an id', () => {
  assert.equal(publishXml({ webresources: [`{${IDS.wr}}`] }), `<importexportxml><webresources><webresource>{${IDS.wr}}</webresource></webresources></importexportxml>`);
  assert.throws(() => publishXml({ webresources: ['<x/>'] }), /refusing to publish/);
});
