'use strict';
// The write connection's allow-list for app development (lib/write.js, DESIGN.md §10f; 10/7 review finding 8).
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkMeta, publishXml, roleCall } = require('../lib/write');

test('roles: a grant and a removal each reach exactly one fixed path, and only for two GUIDs', () => {
  const u = '11111111-1111-1111-1111-111111111111';
  const r = '22222222-2222-2222-2222-222222222222';
  assert.deepEqual(roleCall('grant', u, r, 'https://sbrmhgs.crm.dynamics.com'), {
    method: 'POST', path: `systemusers(${u})/systemuserroles_association/$ref`,
    body: { '@odata.id': `https://sbrmhgs.crm.dynamics.com/api/data/v9.2/roles(${r})` },
  });
  assert.deepEqual(roleCall('revoke', u, r, 'https://sbrmhgs.crm.dynamics.com'), {
    method: 'DELETE', path: `systemusers(${u})/systemuserroles_association(${r})/$ref`, body: undefined,
  });
  for (const [verb, uid, rid, host] of [
    ['grant', 'x', r, 'https://a.crm.dynamics.com'],
    ['grant', u, `${r})/../contacts(${r}`, 'https://a.crm.dynamics.com'],
    ['revoke', u, '', 'https://a.crm.dynamics.com'],
    ['delete', u, r, 'https://a.crm.dynamics.com'],
    ['grant', u, r, 'http://evil.invalid/x'],
  ]) assert.throws(() => roleCall(verb, uid, rid, host), /refusing/, `${verb} ${uid} ${rid} ${host}`);
});

test('metadata: the definition sets and the named actions pass, with the allowed headers', () => {
  assert.equal(checkMeta('POST', "EntityDefinitions(LogicalName='sbrm_x')/Attributes", ['MSCRM.SolutionUniqueName: SBRMAdHoc']), 'POST');
  assert.equal(checkMeta('PUT', "EntityDefinitions(LogicalName='sbrm_x')/Attributes(LogicalName='sbrm_y')", ['MSCRM.MergeLabels: true']), 'PUT');
  assert.equal(checkMeta('POST', 'InsertOptionValue', []), 'POST');
  assert.equal(checkMeta('DELETE', "RelationshipDefinitions(SchemaName='sbrm_a_b')", []), 'DELETE');
});

test('metadata: nothing may climb out of an allowed prefix, or smuggle a header', () => {
  const bad = [
    ['DELETE', 'EntityDefinitions(x)/../../contacts(11111111-1111-1111-1111-111111111111)'],
    ['POST', 'EntityDefinitions(x)/./Attributes'],
    ['POST', 'EntityDefinitions%28x%29'],
    ['POST', 'EntityDefinitions(x)\\..\\contacts'],
    ['POST', 'EntityDefinitions(x)//Attributes'],
    ['POST', 'EntityDefinitions(x) /Attributes'],
    ['DELETE', 'solutions(11111111-1111-1111-1111-111111111111)'],
    ['GET', 'EntityDefinitions'],
    ['PATCH', 'InsertOptionValue'],
    ['POST', 'contacts'],
    ['POST', 'PublishAllXml'],
    // 10/7 re-verify: navigation off a solution row, and $ref
    ['PUT', 'solutions(11111111-1111-1111-1111-111111111111)/publisherid/$ref'],
    ['PATCH', 'solutions(11111111-1111-1111-1111-111111111111)'],
    ['POST', 'solutions(11111111-1111-1111-1111-111111111111)/solution_solutioncomponent'],
    ['PUT', "EntityDefinitions(LogicalName='x')/Attributes(LogicalName='y')/$ref"],
  ];
  assert.equal(checkMeta('POST', 'solutions', []), 'POST', 'creating a solution still works');
  for (const [m, p] of bad) assert.throws(() => checkMeta(m, p, []), /refusing/, `${m} ${p}`);
  assert.throws(() => checkMeta('POST', 'EntityDefinitions', ['MSCRMCallerID: 1']), /refusing header/);
  assert.throws(() => checkMeta('POST', 'EntityDefinitions', ['MSCRM.MergeLabels: true\r\nMSCRMCallerID: 1']), /refusing header/);
});

test('publish names only the given components, never everything', () => {
  assert.equal(publishXml({ entities: ['contact'] }), '<importexportxml><entities><entity>contact</entity></entities></importexportxml>');
  assert.throws(() => publishXml({}), /nothing to publish/);
  assert.throws(() => publishXml({ entities: ['x</entity><entity>y'] }), /refusing to publish/);
});
