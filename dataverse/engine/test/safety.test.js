'use strict';
// Client information stays in the Microsoft tenant (ruled 10/6/26). Runs the real command
// (`check` needs no Dataverse) against job files placed in a throwaway git repository.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { gitExposure } = require('../lib/safety');

const HAS_GIT = spawnSync('git', ['--version']).status === 0;
const CMD = path.join(__dirname, '..', 'dataverse-write.js');
// Every spawned run gets a throwaway store. Without it, a refusal here was RECORDED in the real
// ~/.sbrm-dataverse/ and queued to Recovery's event table (found 10/7 on the first live event test).
const STORE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-safety-')), 'store');

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-git-'));
  spawnSync('git', ['init', '-q', d]);
  fs.writeFileSync(path.join(d, '.gitignore'), 'private/\n');
  fs.mkdirSync(path.join(d, 'private'));
  return d;
}

function job(env) {
  return {
    contract: 'sbrm-dv-job/1', kind: 'rows', env, table: 'contacts', mode: 'update', source: 'test', reason: 'Test.',
    intent: { verb: 'update', count: 1, table: 'contacts', fields: ['lastname'] },
    rows: [{ name: 'Client Name', id: '11111111-1111-1111-1111-111111111111', body: { lastname: 'X' } }],
  };
}

function check(file, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CMD, 'check', file], { encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: STORE, ...extraEnv } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('a Recovery job file in a git-tracked folder is refused', { skip: !HAS_GIT }, () => {
  const d = repo();
  const f = path.join(d, 'recovery.json');
  fs.writeFileSync(f, JSON.stringify(job('recovery')));
  const r = check(f);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /holds HIPAA client records, and it sits in a git-tracked folder/);
});

test('HGS, Sober Living and the donor app are not HIPAA environments (ruled 10/6: Recovery only)', { skip: !HAS_GIT }, () => {
  const d = repo();
  for (const env of ['hgs', 'soberliving', 'donorapp']) {
    const f = path.join(d, `${env}.json`);
    fs.writeFileSync(f, JSON.stringify(job(env)));
    assert.equal(check(f).code, 0, env);
  }
});

test('the same job file is allowed when git ignores it, or outside any repository', { skip: !HAS_GIT }, () => {
  const d = repo();
  const ignored = path.join(d, 'private', 'recovery.json');
  fs.writeFileSync(ignored, JSON.stringify(job('recovery')));
  assert.equal(check(ignored).code, 0);
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-nogit-')), 'recovery.json');
  fs.writeFileSync(outside, JSON.stringify(job('recovery')));
  assert.equal(check(outside).code, 0);
});

test('an ignored pattern does not clear a file git ALREADY tracks', { skip: !HAS_GIT }, () => {
  const d = repo();
  const f = path.join(d, 'private', 'committed.json');
  fs.writeFileSync(f, '{}');
  spawnSync('git', ['-C', d, 'add', '-f', f]);
  assert.equal(gitExposure(f).exposed, true);
});

test('the engine store may not sit in a git-tracked folder', { skip: !HAS_GIT }, () => {
  const d = repo();
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbrmdv-nogit-')), 'recovery.json');
  fs.writeFileSync(f, JSON.stringify(job('recovery')));
  const r = spawnSync(process.execPath, [CMD, 'plan', f], { encoding: 'utf8', env: { ...process.env, SBRM_DV_HOME: path.join(d, 'store') } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the engine's store .* is inside a git-tracked folder/);
});
