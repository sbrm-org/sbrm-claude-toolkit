'use strict';
// The --path the engine hands the Dataverse CLI (Daian's Mac, 10/8): on macOS CLI 1.0.81 a path starting
// with "/" is read as an absolute file URL ("Absolute URL host '' does not match") and every call fails, so
// the health check said "not signed in". The slashless form works on macOS and Windows (tested live on both).
const test = require('node:test');
const assert = require('node:assert/strict');
const { cliPath } = require('../lib/cli');

test('cli paths never start with a slash and always carry the API root', () => {
  assert.equal(cliPath('WhoAmI'), 'api/data/v9.2/WhoAmI');
  assert.equal(cliPath('/api/data/v9.2/WhoAmI'), 'api/data/v9.2/WhoAmI');
  assert.equal(cliPath('api/data/v9.2/contacts?$top=1'), 'api/data/v9.2/contacts?$top=1');
  assert.equal(cliPath('//api/data/v9.2/x'), 'api/data/v9.2/x');
  assert.equal(cliPath('sbrm_dataverseevents'), 'api/data/v9.2/sbrm_dataverseevents');
});
