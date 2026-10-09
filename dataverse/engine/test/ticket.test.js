'use strict';
// One-time approval tickets (DESIGN.md §10n, 1.11.0): minted by the guard when Claude Code asks the person,
// used up by the engine before it writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-ticket-'));
process.env.SBRM_DV_HOME = path.join(HOME, 'store'); // never the real store (CLAUDE.md trap)

const T = require('../lib/ticket');
const ID = '20261008-120000-abcdef12';
const dirOf = () => path.join(process.env.SBRM_DV_HOME, 'config', 'tickets');

test('a minted ticket is good once: take uses it up, a second take is refused', () => {
  T.mint(ID);
  assert.equal(T.check(ID).ok, true);
  assert.equal(T.take(ID).ok, true);
  const again = T.take(ID);
  assert.equal(again.ok, false);
  assert.equal(again.why, 'missing');
});

test('no ticket, no approval; another plan id\'s ticket does not count', () => {
  T.mint('20261008-120000-00000001');
  assert.deepEqual(T.take('20261008-120000-00000002'), { ok: false, why: 'missing' });
  T.take('20261008-120000-00000001');
});

test('a ticket past its time is refused', () => {
  assert.equal(T.TTL_MS, 10 * 60 * 1000, 'ten minutes (ruled 10/9)');
  T.mint(ID, { now: Date.now() - T.TTL_MS - 1000 });
  assert.equal(T.take(ID).why, 'expired');
});

test('a hand-made or edited ticket fails the signature', () => {
  const t = T.mint(ID);
  fs.writeFileSync(path.join(dirOf(), `${ID}.json`), JSON.stringify({ ...t, created: new Date(Date.now() + 1000).toISOString() }));
  assert.equal(T.take(ID).why, 'not signed by this machine');
  fs.writeFileSync(path.join(dirOf(), `${ID}.json`), JSON.stringify({ key: ID, created: new Date().toISOString(), nonce: 'x', sig: 'f'.repeat(64) }));
  assert.equal(T.take(ID).why, 'not signed by this machine');
  fs.writeFileSync(path.join(dirOf(), `${ID}.json`), 'not json');
  assert.equal(T.take(ID).why, 'missing');
});

test('a ticket filed under another key is refused (renamed file)', () => {
  const other = '20261008-120000-99999999';
  T.mint(other);
  fs.renameSync(path.join(dirOf(), `${other}.json`), path.join(dirOf(), `${ID}.json`));
  assert.equal(T.take(ID).why, 'damaged');
});

test('only plan ids and resolve numbers are keys (no path tricks)', () => {
  assert.throws(() => T.mint('../plan'), /not an approval key/);
  assert.throws(() => T.mint('x'), /not an approval key/);
  assert.equal(T.check('../../x').ok, false);
  T.mint('resolve-D-1003');
  assert.equal(T.take('resolve-D-1003').ok, true);
});

test('pending: true while a fresh ticket waits, false once it is used', () => {
  T.sweep({ now: Date.now() + 10 * T.TTL_MS }); // clear anything earlier tests left
  assert.equal(T.pending(), false);
  T.mint(ID);
  assert.equal(T.pending(), true);
  T.take(ID);
  assert.equal(T.pending(), false);
});

test('refusalText names what to do', () => {
  assert.match(T.refusalText('missing'), /Claude Code asks/);
  assert.match(T.refusalText('expired'), /expired/);
});
