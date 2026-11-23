'use strict';
// `image` (1.11.42): a READ-ONLY download of a record's full-size image column into a file (Dylan 11/23/26:
// "everything that's like recurring that we can build into the toolkit, we should, particularly if it doesn't use
// copilot credits"). First use: a mail batch's check scans, msnfp_transaction.sbrm_paymentimage, after the MCP
// file_download tool stopped answering ("User is not entitled to perform operation", 11/23/26). Drives the real
// command through runCli() with a fake read connection; the write connection throws, so any write attempt fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-image-'));
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
const image = require('../lib/image');
const { DataverseError } = require('../lib/cli');

const A = 'a1000000-0000-0000-0000-00000000000a';
const B = 'b2000000-0000-0000-0000-00000000000b';
const C = 'c3000000-0000-0000-0000-00000000000c';
// Every byte value, so a text round trip that drops or rewrites one is caught (the /$value form through the CLI did).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from([0xff, 0xd9])]);
// A PNG's signature, a header chunk's worth of bytes and the IEND chunk that closes every PNG.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(25, 1),
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);

// A read connection that answers image paths from `answers` (path -> value | Error) and records every call.
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
      return a;
    },
    getMany() { throw new Error('not used'); },
  };
}
function deps(dv) {
  return {
    readConnection: () => dv,
    writeConnection: () => { throw new Error('image must never open a write connection'); },
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
const pendingCount = () => events.pendingFor('donorapp').length;
const full = (id) => `msnfp_transactions(${id})/sbrm_paymentimage?size=full`;
const b64 = (buf) => ({ '@odata.context': 'x', value: buf.toString('base64') });

test('reads each record\'s full-size image with one GET of the column (no /$value) and saves the exact bytes', () => {
  clearReads();
  const dv = reader({ [full(A)]: b64(JPEG), [full(B)]: b64(PNG) });
  const { code, out } = go(['image', 'donorapp', 'msnfp_transactions', 'sbrm_paymentimage', A, B.toUpperCase()], deps(dv));
  assert.equal(code, 0, out);
  assert.deepEqual(dv.calls.map((c) => c.p), [full(A), full(B)], 'one GET per record, the JSON form, ids lower-cased');
  assert.ok(dv.calls.every((c) => !/\$value/.test(c.p)), 'never the raw-bytes form');
  assert.deepEqual(files(), [`donorapp-msnfp_transactions-sbrm_paymentimage-${A}.jpg`, `donorapp-msnfp_transactions-sbrm_paymentimage-${B}.png`]);
  assert.ok(fs.readFileSync(path.join(readsDir(), files()[0])).equals(JPEG), 'every byte survives');
  assert.ok(fs.readFileSync(path.join(readsDir(), files()[1])).equals(PNG));
  assert.match(out, /Read 2 of 2 full-size image\(s\) of msnfp_transactions\.sbrm_paymentimage from the Donor App into:/);
  assert.match(out, new RegExp(`${A}\\.jpg  \\(${JPEG.length} bytes, jpg\\)`));
  assert.match(out, /Nothing was changed\. Open a file with the Read tool to look at it\./);
  assert.match(out, /deleted after 7 days/);
});

test('--thumb asks for the small image; a record with no image and a failed read are said, the rest are still saved', () => {
  clearReads();
  let dv = reader({ [`msnfp_transactions(${A})/sbrm_paymentimage`]: b64(JPEG) });
  let r = go(['image', 'donorapp', 'msnfp_transactions', 'sbrm_paymentimage', A, '--thumb'], deps(dv));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(files(), [`donorapp-msnfp_transactions-sbrm_paymentimage-${A}-thumb.jpg`]);
  assert.match(r.out, /Read 1 of 1 thumbnail image\(s\)/);

  clearReads();
  dv = reader({
    [full(A)]: b64(JPEG),
    [full(B)]: { '@odata.context': 'x', value: null },                               // a cash gift: no scan
    ...exists(B),
    [full(C)]: new DataverseError('GET x: msnfp_transaction With Id = c3 Does Not Exist', { code: '0x80040217' }),
  });
  r = go(['image', 'donorapp', 'msnfp_transactions', 'sbrm_paymentimage', A, B, C], deps(dv));
  assert.equal(r.code, 1, 'a record that could not be read makes the run fail');
  assert.equal(files().length, 1, 'the one that could be read is saved');
  assert.match(r.out, /Read 1 of 3 full-size image\(s\)/);
  assert.match(r.out, new RegExp(`No image on 1 record\\(s\\): ${B}`));
  assert.match(r.out, new RegExp(`NOT read ${C}: there is no such record`));
});

// The record exists (its createdon reads) unless the test says otherwise: the second GET an empty answer makes.
const exists = (id) => ({ [`msnfp_transactions(${id})?$select=createdon`]: { createdon: '2026-11-23T17:45:21Z' } });

test('fetchOne: an empty column, a missing record, a misspelt column, a non-picture and an oversized image are told apart', () => {
  const one = (answer, more = exists(A)) => image.fetchOne(reader({ [full(A)]: answer, ...more }), 'msnfp_transactions', 'sbrm_paymentimage', A);
  // As measured live 11/23/26: an empty image column and a record that does not exist BOTH answer with nothing.
  assert.deepEqual(one({ value: '' }), { none: true });
  assert.deepEqual(one({}), { none: true });
  assert.deepEqual(one({}, { [`msnfp_transactions(${A})?$select=createdon`]: new DataverseError('GET x: Does Not Exist', { code: '0x80040217' }) }), { problem: 'there is no such record' });
  assert.deepEqual(one({}, { [`msnfp_transactions(${A})?$select=createdon`]: {} }), { problem: 'there is no such record' });
  // review F7: a misspelt column answers "Resource not found for the segment" (0x80060888, live 11/23/26); never "no image"
  assert.match(one(new DataverseError("GET x: Resource not found for the segment 'sbrm_paymentimagex'", { code: '0x80060888' })).problem, /Resource not found for the segment 'sbrm_paymentimagex'/);
  assert.match(one(new DataverseError('GET x: 404 Not Found', { code: '404' })).problem, /404 Not Found/);
  assert.deepEqual(one({ value: 'not base64 at all!' }), { problem: 'the answer was not an image (the column may not be an image column)' });
  assert.deepEqual(one({ value: 42 }), { problem: 'the answer was not an image (the column may not be an image column)' });
  // review F8: text that happens to decode is not a picture
  assert.deepEqual(one({ value: 'YWJj' }), { problem: 'the answer is not a picture (the column may not be an image column)' });
  assert.match(one(new DataverseError("GET x: Could not find a property named 'nope'", { code: '0x80060888' })).problem, /Could not find a property named 'nope'/);
  assert.match(one({ value: Buffer.alloc(image.MAX_BYTES + 1).toString('base64') }).problem, /over the \d+-byte limit/);
  assert.ok(one(b64(JPEG)).bytes.equals(JPEG));
  const TIF = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(40, 7)]);
  assert.ok(one(b64(TIF)).bytes.equals(TIF), 'a TIFF is a picture an image column can hold');
  // round 2 R6: a picture that starts right but is cut short is not saved
  assert.deepEqual(one({ value: '/9j/' }), { problem: 'the jpg picture is cut short (3 bytes); it was not saved' });
  assert.match(one(b64(JPEG.slice(0, JPEG.length - 1))).problem, /jpg picture is cut short/);
  assert.match(one(b64(PNG.slice(0, PNG.length - 4))).problem, /png picture is cut short/);
  assert.match(one(b64(TIF.slice(0, 10))).problem, /tif picture is cut short/);
  const padded = Buffer.concat([JPEG, Buffer.alloc(16)]);
  assert.ok(one(b64(padded)).bytes.equals(padded), 'zero padding after the end marker is fine');
  // an error that is not Dataverse's own is not swallowed
  assert.throws(() => one(new Error('disk on fire')), /disk on fire/);
});

test('a misspelt column fails the run with Dataverse\'s words instead of reporting "No image" (review F7)', () => {
  clearReads();
  const seg = (id) => `msnfp_transactions(${id})/sbrm_paymentimagex?size=full`;
  const err = new DataverseError("GET x: Resource not found for the segment 'sbrm_paymentimagex'", { code: '0x80060888' });
  const dv = reader({ [seg(A)]: err, [seg(B)]: err });
  const { code, out } = go(['image', 'donorapp', 'msnfp_transactions', 'sbrm_paymentimagex', A, B], deps(dv));
  assert.equal(code, 1);
  assert.doesNotMatch(out, /No image on/);
  assert.match(out, new RegExp(`NOT read ${A}: GET x: Resource not found for the segment 'sbrm_paymentimagex'`));
  assert.equal(files().length, 0);
});

test('kind: the file type comes from the bytes, never from a name', () => {
  assert.equal(image.kind(JPEG), 'jpg');
  assert.equal(image.kind(PNG), 'png');
  assert.equal(image.kind(Buffer.from('GIF89a....')), 'gif');
  assert.equal(image.kind(Buffer.from('BM......')), 'bmp');
  assert.equal(image.kind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'webp');
  assert.equal(image.kind(Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00])), 'tif');
  assert.equal(image.kind(Buffer.from('<html>')), 'bin');
  assert.equal(image.kind(Buffer.alloc(0)), 'bin');
});

test('usage refusals read nothing, write nothing and are not review items', () => {
  clearReads();
  const before = pendingCount();
  const base = ['image', 'donorapp', 'msnfp_transactions', 'sbrm_paymentimage'];
  for (const argv of [
    ['image'],
    ['image', 'nowhere', 'msnfp_transactions', 'sbrm_paymentimage', A],
    ['image', 'donorapp', 'msnfp_transactions;drop', 'sbrm_paymentimage', A],
    ['image', 'donorapp', 'msnfp_transactions', 'sbrm_paymentimage/$value', A],
    ['image', 'donorapp', 'msnfp_transactions', 'Payment Image', A],
    base,                                                   // no record id
    [...base, 'not-a-guid'],
    [...base, `${A})/sbrm_other`],                          // an id that tries to reach another path
    [...base, A, A.toUpperCase()],                          // the same record twice
    [...base, ...Array.from({ length: image.MAX_IDS + 1 }, (_, i) => `a1000000-0000-0000-0000-${String(i).padStart(12, '0')}`)],
    [...base, A, '--size', 'full'],                         // an option this command does not have
    [...base, '--thumb', A],                                // --thumb takes no value: it goes last
  ]) {
    const dv = reader({});
    const { code, out } = go(argv, deps(dv));
    assert.notEqual(code, 0, argv.slice(0, 6).join(' '));
    assert.equal(dv.calls.length, 0, `${argv.slice(0, 6).join(' ')} must not read`);
    assert.match(out, /REFUSED/);
  }
  assert.equal(files().length, 0);
  assert.equal(pendingCount(), before);
});

test('refuses to save into a git-tracked folder or OneDrive (a scan is a donor\'s check)', () => {
  const real = process.env.SBRM_DV_READS;
  try {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-repo-'));
    spawnSync('git', ['init', '-q', repo]);
    process.env.SBRM_DV_READS = path.join(repo, 'reads');
    let dv = reader({ [full(A)]: b64(JPEG) });
    let r = go(['image', 'donorapp', 'msnfp_transactions', 'sbrm_paymentimage', A], deps(dv));
    assert.equal(r.code, 1);
    assert.match(r.out, /git/i);
    assert.equal(dv.calls.length, 0, 'refused before reading');
    process.env.SBRM_DV_READS = path.join(HOME, 'OneDrive - SBRM', 'reads');
    dv = reader({ [full(A)]: b64(JPEG) });
    r = go(['image', 'donorapp', 'msnfp_transactions', 'sbrm_paymentimage', A], deps(dv));
    assert.equal(r.code, 1);
    assert.match(r.out, /OneDrive/);
    assert.equal(dv.calls.length, 0);
  } finally {
    process.env.SBRM_DV_READS = real;
  }
});

test('images older than 7 days are deleted on the next run; newer ones and other files stay', () => {
  clearReads();
  fs.mkdirSync(readsDir(), { recursive: true });
  const old = path.join(readsDir(), `donorapp-msnfp_transactions-sbrm_paymentimage-${B}.jpg`);
  const fresh = path.join(readsDir(), `donorapp-msnfp_transactions-sbrm_paymentimage-${C}.png`);
  const other = path.join(readsDir(), 'notes.txt');
  for (const f of [old, fresh, other]) fs.writeFileSync(f, 'x');
  const t = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(old, t, t);
  fs.utimesSync(other, t, t);
  const { code, out } = go(['image', 'donorapp', 'msnfp_transactions', 'sbrm_paymentimage', A], deps(reader({ [full(A)]: b64(JPEG) })));
  assert.equal(code, 0, out);
  assert.ok(!fs.existsSync(old), 'old image purged');
  assert.ok(fs.existsSync(fresh), 'recent image kept');
  assert.ok(fs.existsSync(other), 'a file this command did not make is left alone');
  assert.match(out, /1 older file\(s\) deleted now/);
  fs.rmSync(other);
});

test('review F5 + F6: get and query purge old scans too; a half-written temp file older than a day goes, a fresh one stays', () => {
  clearReads();
  fs.mkdirSync(readsDir(), { recursive: true });
  const scan = path.join(readsDir(), `donorapp-msnfp_transactions-sbrm_paymentimage-${B}.jpg`);
  const staleTmp = path.join(readsDir(), `donorapp-get-contacts-20261101-000000-000abcd.json.4242.tmp`);
  const freshTmp = path.join(readsDir(), `donorapp-msnfp_transactions-sbrm_paymentimage-${C}.jpg.4343.tmp`);
  const notOurs = path.join(readsDir(), 'something.4242.tmp');
  for (const f of [scan, staleTmp, freshTmp, notOurs]) fs.writeFileSync(f, 'x');
  const eight = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  const twoDays = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(scan, eight, eight);
  fs.utimesSync(staleTmp, twoDays, twoDays);
  fs.utimesSync(notOurs, twoDays, twoDays);
  const { code, out } = go(['get', 'donorapp', 'WhoAmI'], deps(reader({ WhoAmI: { UserId: 'u' } })));
  assert.equal(code, 0, out);
  assert.ok(!fs.existsSync(scan), 'get purged the 8-day-old scan');
  assert.ok(!fs.existsSync(staleTmp), 'a temp file older than a day is purged');
  assert.ok(fs.existsSync(freshTmp), 'a fresh temp file (a run in progress) stays');
  assert.ok(fs.existsSync(notOurs), 'a temp file with another shape is not ours');
  // query too
  fs.writeFileSync(scan, 'x');
  fs.utimesSync(scan, eight, eight);
  const q = go(['query', 'donorapp', 'contacts'], deps(reader({ contacts: { value: [] } })));
  assert.equal(q.code, 0, q.out);
  assert.ok(!fs.existsSync(scan), 'query purged the 8-day-old scan');
  for (const f of [freshTmp, notOurs]) fs.rmSync(f);
  clearReads();
});

test('review F3: a reads folder that is a junction or symlink into a git folder or OneDrive is refused before reading', () => {
  const real = process.env.SBRM_DV_READS;
  try {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-repo-'));
    spawnSync('git', ['init', '-q', repo]);
    fs.mkdirSync(path.join(repo, 'reads'));
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-safe-')), 'reads');
    fs.symlinkSync(path.join(repo, 'reads'), link, 'junction');
    process.env.SBRM_DV_READS = link;
    let dv = reader({ [full(A)]: b64(JPEG) });
    let r = go(['image', 'donorapp', 'msnfp_transactions', 'sbrm_paymentimage', A], deps(dv));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /which is really .*git-tracked/s);
    assert.equal(dv.calls.length, 0, 'refused before reading');
    // a folder below the link that does not exist yet is judged by where it would really be
    process.env.SBRM_DV_READS = path.join(link, 'not', 'yet');
    dv = reader({ WhoAmI: { UserId: 'u' } });
    r = go(['get', 'donorapp', 'WhoAmI'], deps(dv));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /git-tracked/);
    assert.equal(dv.calls.length, 0);
    // into a folder named OneDrive
    const od = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-od-')), 'OneDrive - SBRM');
    fs.mkdirSync(od);
    const link2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-safe-')), 'reads');
    fs.symlinkSync(od, link2, 'junction');
    process.env.SBRM_DV_READS = link2;
    dv = reader({ WhoAmI: { UserId: 'u' } });
    r = go(['get', 'donorapp', 'WhoAmI'], deps(dv));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /which is really .*OneDrive/s);
    assert.equal(dv.calls.length, 0);
  } finally {
    process.env.SBRM_DV_READS = real;
  }
});
