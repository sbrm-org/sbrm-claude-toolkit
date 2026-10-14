'use strict';
// The write connection checks the approval itself (1.11.10, guard_review/DESIGN.md §2a, ruled 10/13 fork 2).
// Before this, only the CLI's apply asked for a ticket: a script that loaded the write module with its own
// `confirm` could write. Now every write the connection sends needs the approval that ticket.take() hands back
// for a ticket the guard minted (signed with this machine's plan key). Reads, and the parked Write Log row the
// health check sends on, need none.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-writeapproval-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store'); // never the real store (CLAUDE.md trap)

const T = require('../lib/ticket');
const W = require('../lib/write');

const ID = '20261013-150000-abcdef12';
// A CLI that cannot start: any send that gets PAST the approval check fails at launch instead, so the two
// failures tell apart "refused for no approval" from "allowed through to the CLI".
const NO_CLI = { binary: path.join(HOME, 'no-such-dataverse.exe'), version: 'test' };
const REFUSED = /without an approval/;
const reached = (fn) => assert.throws(fn, (e) => !REFUSED.test(String(e && e.message)), 'got past the approval check');

test('take() hands back an approval that verify() accepts; a forged or altered one is refused', () => {
  T.mint(ID);
  const r = T.take(ID);
  assert.equal(r.ok, true);
  assert.equal(r.approval.key, ID);
  assert.equal(T.verify(r.approval), true);
  assert.ok(Object.isFrozen(r.approval));
  assert.equal(T.verify({ ...r.approval, sig: '0'.repeat(64) }), false, 'a made-up signature');
  assert.equal(T.verify({ ...r.approval, key: '20261013-150000-00000000' }), false, 'moved to another plan');
  assert.equal(T.verify(null), false);
  assert.equal(T.verify({}), false);
});

test('no approval: every write verb is refused before anything is sent', () => {
  const dv = W.writeConnection('https://example.invalid', NO_CLI);
  assert.throws(() => dv.create('contacts', { x: 1 }), REFUSED);
  assert.throws(() => dv.update('contacts', '1', { x: 1 }, 'W/"1"'), REFUSED);
  assert.throws(() => dv.remove('contacts', '1', 'W/"1"'), REFUSED);
  assert.throws(() => dv.merge({}), REFUSED);
  assert.throws(() => dv.metadata('POST', 'EntityDefinitions', {}), REFUSED);
  assert.throws(() => dv.publish({ entities: ['contact'] }), REFUSED);
});

test('a forged approval is refused like none', () => {
  const fake = { key: ID, created: new Date().toISOString(), nonce: '00', sig: 'f'.repeat(64) };
  const dv = W.writeConnection('https://example.invalid', NO_CLI, { approval: fake });
  assert.throws(() => dv.create('contacts', { x: 1 }), REFUSED);
});

test('a good approval lets the write through to the CLI (given directly, or read when the write is sent)', () => {
  T.mint(ID);
  const { approval } = T.take(ID);
  reached(() => W.writeConnection('https://example.invalid', NO_CLI, { approval }).create('contacts', { x: 1 }));
  // The engine opens the connection before resolve takes its ticket, so it passes a getter.
  let later = null;
  const dv = W.writeConnection('https://example.invalid', NO_CLI, { approval: () => later });
  assert.throws(() => dv.update('contacts', '1', { x: 1 }, 'W/"1"'), REFUSED);
  later = approval;
  reached(() => dv.update('contacts', '1', { x: 1 }, 'W/"1"'));
});

test('reads, and the parked Write Log row, need no approval', () => {
  const dv = W.writeConnection('https://example.invalid', NO_CLI);
  reached(() => dv.get('WhoAmI'));
  reached(() => dv.create('sbrm_dataversewritelogs', { sbrm_name: 'x' }));
  // ...but only a NEW log row: nothing else on that table, and no other table by a similar name.
  assert.throws(() => dv.update('sbrm_dataversewritelogs', '1', { x: 1 }, 'W/"1"'), REFUSED);
  assert.throws(() => dv.remove('sbrm_dataversewritelogs', '1', 'W/"1"'), REFUSED);
  assert.throws(() => dv.create('sbrm_dataversewritelogs(1)/x', { x: 1 }), REFUSED);
});

test('the engine passes the approval it took into the write connection it opens', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dataverse-write.js'), 'utf8');
  assert.ok(/deps\.writeConnection\(host, undefined, \{ approval: \(\) => run\.approval \}\)/.test(src), 'connect() hands the run\'s approval to the write connection');
  assert.ok(/run\.approval = r\.approval/.test(src), 'approvalFor() keeps the approval it took');
});
