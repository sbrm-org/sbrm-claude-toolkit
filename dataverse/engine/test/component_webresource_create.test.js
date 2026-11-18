'use strict';
// A NEW web resource (1.11.40, Dylan 11/18/26: "let's put the feature in the toolkit now and release it"): a component
// job on `webresourceset` with mode "create" makes a text web resource (an HTML page, a script, CSS, XML) in a named
// unmanaged SBRM solution, publishes that web resource only, and reads it back. Admin (new code in the app); undo cannot
// remove it. Until now a new web resource was the maker portal's (1.11.28). On the fake Dataverse (test/fake_component.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Never touch the real store (CLAUDE.md trap).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-webres-create-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');

const C = require('../lib/component');
const { fakeComponentDv, IDS, ENVS, b64 } = require('./fake_component');

const ENVS_NODEV = { ...ENVS, soberliving: { host: 'https://donor.invalid', name: 'Sober Living app', publisher: IDS.pub } };
const ACCESS = { people: { 'admin@example.org': { envs: { soberliving: 'admin' } }, 'dev@example.org': { envs: { soberliving: 'develop' } } } };
const ctx = (over = {}) => ({ envs: ENVS_NODEV, access: ACCESS, warnRows: 50, readEnv: () => { throw new Error('no dev read expected'); }, ...over });
const userOf = { dev: 'dev@example.org', admin: 'admin@example.org' };
const dvAs = (who = 'admin', over = {}) => fakeComponentDv({ email: userOf[who], ...over });

const NAME = 'sbrm_/BedBoard/BedBoard.html';
const PAGE = '<!DOCTYPE html>\r\n<html>\r\n<head><title>Bed Board</title></head>\r\n<body>\r\n<p>Beds</p>\r\n</body>\r\n</html>\r\n';
const SOLUTION = 'SBRMAdHocChanges';

function newJob({ name = NAME, content = b64(PAGE), type = 1, displayname = 'Bed Board', description, solution = SOLUTION, definition, ...rest } = {}) {
  const def = definition || { content, webresourcetype: type };
  if (!definition && displayname !== undefined) def.displayname = displayname;
  if (!definition && description !== undefined) def.description = description;
  return {
    contract: 'sbrm-dv-job/1', kind: 'component', env: 'soberliving', source: 'claude-session', reason: 'A page that shows every bed and who is in it.',
    component: { set: 'webresourceset', name }, mode: 'create', solution, definition: def,
    intent: { verb: 'create', component: 'web resource', name }, ...rest,
  };
}

function valid(raw) {
  const r = C.validateComponentJob(raw, { envs: ENVS_NODEV });
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  return r.job;
}
const errs = (raw) => C.validateComponentJob(raw, { envs: ENVS_NODEV }).errors.join('\n');

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
    access: ACCESS, connect: () => dv, confirm: (x) => { shown.push(x); return { approved: true }; }, sleep: () => {}, ...over,
  }, { id: `20261118-1500${String(fileN).padStart(2, '0')}-abcdef01`, file, fs });
  return { res, shown };
}

// ---------- validation ----------

test('a new web resource: create is accepted with a name, a text type, content and a solution', () => {
  const job = valid(newJob());
  assert.equal(job.mode, 'create');
  assert.equal(job.component.id, null);
  assert.deepEqual(job.definition, { content: b64(PAGE), webresourcetype: 1, displayname: 'Bed Board' });
  valid(newJob({ displayname: undefined }));
  valid(newJob({ description: 'The recovery bed board.' }));
  valid(newJob({ name: 'sbrm_/Client/BedCheck.js', type: 3, content: b64('var x = 1;\r\n') }));
  valid(newJob({ name: 'sbrm_bedboard.css', type: 2, content: b64('body { margin: 0; }\n') }));
  valid(newJob({ name: 'sbrm_/BedBoard/BedBoard.htm' }));
});

test('a new web resource: what the job file may not say', () => {
  assert.match(errs(newJob({ definition: { content: b64(PAGE) } })), /"definition\.webresourcetype" is required for a new web resource/);
  for (const type of [5, 0, 11, '1', 1.5, null]) {
    assert.match(errs(newJob({ type })), /"definition\.webresourcetype" must be one of 1 \(HTML\), 2 \(CSS\), 3 \(JavaScript\), 4 \(XML\)/, String(type));
  }
  for (const name of ['BedBoard.html', 'new_/BedBoard.html', 'sbrm_/Bed Board.html', 'sbrm_//BedBoard.html', 'sbrm_/BedBoard/', 'sbrm_/Bed$Board.html', 'sbrm_/../x.html']) {
    assert.match(errs(newJob({ name })), /"component\.name" of a new web resource must start with "sbrm_"/, name);
  }
  assert.match(errs(newJob({ name: 'sbrm_/BedBoard/BedBoard.js' })), /the name of a new HTML web resource must end in \.html or \.htm/);
  assert.match(errs(newJob({ name: 'sbrm_/BedBoard/BedBoard.html', type: 3, content: b64('var x;') })), /the name of a new JavaScript web resource must end in \.js/);
  assert.match(errs(newJob({ name: 'sbrm_BedBoard' })), /must end in \.html or \.htm/);
  assert.match(errs(newJob({ displayname: 'Bed\nBoard' })), /"definition\.displayname" must be one line of text, at most 200 characters/);
  assert.match(errs(newJob({ displayname: '' })), /"definition\.displayname" must be one line of text/);
  assert.match(errs(newJob({ displayname: 'x'.repeat(201) })), /at most 200 characters/);
  assert.match(errs(newJob({ definition: { webresourcetype: 1 } })), /"definition\.content" is required for a new web resource/);
  assert.match(errs(newJob({ content: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') })), /definition\.content.*UTF-8 text/);
  assert.match(errs(newJob({ definition: { content: b64(PAGE), webresourcetype: 1, ismanaged: false } })), /unknown key "definition\.ismanaged"/);
  assert.match(errs(newJob({ solution: null })), /"solution" is required for a create/);
  assert.match(errs({ ...newJob(), component: { set: 'webresourceset', name: NAME, id: IDS.wr } }), /"component\.id" is for changing an existing component/);
  assert.match(errs({ ...newJob(), snapshot_hash: 'a'.repeat(64) }), /"snapshot_hash" is for changes to an existing component/);
  // an update still takes neither create field
  assert.match(errs({
    contract: 'sbrm-dv-job/1', kind: 'component', env: 'soberliving', source: 'claude-session', reason: 'x',
    component: { set: 'webresourceset', id: IDS.wr, name: 'sbrm_contact.js' }, mode: 'update', snapshot_hash: 'a'.repeat(64),
    definition: { content: b64('var x;'), displayname: 'New name' }, intent: { verb: 'update', component: 'web resource', name: 'sbrm_contact.js', changed: ['content'] },
  }), /unknown key "definition\.displayname" for a web resource update/);
});

test('a web resource is still not deleted, switched or handed over here', () => {
  for (const mode of ['delete', 'on', 'off', 'own']) {
    const e = errs({
      contract: 'sbrm-dv-job/1', kind: 'component', env: 'soberliving', source: 'claude-session', reason: 'x',
      component: { set: 'webresourceset', id: IDS.wr, name: 'sbrm_contact.js' }, mode, snapshot_hash: 'a'.repeat(64),
      intent: { verb: mode, component: 'web resource', name: 'sbrm_contact.js' },
    });
    assert.match(e, /a web resource is created or changed here \(modes "create" and "update"\); one is removed in the maker portal/, mode);
  }
});

// ---------- plan ----------

test('plan of a new page: admin, reads only, says what it creates, its size and fingerprint, where it goes, and that undo cannot remove it', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(newJob()), ctx());
  assert.deepEqual(nonGets(dv), [], 'a plan reads only');
  assert.equal(plan.mode, 'create');
  assert.equal(plan.need, 'admin');
  assert.match(plan.need_why.join(' '), /it adds code that runs in the app \(a new web resource\)/);
  assert.equal(plan.solution.uniquename, SOLUTION);
  assert.deepEqual(plan.create_extra, { webresourcetype: 1, displayname: 'Bed Board' });
  assert.deepEqual(plan.after_definition, { content: b64(PAGE), description: null });
  const summary = C.componentSummary(plan);
  assert.match(summary, /Create the web resource 'sbrm_\/BedBoard\/BedBoard\.html' in the Sober Living app in solution SBRM Ad-Hoc Changes/);
  const sha = crypto.createHash('sha256').update(Buffer.from(PAGE, 'utf8')).digest('hex');
  assert.match(summary, new RegExp(`Content: 7 lines, ${Buffer.from(PAGE).length} bytes, sha256 ${sha}`));
  assert.match(summary, /Also sets: webresourcetype 1 \(HTML\), displayname Bed Board/);
  assert.match(summary, /Loaded by: no form names it/);
  assert.match(summary, /Published after the change \(this web resource only\)/);
  assert.match(summary, /Undo cannot remove the new web resource; it is removed in the maker portal\./);
  assert.match(summary, /Lasting/i);
  assert.match(summary, /creates the web resource 'sbrm_\/BedBoard\/BedBoard\.html'/);
  // the detail carries the code being approved, line by line, without carriage returns
  const detail = C.componentDetail(plan);
  assert.match(detail, /^ {2}content \+ <!DOCTYPE html>$/m);
  assert.match(detail, /^ {2}content \+ <p>Beds<\/p>$/m);
  assert.doesNotMatch(detail, /\r/);
  assert.match(detail, /Solution: SBRM Ad-Hoc Changes \(SBRMAdHocChanges\)/);
});

test('a long new file shows its first 200 lines in the detail and counts the rest', async () => {
  const dv = dvAs('admin');
  const big = Array.from({ length: 260 }, (_, i) => `<p>line ${i + 1}</p>`).join('\n');
  const plan = await C.planComponent(dv, valid(newJob({ content: b64(big) })), ctx());
  const d = plan.diff.detail;
  assert.equal(d.filter((l) => /^ {2}content \+ /.test(l)).length, 200);
  assert.equal(d[d.length - 1], '  content ... 60 more line(s)');
  assert.match(C.componentSummary(plan), /Content: 260 lines/);
});

test('a new web resource takes admin: a develop person is refused', async () => {
  const dv = dvAs('dev');
  await refused(C.planComponent(dv, valid(newJob()), ctx()), /takes admin access .* it adds code that runs in the app \(a new web resource\)/, 'not_permitted');
  assert.deepEqual(nonGets(dv), []);
});

test('a name that is already taken is refused, published or only saved in the maker portal', async () => {
  const dv = dvAs('admin');
  await refused(C.planComponent(dv, valid(newJob({ name: 'sbrm_contact.js', type: 3, content: b64('var x = 1;') })), ctx()),
    /a web resource named 'sbrm_contact\.js' already exists in the Sober Living app/, 'invalid_job');
  // case-blind, as Dataverse compares names
  await refused(C.planComponent(dv, valid(newJob({ name: 'sbrm_Contact.js', type: 3, content: b64('var x = 1;') })), ctx()), /already exists/, 'invalid_job');
  // one that exists only in the unpublished layer (created in the maker portal, never published)
  const dv2 = dvAs('admin');
  dv2.data.drafts.webresourceset['dddddddd-0000-0000-0000-000000000001'] = { webresourceid: 'dddddddd-0000-0000-0000-000000000001', name: NAME, webresourcetype: 1, content: b64(PAGE) };
  await refused(C.planComponent(dv2, valid(newJob()), ctx()), /a web resource named 'sbrm_\/BedBoard\/BedBoard\.html' already exists/, 'invalid_job');
});

test('the solution must be an unmanaged SBRM one', async () => {
  const dv = dvAs('admin');
  await refused(C.planComponent(dv, valid(newJob({ solution: 'NoSuchSolution' })), ctx()), /there is no solution "NoSuchSolution"/, 'invalid_job');
  await refused(C.planComponent(dv, valid(newJob({ solution: 'msdynce_Fundraising' })), ctx()), /managed/, 'not_permitted');
  await refused(C.planComponent(dv, valid(newJob({ solution: 'Crfb496' })), ctx()), /not under the SBRM publisher/, 'not_permitted');
});

test('a new web resource a form ALREADY names goes live at once: the plan says so', async () => {
  const dv = dvAs('admin');
  delete dv.data.webresourceset[IDS.wr]; // the contact form still names sbrm_contact.js
  const plan = await C.planComponent(dv, valid(newJob({ name: 'sbrm_contact.js', type: 3, content: b64('var x = 1;\r\n'), displayname: 'Contact form script' })), ctx());
  const summary = C.componentSummary(plan);
  assert.match(summary, /Loaded by: the form 'SBRM Donor: Contact' \(contact\)/);
  assert.match(summary, /Can't be fully undone: publishes new code in the web resource 'sbrm_contact\.js', which runs at once for everyone who opens the form 'SBRM Donor: Contact' \(contact\)/);
});

// ---------- apply ----------

test('apply of a new page: one POST into the solution, a publish of that web resource only, a read-back, the new id in the log row', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(newJob({ description: 'The recovery bed board.' })), ctx());
  const { res, shown } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied');
  assert.equal(shown.length, 1);
  assert.match(shown[0].summaryText, /Create the web resource/);
  const writes = nonGets(dv);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], {
    method: 'POST', path: 'webresourceset', solution: SOLUTION,
    body: { webresourcetype: 1, displayname: 'Bed Board', name: NAME, content: b64(PAGE), description: 'The recovery bed board.' },
  });
  const id = res.rows[0].id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(writes[1], { method: 'POST', path: 'PublishXml', body: { webresources: [`{${id}}`] } });
  assert.equal(res.rows[0].outcome, 'written');
  assert.equal(res.rows[0].before, null);
  assert.equal(res.rows[0].after.definition.content, b64(PAGE));
  assert.equal(res.rows[0].after.name, NAME);
  assert.equal(dv.data.webresourceset[id].solution, SOLUTION);
  assert.equal(res.entry.action, 'create');
  assert.equal(res.entry.rows[0].id, id);
});

test('apply reads the new web resource back: content, type or display name that did not land is a mismatch, never "written"', async () => {
  for (const [drop, re] of [['content', /read-back mismatch: .*content/], ['webresourcetype', /read-back mismatch: .*its type reads back/], ['displayname', /read-back mismatch: .*its display name reads back/]]) {
    const dv = dvAs('admin');
    const plan = await C.planComponent(dv, valid(newJob()), ctx());
    dv.readBackDrops = drop;
    const { res } = await applied(plan, dv);
    assert.equal(res.outcome, 'applied with problems', drop);
    assert.match(res.rows[0].outcome, re, drop);
  }
});

test('apply: a failed publish is said, never "written"', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(newJob()), ctx());
  dv.publishFails = true;
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /not published/);
  assert.match(res.rows[0].notes.join(' '), /saved but NOT published/);
});

test('apply refuses when the name was taken since the plan, and writes nothing', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(newJob()), ctx());
  dv.data.webresourceset['eeeeeeee-0000-0000-0000-000000000001'] = { webresourceid: 'eeeeeeee-0000-0000-0000-000000000001', name: NAME, ismanaged: false, webresourcetype: 1, content: b64('<p>x</p>') };
  await assert.rejects(applied(plan, dv), (e) => {
    assert.equal(e.name, 'ApplyRefused');
    assert.equal(e.code, 'snapshot_moved');
    assert.match(e.message, /a web resource named 'sbrm_\/BedBoard\/BedBoard\.html' now exists/);
    return true;
  });
  assert.deepEqual(nonGets(dv), []);
});

test('apply refuses a person who is no longer admin, and a plan file edited to add a field', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(newJob()), ctx());
  await assert.rejects(applied(plan, dv, { access: { people: { 'admin@example.org': { envs: { soberliving: 'develop' } } } } }), (e) => {
    assert.equal(e.name, 'ApplyRefused');
    assert.match(e.message, /takes admin access because it adds code that runs in the app \(a new web resource\)/);
    return true;
  });
  for (const tampered of [
    { ...plan, create_extra: { ...plan.create_extra, ismanaged: false } },
    { ...plan, create_extra: { ...plan.create_extra, 'ownerid@odata.bind': '/systemusers(x)' } },
    { ...plan, after_definition: { ...plan.after_definition, name: 'sbrm_other.html' } },
    { ...plan, create_extra: { ...plan.create_extra, webresourcetype: 5 } },
    { ...plan, create_extra: { displayname: 'Bed Board' } },
    { ...plan, create_extra: { ...plan.create_extra, webresourcetype: 3 } },
    { ...plan, create_extra: { ...plan.create_extra, displayname: 'Bed\nBoard' } },
    { ...plan, component: { ...plan.component, name: 'evil.html' } },
    { ...plan, component: { ...plan.component, name: 'sbrm_/a/../b.html' } },
    { ...plan, after_definition: { ...plan.after_definition, content: 'not base64!' } },
    { ...plan, after_definition: { ...plan.after_definition, content: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') } },
  ]) {
    await assert.rejects(applied(tampered, dv), (e) => { assert.equal(e.code, 'plan_tampered'); return true; });
  }
  assert.deepEqual(nonGets(dv), []);
  assert.deepEqual(C.planShapeProblems(plan), []);
});

test('apply works the change out again: a plan file edited to another type or content shows what is really written', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(newJob()), ctx());
  const edited = { ...plan, after_definition: { ...plan.after_definition, content: b64('<script>alert(1)</script>\n') } };
  const { shown } = await applied(edited, dv);
  const sha = crypto.createHash('sha256').update(Buffer.from('<script>alert(1)</script>\n')).digest('hex');
  assert.match(shown[0].summaryText, new RegExp(`sha256 ${sha}`), 'the prompt shows the fingerprint of the bytes this apply writes');
  assert.match(shown[0].detailText, /content \+ <script>alert\(1\)<\/script>/);
});

test('a create that times out on this computer is looked for by its name and never sent twice', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(newJob()), ctx());
  dv.timeoutOnWrite = 'after';
  const { res } = await applied(plan, dv, { clock: () => 0 });
  assert.equal(nonGets(dv).filter((c) => c.path === 'webresourceset').length, 1, 'one POST only');
  assert.equal(res.rows[0].outcome, 'written');
  assert.match(res.rows[0].notes.join(' '), /timed out on this computer, but the change landed/);
  assert.match(res.rows[0].id, /^[0-9a-f-]{36}$/);
});

// ---------- review 2026-11-18_wr_create (Codex seat) ----------

test('review F2: a name taken while the approval was waiting is refused before the POST', async () => {
  for (const layer of ['published', 'unpublished']) {
    const dv = dvAs('admin');
    const plan = await C.planComponent(dv, valid(newJob()), ctx());
    const other = { webresourceid: 'eeeeeeee-0000-0000-0000-000000000002', name: NAME, ismanaged: false, webresourcetype: 1, content: b64('<p>theirs</p>') };
    const confirm = () => {
      if (layer === 'published') dv.data.webresourceset[other.webresourceid] = other;
      else dv.data.drafts.webresourceset[other.webresourceid] = other;
      return { approved: true };
    };
    await assert.rejects(applied(plan, dv, { confirm }), (e) => {
      assert.equal(e.name, 'ApplyRefused', layer);
      assert.match(e.message, /a web resource named 'sbrm_\/BedBoard\/BedBoard\.html' was made while the approval was waiting/, layer);
      return true;
    });
    assert.deepEqual(nonGets(dv), [], `${layer}: nothing written`);
  }
});

test('review F2 (the class): a view name taken while the approval was waiting is refused too', async () => {
  const dv = dvAs('admin');
  const ACC = { people: { 'admin@example.org': { envs: { soberliving: 'admin' } } } };
  const job = valid({
    contract: 'sbrm-dv-job/1', kind: 'component', env: 'soberliving', source: 'claude-session', reason: 'x', mode: 'create', solution: SOLUTION,
    component: { set: 'savedqueries', name: 'Beds Board View' },
    definition: { returnedtypecode: 'contact', fetchxml: '<fetch><entity name="contact"><attribute name="fullname" /></entity></fetch>', layoutxml: '<grid name="resultset" object="2" jump="fullname" select="1" icon="1" preview="1"><row name="result" id="contactid"><cell name="fullname" width="300" /></row></grid>' },
    intent: { verb: 'create', component: 'view', name: 'Beds Board View' },
  });
  const plan = await C.planComponent(dv, job, ctx({ access: ACC }));
  const confirm = () => { dv.data.savedqueries['eeeeeeee-0000-0000-0000-000000000003'] = { savedqueryid: 'eeeeeeee-0000-0000-0000-000000000003', name: 'Beds Board View', returnedtypecode: 'contact', ismanaged: false }; return { approved: true }; };
  await assert.rejects(applied(plan, dv, { confirm, access: ACC }), /a view named 'Beds Board View' was made while the approval was waiting/);
  assert.deepEqual(nonGets(dv), []);
});

test('review F3: after a timeout, a same-named web resource with OTHER content is never taken for ours or published', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(newJob()), ctx());
  // the POST times out and does NOT land; meanwhile someone saves a different page under the same name (unpublished)
  dv.timeoutOnWrite = 'before';
  const theirs = { webresourceid: 'eeeeeeee-0000-0000-0000-000000000004', name: NAME, ismanaged: false, webresourcetype: 1, content: b64('<p>theirs</p>') };
  const realCreate = dv.create;
  dv.create = (...args) => { dv.data.drafts.webresourceset[theirs.webresourceid] = theirs; return realCreate(...args); };
  let t = 0;
  const { res } = await applied(plan, dv, { clock: () => (t += 60000) });
  assert.equal(dv.calls.filter((c) => c.path === 'PublishXml').length, 0, 'nothing published');
  assert.match(res.rows[0].outcome, /^failed: the request timed out/);
  assert.equal(dv.data.drafts.webresourceset[theirs.webresourceid].content, b64('<p>theirs</p>'));
});

test('review F3: after a timeout, our own page that landed is still found and published', async () => {
  const dv = dvAs('admin', { unpublishedUntilPublish: true });
  const plan = await C.planComponent(dv, valid(newJob()), ctx());
  dv.timeoutOnWrite = 'after';
  const { res } = await applied(plan, dv, { clock: () => 0 });
  assert.equal(res.rows[0].outcome, 'written');
  assert.equal(dv.calls.filter((c) => c.path === 'PublishXml').length, 1);
});

test('review F5: a new web resource that reads back under another name is a mismatch, never "written"', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(newJob()), ctx());
  const realPublish = dv.publish;
  dv.publish = (x) => { const id = Object.keys(dv.data.webresourceset).find((k) => dv.data.webresourceset[k].name === NAME); dv.touch('webresourceset', id, { name: 'sbrm_/Other.html' }); return realPublish(x); };
  const { res } = await applied(plan, dv);
  assert.equal(res.outcome, 'applied with problems');
  assert.match(res.rows[0].outcome, /read-back mismatch: .*its name reads back 'sbrm_\/Other\.html'/);
});

// ---------- undo ----------

test('revert of a created web resource: it stays, and the refusal says where it is removed', async () => {
  const dv = dvAs('admin');
  const plan = await C.planComponent(dv, valid(newJob()), ctx());
  const { res } = await applied(plan, dv);
  await refused(C.planComponentRevert(dv, { ...res.entry, env: 'soberliving' }, ctx()),
    /the web resource 'sbrm_\/BedBoard\/BedBoard\.html' stays: revert does not delete what it created; a web resource is removed in the maker portal/, 'nothing_to_undo');
});

test('a created web resource can then be changed like any other (snapshot, update, publish)', async () => {
  const dv = dvAs('admin');
  const { res } = await applied(await C.planComponent(dv, valid(newJob()), ctx()), dv);
  const id = res.rows[0].id;
  const next = PAGE.replace('<p>Beds</p>', '<p>Beds and rooms</p>');
  const job = valid({
    contract: 'sbrm-dv-job/1', kind: 'component', env: 'soberliving', source: 'claude-session', reason: 'Say rooms too.',
    component: { set: 'webresourceset', id, name: NAME }, mode: 'update', definition: { content: b64(next) },
    snapshot_hash: C.snapshot('webresourceset', dv.data.webresourceset[id]).hash,
    intent: { verb: 'update', component: 'web resource', name: NAME, changed: ['content'] },
  });
  const up = await applied(await C.planComponent(dv, job, ctx()), dv);
  assert.equal(up.res.rows[0].outcome, 'written');
  assert.equal(dv.data.webresourceset[id].content, b64(next));
});
