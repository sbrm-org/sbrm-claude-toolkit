'use strict';
// `query` (1.11.8): READ-ONLY bulk reads into a file, for staff scripts (Dylan 10/9/26: "especially daian will
// need to do reads over hundreds of rows"). Drives the real command through runCli() with a fake paging
// connection; the write connection throws, so any write attempt fails the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-query-'));
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

const FV = '@OData.Community.Display.V1.FormattedValue';

// A connection that serves `pages` in order and records every call.
function pager(pages, { fail = null } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    host: 'https://example.invalid',
    get(p, opts = {}) {
      calls.push({ p, opts });
      if (fail) throw fail;
      const page = pages[i] || { value: [] };
      i += 1;
      return page;
    },
    getMany() { throw new Error('not used'); },
  };
}

function deps(dv) {
  return {
    readConnection: () => dv,
    writeConnection: () => { throw new Error('query must never open a write connection'); },
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
const files = () => (fs.existsSync(readsDir()) ? fs.readdirSync(readsDir()) : []);
const clearReads = () => { for (const f of files()) fs.rmSync(path.join(readsDir(), f)); };
const pendingCount = () => events.pendingFor('donorapp').length;

const page1 = {
  value: [
    { '@odata.etag': 'W/"1"', contactid: 'a1', fullname: 'Ann Able', statecode: 0, [`statecode${FV}`]: 'Active' },
    { '@odata.etag': 'W/"2"', contactid: 'b2', fullname: 'Bo "Bee", Jr.', statecode: 1, [`statecode${FV}`]: 'Inactive' },
  ],
  '@odata.nextLink': 'https://example.invalid/api/data/v9.2/contacts?$select=fullname&$skiptoken=%3Ccookie%3E',
};
const page2 = { value: [{ '@odata.etag': 'W/"3"', contactid: 'c3', fullname: 'Cy\nLines', statecode: 0, [`statecode${FV}`]: 'Active' }] };

test('pages through every nextLink and writes one JSON file with all rows', () => {
  clearReads();
  const dv = pager([page1, page2]);
  const { code, out } = go(['query', 'donorapp', 'contacts', '--select', 'contactid,fullname,statecode',
    '--filter', "statecode eq 0 and contains(fullname,'a&b')", '--orderby', 'fullname desc'], deps(dv));
  assert.equal(code, 0, out);
  assert.equal(dv.calls.length, 2);
  const first = dv.calls[0].p;
  assert.match(first, /^contacts\?\$select=contactid,fullname,statecode&\$filter=/);
  assert.ok(first.includes(encodeURIComponent("statecode eq 0 and contains(fullname,'a&b')")), first);
  assert.ok(first.includes('$orderby=' + encodeURIComponent('fullname desc')), first);
  assert.equal(dv.calls[0].opts.formatted, true);
  assert.equal(dv.calls[0].opts.pageSize, 5000);
  assert.equal(dv.calls[1].p, '/api/data/v9.2/contacts?$select=fullname&$skiptoken=%3Ccookie%3E');
  assert.equal(files().length, 1);
  const data = JSON.parse(fs.readFileSync(path.join(readsDir(), files()[0]), 'utf8'));
  assert.equal(data.rows.length, 3);
  assert.equal(data.meta.count, 3);
  assert.equal(data.meta.truncated, false);
  assert.equal(data.meta.env, 'donorapp');
  assert.equal(data.meta.table, 'contacts');
  assert.ok(!('@odata.etag' in data.rows[0]), 'etags dropped');
  assert.equal(data.rows[1]['statecode@label'], 'Inactive', 'formatted values become <col>@label');
  assert.match(out, /3 rows/);
  assert.ok(out.includes(path.join(readsDir(), files()[0])), 'prints the file path');
  assert.ok(!out.includes('Ann Able') && !out.includes('Bo "Bee"'), 'never prints row data');
});

test('--max stops early and says so', () => {
  clearReads();
  const dv = pager([page1, page2]);
  const { code, out } = go(['query', 'donorapp', 'contacts', '--max', '2'], deps(dv));
  assert.equal(code, 0, out);
  assert.equal(dv.calls.length, 1, 'no second page fetched');
  const data = JSON.parse(fs.readFileSync(path.join(readsDir(), files()[0]), 'utf8'));
  assert.equal(data.rows.length, 2);
  assert.equal(data.meta.truncated, true);
  assert.match(out, /stopped at --max 2/i);
});

test('--csv writes a CSV with label columns and safe quoting', () => {
  clearReads();
  const dv = pager([page1, page2]);
  const { code } = go(['query', 'donorapp', 'contacts', '--csv', '--name', 'gik-donors'], deps(dv));
  assert.equal(code, 0);
  const [f] = files();
  assert.match(f, /^donorapp-contacts-gik-donors-\d{8}-\d{6}\.csv$/);
  const txt = fs.readFileSync(path.join(readsDir(), f), 'utf8');
  const lines = txt.split('\r\n');
  assert.equal(lines[0], 'contactid,fullname,statecode,statecode@label');
  assert.ok(txt.includes('"Bo ""Bee"", Jr."'), 'quotes doubled, comma field quoted');
  assert.ok(txt.includes('"Cy\nLines"'), 'newline field quoted');
});

test('usage refusals write nothing and are not review items', () => {
  clearReads();
  const before = pendingCount();
  for (const argv of [
    ['query'],
    ['query', 'nowhere', 'contacts'],
    ['query', 'donorapp', 'contacts;drop'],
    ['query', 'donorapp', 'contacts', '--select', 'full name'],
    ['query', 'donorapp', 'contacts', '--max', 'lots'],
    ['query', 'donorapp', 'contacts', '--max', '0'],
    ['query', 'donorapp', 'contacts', '--name', '../escape'],
    ['query', 'donorapp', 'contacts', '--top', '5'],
  ]) {
    const dv = pager([page1]);
    const { code, out } = go(argv, deps(dv));
    assert.notEqual(code, 0, argv.join(' '));
    assert.equal(dv.calls.length, 0, `${argv.join(' ')} must not read`);
    assert.match(out, /REFUSED/);
  }
  assert.equal(files().length, 0);
  assert.equal(pendingCount(), before);
});

test('a Dataverse error (bad filter) is reported back, writes no file, opens no review item', () => {
  clearReads();
  const before = pendingCount();
  const { DataverseError } = require('../lib/cli');
  const dv = pager([], { fail: new DataverseError("GET contacts: Could not find a property named 'nope'") });
  const { code, out } = go(['query', 'donorapp', 'contacts', '--filter', 'nope eq 1'], deps(dv));
  assert.equal(code, 1);
  assert.match(out, /Could not find a property named 'nope'/);
  assert.equal(files().length, 0);
  assert.equal(pendingCount(), before);
});

test('refuses to write into a git-tracked folder or OneDrive (client data never goes where it can travel)', () => {
  const real = process.env.SBRM_DV_READS;
  try {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-repo-'));
    spawnSync('git', ['init', '-q', repo]);
    process.env.SBRM_DV_READS = path.join(repo, 'reads');
    let dv = pager([page1, page2]);
    let r = go(['query', 'recovery', 'contacts'], deps(dv));
    assert.equal(r.code, 1);
    assert.match(r.out, /git/i);
    assert.equal(dv.calls.length, 0, 'refused before reading');
    process.env.SBRM_DV_READS = path.join(HOME, 'OneDrive - SBRM', 'reads');
    dv = pager([page1, page2]);
    r = go(['query', 'donorapp', 'contacts'], deps(dv));
    assert.equal(r.code, 1);
    assert.match(r.out, /OneDrive/);
  } finally {
    process.env.SBRM_DV_READS = real;
  }
});

test('files older than 7 days are deleted on the next query; newer ones stay', () => {
  clearReads();
  fs.mkdirSync(readsDir(), { recursive: true });
  const old = path.join(readsDir(), 'donorapp-contacts-20260101-000000.json');
  const fresh = path.join(readsDir(), 'donorapp-contacts-20261008-000000.json');
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(fresh, '{}');
  const t = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(old, t, t);
  const { code, out } = go(['query', 'donorapp', 'contacts'], deps(pager([page2])));
  assert.equal(code, 0);
  assert.ok(!fs.existsSync(old), 'old file purged');
  assert.ok(fs.existsSync(fresh), 'recent file kept');
  assert.match(out, /deleted after 7 days/);
});

test('--expand passes through encoded; formatted labels on lookups too', () => {
  clearReads();
  const dv = pager([{ value: [{ msnfp_name: 'TRN-1', _msnfp_customerid_value: 'x', [`_msnfp_customerid_value${FV}`]: 'Ann Able' }] }]);
  const { code } = go(['query', 'donorapp', 'msnfp_transactions', '--select', 'msnfp_name,_msnfp_customerid_value',
    '--expand', 'msnfp_DesignationId($select=msnfp_name)'], deps(dv));
  assert.equal(code, 0);
  assert.ok(dv.calls[0].p.includes('$expand=' + encodeURIComponent('msnfp_DesignationId($select=msnfp_name)')));
  const data = JSON.parse(fs.readFileSync(path.join(readsDir(), files()[0]), 'utf8'));
  assert.equal(data.rows[0]['_msnfp_customerid_value@label'], 'Ann Able');
});
