'use strict';
// `get` (1.11.42): ANY read of the app's Web API, GET only, into a file (Dylan 11/23/26: "go on the general read
// command"), so a staff Claude needs no Copilot-credit MCP call to read. Drives the real command through runCli()
// with a fake read connection; the write connection throws, so any write attempt fails the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-get-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store');
process.env.SBRM_DV_CONFIG = path.join(HOME, 'config');
process.env.SBRM_DV_READS = path.join(HOME, 'reads');
fs.mkdirSync(process.env.SBRM_DV_CONFIG, { recursive: true });
fs.writeFileSync(path.join(process.env.SBRM_DV_CONFIG, 'envs.json'), JSON.stringify({
  donorapp: { host: 'https://example.invalid', name: 'Donor App', hipaa: false },
  recovery: { host: 'https://rec.invalid', name: 'Recovery app', hipaa: true },
}));

const { runCli } = require('../dataverse-write');
const cli = require('../dataverse-write');
const events = require('../lib/events');
const G = require('../lib/get');
const { DataverseError } = require('../lib/cli');

// A read connection that answers paths in order from `answers` (path -> body | Error) and records every call.
function reader(answers) {
  const calls = [];
  return {
    calls,
    host: 'https://example.invalid',
    get(p, opts = {}) {
      calls.push({ p, opts });
      if (!Object.prototype.hasOwnProperty.call(answers, p)) throw new Error(`unexpected GET ${p}`);
      const a = answers[p];
      if (a instanceof Error) throw a;
      return JSON.parse(JSON.stringify(a));
    },
    getMany() { throw new Error('not used'); },
  };
}
function deps(dv) {
  return {
    readConnection: () => dv,
    writeConnection: () => { throw new Error('get must never open a write connection'); },
    eventConnection: () => ({ createEvent: () => ({}) }),
  };
}
function go(argv, d) {
  const real = console.log;
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  try {
    const code = runCli(argv, d);
    return { code, run: cli.lastRun, out: out.join('\n') };
  } finally {
    console.log = real;
  }
}
const readsDir = () => process.env.SBRM_DV_READS;
const files = () => (fs.existsSync(readsDir()) ? fs.readdirSync(readsDir()).sort() : []);
const clearReads = () => { for (const f of files()) fs.rmSync(path.join(readsDir(), f)); };
const saved = () => JSON.parse(fs.readFileSync(path.join(readsDir(), files()[0]), 'utf8'));
const pendingCount = () => events.pendingFor('donorapp').length;

const ROWS = 'contacts?$select=fullname&$filter=statecode%20eq%200&$top=2';

test('one GET of the path, display labels asked for, the answer saved whole; spaces are encoded', () => {
  clearReads();
  const body = { '@odata.context': 'x', value: [{ contactid: 'a', fullname: 'Ann Able' }, { contactid: 'b', fullname: 'Bo Bee' }] };
  const dv = reader({ [ROWS]: body });
  const { code, out } = go(['get', 'donorapp', 'contacts?$select=fullname&$filter=statecode eq 0&$top=2'], deps(dv));
  assert.equal(code, 0, out);
  assert.deepEqual(dv.calls, [{ p: ROWS, opts: { formatted: true, pageSize: 0 } }]);
  assert.equal(files().length, 1);
  assert.match(files()[0], /^donorapp-get-contacts-\d{8}-\d{6}-\d{3}[0-9a-f]{4}\.json$/);
  const s = saved();
  assert.deepEqual(s.body, body);
  assert.equal(s.meta.path, ROWS);
  assert.equal(s.meta.rows, 2);
  assert.match(out, /Read contacts\?\$select=fullname.* from the Donor App: 2 row\(s\)\./);
  assert.doesNotMatch(out, /Ann Able/, 'rows stay out of the conversation without --print');
  assert.match(out, /Nothing was changed\./);
});

test('one object (a record, a definition, a function) is described by its fields; --print shows a small answer', () => {
  clearReads();
  const p = "EntityDefinitions(LogicalName='contact')?$select=LogicalName,EntitySetName";
  const body = { '@odata.context': 'x', LogicalName: 'contact', EntitySetName: 'contacts', MetadataId: 'm' };
  let r = go(['get', 'donorapp', p, '--print'], deps(reader({ [p]: body })));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /one object with 3 field\(s\): LogicalName, EntitySetName, MetadataId/);
  assert.match(r.out, /"EntitySetName": "contacts"/);
  // WhoAmI, a leading slash and the api/data/v9.2/ prefix all come down to the same relative path
  for (const form of ['WhoAmI', '/WhoAmI', 'api/data/v9.2/WhoAmI', '/api/data/v9.2/WhoAmI']) {
    const dv = reader({ WhoAmI: { UserId: 'u' } });
    r = go(['get', 'donorapp', form], deps(dv));
    assert.equal(r.code, 0, `${form}: ${r.out}`);
    assert.equal(dv.calls[0].p, 'WhoAmI');
  }
  // too big to print: said, not printed
  clearReads();
  const big = { value: Array.from({ length: 400 }, (_, i) => ({ n: i, pad: 'x'.repeat(60) })) };
  r = go(['get', 'donorapp', 'things', '--print'], deps(reader({ things: big })));
  assert.equal(r.code, 0);
  assert.match(r.out, /--print skipped: the answer is \d+ characters, over 20000/);
  assert.equal(saved().body.value.length, 400, 'the file still holds all of it');
});

test('--all follows every page up to --max and says when it stopped; without it, more pages are only mentioned', () => {
  const next = (n) => `https://example.invalid/api/data/v9.2/contacts?$skiptoken=${n}`;
  const answers = {
    contacts: { value: [{ n: 1 }, { n: 2 }], '@odata.nextLink': next(2) },
    // the next-page link is sent in its checked form, relative to api/data/v9.2/ (review F2)
    'contacts?$skiptoken=2': { value: [{ n: 3 }, { n: 4 }], '@odata.nextLink': next(3) },
    'contacts?$skiptoken=3': { value: [{ n: 5 }] },
  };
  clearReads();
  let dv = reader(answers);
  let r = go(['get', 'donorapp', 'contacts', '--all'], deps(dv));
  assert.equal(r.code, 0, r.out);
  assert.equal(dv.calls.length, 3);
  assert.ok(dv.calls.every((c) => c.opts.formatted && c.opts.pageSize === 5000));
  assert.deepEqual(saved().body.value.map((x) => x.n), [1, 2, 3, 4, 5]);
  assert.equal(saved().body['@odata.nextLink'], undefined);
  assert.match(r.out, /5 row\(s\) over 3 pages\./);

  clearReads();
  dv = reader(answers);
  r = go(['get', 'donorapp', 'contacts', '--all', '--max', '3'], deps(dv));
  assert.deepEqual(saved().body.value.map((x) => x.n), [1, 2, 3]);
  assert.equal(saved().meta.truncated, true);
  assert.match(r.out, /3 row\(s\) over 2 pages \(more exist: raise --max, or narrow the filter\)/);

  clearReads();
  dv = reader(answers);
  r = go(['get', 'donorapp', 'contacts'], deps(dv));
  assert.equal(dv.calls.length, 1, 'one page only');
  assert.match(r.out, /2 row\(s\) \(more exist: add --all/);
});

test('review F2: a next-page link from Dataverse is held to the same rules; one that breaks them is not followed and nothing is saved', () => {
  const before = pendingCount();
  for (const link of ['https://example.invalid/api/mcp', 'https://example.invalid/api/data/v9.2/contacts(a)/x/$value', 'https://example.invalid/api/data/v9.2/../oauth']) {
    clearReads();
    const dv = reader({ contacts: { value: [{ n: 1 }], '@odata.nextLink': link } });
    const { code, out } = go(['get', 'donorapp', 'contacts', '--all'], deps(dv));
    assert.equal(code, 1, `${link}: ${out}`);
    assert.equal(dv.calls.length, 1, `${link}: the bad link is never requested`);
    assert.match(out, /REFUSED: get\. Nothing was read\./, 'a refusal, not a crash');
    assert.doesNotMatch(out, /^ERROR/m);
    assert.match(out, /next-page link was not followed/);
    assert.equal(files().length, 0, 'nothing saved');
  }
  assert.equal(pendingCount(), before, 'a refused read is not a review item (a crash would be)');
});

test('the query string is not held to the route rules: a filter may compare against any text', () => {
  for (const p of ["contacts?$filter=description eq 'C:\\temp\\x'", "contacts?$filter=contains(fullname,'..')", "accounts?$filter=name eq 'api/mcp'"]) {
    const c = G.cleanPath(p);
    assert.equal(c.problem, undefined, `${p}: ${c.problem}`);
  }
});

test('review F4: two reads of one table in the same second land in two files', () => {
  clearReads();
  const G2 = require('../lib/get');
  const now = new Date('2026-11-23T20:00:00.123Z');
  const opt = {};
  const a = G2.save(readsDir(), { env: 'donorapp', p: 'contacts(a)', opt, result: { body: { who: 'a' }, rows: null, pages: 1, truncated: false }, now });
  const b = G2.save(readsDir(), { env: 'donorapp', p: 'contacts(b)', opt, result: { body: { who: 'b' }, rows: null, pages: 1, truncated: false }, now });
  assert.notEqual(a, b);
  assert.equal(JSON.parse(fs.readFileSync(a, 'utf8')).body.who, 'a');
  assert.equal(JSON.parse(fs.readFileSync(b, 'utf8')).body.who, 'b');
  clearReads();
});

test('the path can only reach this app\'s data API: other hosts, .., $batch, raw /$value and other APIs are refused before any read', () => {
  clearReads();
  const before = pendingCount();
  for (const [p, re] of [
    ['https://evil.example/api/data/v9.2/contacts', /not a full address/],
    ['//evil.example/contacts', /not a full address/],
    ['file:///etc/passwd', /not a full address/],
    ['contacts/../../../oauth', /may not climb out/],
    ['contacts/%2e%2e/x', /may not climb out/],
    ['contacts/.%2e/.%2e/oauth', /may not climb out/],                     // round 2 R2: a half-encoded ..
    ['contacts/%2E./x', /may not climb out/],
    ['contacts%2F..%2Foauth', /may not climb out/],                       // an encoded / around ..
    ['contacts(a)/fullname/%24value', /read a picture with `image`/],     // an encoded $value
    ['%24batch', /\$batch is a POST/],
    ['%61pi/mcp', /only the data API/],                                    // "api" spelt with an escape
    ['contacts/%5C..', /backslash/],
    ['contacts/%zz', /not a valid escape/],
    ['$batch', /\$batch is a POST/],
    ['api/mcp', /only the data API/],
    ['api/data/v9.2/api/mcp', /only the data API/],                       // review F1: the prefix off, then checked
    ['/api/data/v9.2//api/discovery', /only the data API/],
    ['api/discovery/v2.0/Instances', /only the data API/],
    ['msnfp_transactions(a1000000-0000-0000-0000-00000000000a)/sbrm_paymentimage/$value', /read a picture with `image`/],
    ['contacts\\x', /backslash/],
    ['contacts#x', /may not hold #/],
    ['contacts\nX-Other: 1', /control character/],
    ['contacts?=fullname&=statecode eq 0', /the shell took a \$ out of the path/],   // "$select" eaten by the shell
    ['contacts?$select=fullname&=statecode eq 0', /the shell took a \$ out/],
    ['contacts?$select=fullname&&$top=1', /the shell took a \$ out/],
    ['', /name the Web API path/],
    [`contacts?$filter=${'a'.repeat(G.MAX_PATH)}`, /longer than 4000/],
  ]) {
    const dv = reader({});
    const { code, out } = go(['get', 'donorapp', p], deps(dv));
    assert.equal(code, 2, `${p.slice(0, 50)}: ${out}`);
    assert.equal(dv.calls.length, 0, `${p.slice(0, 50)} must not read`);
    assert.match(out, re, p.slice(0, 50));
  }
  // and the usage itself
  for (const argv of [
    ['get'], ['get', 'nowhere', 'contacts'], ['get', 'donorapp', 'contacts', 'extra'], ['get', 'donorapp', 'contacts', '--max', '5'],
    ['get', 'donorapp', 'contacts', '--all', '--max', 'lots'], ['get', 'donorapp', 'contacts', '--name', '../x'], ['get', 'donorapp', 'contacts', '--top', '5'],
  ]) {
    const dv = reader({});
    const { code, out } = go(argv, deps(dv));
    assert.notEqual(code, 0, argv.join(' '));
    assert.equal(dv.calls.length, 0, `${argv.join(' ')} must not read`);
    assert.match(out, /REFUSED/);
  }
  assert.equal(files().length, 0);
  assert.equal(pendingCount(), before, 'a misspelt read is not a review item');
});

test('a Dataverse error is reported back with its message, writes no file, opens no review item', () => {
  clearReads();
  const before = pendingCount();
  const dv = reader({ 'contacts?$select=nope': new DataverseError("GET contacts: Could not find a property named 'nope'") });
  const { code, out } = go(['get', 'donorapp', 'contacts?$select=nope'], deps(dv));
  assert.equal(code, 1);
  assert.match(out, /Could not find a property named 'nope'/);
  assert.match(out, /Check the path/);
  assert.equal(files().length, 0);
  assert.equal(pendingCount(), before);
});

test('round 2 R5: a setup problem on a read (no Dataverse CLI) IS recorded for Dylan\'s review; a refusal is not', () => {
  const before = pendingCount();
  const had = new Set(events.pendingFor('donorapp'));
  const noCli = {
    readConnection: () => { throw Object.assign(new Error('the Dataverse CLI was not found on this machine'), { code: 'cli_missing' }); },
    writeConnection: () => { throw new Error('never'); },
    eventConnection: () => { throw new Error('offline in this test'); },
  };
  for (const argv of [['get', 'donorapp', 'WhoAmI'], ['image', 'donorapp', 'msnfp_transactions', 'sbrm_paymentimage', 'a1000000-0000-0000-0000-00000000000a'], ['query', 'donorapp', 'contacts']]) {
    const { code, out } = go(argv, noCli);
    assert.equal(code, 1, `${argv[0]}: ${out}`);
    assert.match(out, /Dataverse CLI was not found/);
  }
  assert.equal(pendingCount(), before + 3, 'each setup problem is waiting to be sent');
  const pending = require('../lib/store').dir(path.join('events', 'pending'));
  for (const f of events.pendingFor('donorapp')) if (!had.has(f)) fs.rmSync(path.join(pending, f), { force: true });
  assert.equal(pendingCount(), before);
});

test('refuses to save into a git-tracked folder or OneDrive, before reading', () => {
  const real = process.env.SBRM_DV_READS;
  try {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-repo-'));
    spawnSync('git', ['init', '-q', repo]);
    process.env.SBRM_DV_READS = path.join(repo, 'reads');
    let dv = reader({ contacts: { value: [] } });
    let r = go(['get', 'recovery', 'contacts'], deps(dv));
    assert.equal(r.code, 1);
    assert.match(r.out, /git/i);
    assert.equal(dv.calls.length, 0);
    process.env.SBRM_DV_READS = path.join(HOME, 'OneDrive - SBRM', 'reads');
    dv = reader({ contacts: { value: [] } });
    r = go(['get', 'donorapp', 'contacts'], deps(dv));
    assert.equal(r.code, 1);
    assert.match(r.out, /OneDrive/);
    assert.equal(dv.calls.length, 0);
  } finally {
    process.env.SBRM_DV_READS = real;
  }
});

test('the read connection has no way to write: it offers GET and nothing else', () => {
  const { readConnection } = require('../lib/cli');
  const dv = readConnection('https://example.invalid', { binary: process.execPath, version: 'stub' });
  assert.deepEqual(Object.keys(dv).filter((k) => typeof dv[k] === 'function').sort(), ['get', 'getMany']);
});
