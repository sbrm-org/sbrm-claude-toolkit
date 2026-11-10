'use strict';
// A fake Dataverse for application users and new SBRM security roles (lib/appuser.js, lib/securityrole.js). Shapes as
// read live 11/9/26 in HGS (Shared Dataverse Write\probe_appuser_role.py), reference = the 10/21 Mail Sorting Guide:
//   - an application user is a systemusers row: firstname '#', fullname '# <Entra app name>', applicationid = the
//     client id, accessmode 4, a business unit; Dataverse names it after the Entra app.
//   - root business unit = the one whose _parentbusinessunitid_value is null. Recovery-like data adds a child unit.
//   - a NEW role gets Dataverse's 9-privilege baseline at Global (BASELINE below); RetrieveRolePrivilegesRole(RoleId=)
//     answers {RolePrivileges: [{PrivilegeName, PrivilegeId, Depth, BusinessUnitId}]}, Depth as a string.
//   - table privileges come from EntityDefinitions(LogicalName='x')?$select=...,Privileges, each with Name,
//     PrivilegeId, PrivilegeType and CanBeBasic/Local/Deep/Global; an organization-owned table allows Global only.
// Every call is recorded, so a test can assert a plan issued GETs only.

const crypto = require('crypto');
const { DataverseError } = require('../lib/cli');

const IDS = {
  rootBu: '6df44b00-bdf1-eb11-94ee-000d3a339361',
  childBu: '4f8ff316-0000-0000-0000-000000000001',
  me: '99999999-9999-9999-9999-999999999999',
  tim: 'a1000000-0000-0000-0000-000000000001',
  ourApp: 'b2000000-0000-0000-0000-000000000001',      // an existing SBRM application user (Mail Sorting Guide)
  ourAppClient: '28f6380d-c285-4e6f-9789-a8bd4b9da6e3',
  offApp: 'b2000000-0000-0000-0000-000000000002',      // an application user that is switched off
  offAppClient: 'c3000000-0000-0000-0000-000000000002',
  msApp: 'b2000000-0000-0000-0000-000000000003',       // a Microsoft integration: holds a managed role
  msAppClient: 'c3000000-0000-0000-0000-000000000003',
  newClient: 'd4000000-0000-0000-0000-000000000001',   // an Entra app with no application user yet
  person: 'a1000000-0000-0000-0000-000000000009',      // a person whose applicationid is set (never real; a guard)
  personClient: 'c3000000-0000-0000-0000-000000000009',
  mailRole: '80665a20-7ecd-f111-a05c-70a8a5b1aef5',    // #_ sbrmapps Mail Guide (read), root
  mailRoleChild: '80665a20-0000-0000-0000-000000000002',
  normal: '95d443f4-0000-0000-0000-000000000001',
  sa: '71f44b00-bdf1-eb11-94ee-000d3a339361',
  team: 'c1000000-0000-0000-0000-000000000001',
};

const guid = () => crypto.randomUUID();
const PRIV = {}; // privilege name -> id (stable per process)
const pid = (name) => (PRIV[name] || (PRIV[name] = guid()));

const BASELINE = ['prvReadPluginAssembly', 'prvReadPluginType', 'prvReadSdkMessage', 'prvReadSdkMessageProcessingStep',
  'prvReadSdkMessageProcessingStepImage', 'prvReadSharePointData', 'prvReadSharePointDocument', 'prvCreateSharePointData',
  'prvWriteSharePointData'];
const TYPES = ['Create', 'Read', 'Write', 'Delete', 'Assign', 'Share', 'Append', 'AppendTo'];

function tableMeta(logical, ownership = 'UserOwned') {
  const org = ownership === 'OrganizationOwned';
  const types = org ? ['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo'] : TYPES;
  return {
    LogicalName: logical, OwnershipType: ownership,
    Privileges: types.map((t) => ({ Name: `prv${t}${logical}`, PrivilegeId: pid(`prv${t}${logical}`), PrivilegeType: t,
      CanBeBasic: !org, CanBeLocal: !org, CanBeDeep: !org, CanBeGlobal: true })),
  };
}

function user(id, fullname, { applicationid = null, accessmode = 4, isdisabled = false, bu = IDS.rootBu } = {}) {
  return { systemuserid: id, fullname, applicationid, accessmode, isdisabled, _businessunitid_value: bu, internalemailaddress: null, domainname: null };
}

function data() {
  return {
    businessunits: [
      { businessunitid: IDS.rootBu, name: 'SBRM Homeless', _parentbusinessunitid_value: null },
      { businessunitid: IDS.childBu, name: "Men's", _parentbusinessunitid_value: IDS.rootBu },
    ],
    systemusers: [
      { ...user(IDS.me, 'Test Admin', { accessmode: 0 }), internalemailaddress: 'admin@example.org', domainname: 'admin@example.org' },
      { ...user(IDS.tim, 'Tim Molloy', { accessmode: 0 }), internalemailaddress: 'tim@example.org', domainname: 'tim@example.org' },
      user(IDS.ourApp, '# sbrmapps - Mail Sorting Guide (Dataverse read)', { applicationid: IDS.ourAppClient }),
      user(IDS.offApp, '# old job', { applicationid: IDS.offAppClient, isdisabled: true }),
      user(IDS.msApp, '# Power Platform thing', { applicationid: IDS.msAppClient }),
      { ...user(IDS.person, 'Odd Person', { applicationid: IDS.personClient, accessmode: 0 }), internalemailaddress: 'odd@example.org', domainname: 'odd@example.org' },
    ],
    roles: [
      { roleid: IDS.mailRole, name: '#_ sbrmapps Mail Guide (read)', _parentrootroleid_value: IDS.mailRole, _businessunitid_value: IDS.rootBu, ismanaged: false },
      { roleid: IDS.mailRoleChild, name: '#_ sbrmapps Mail Guide (read)', _parentrootroleid_value: IDS.mailRole, _businessunitid_value: IDS.childBu, ismanaged: false },
      { roleid: IDS.normal, name: '#_ SBRM Normal', _parentrootroleid_value: IDS.normal, _businessunitid_value: IDS.rootBu, ismanaged: false },
      { roleid: IDS.sa, name: 'System Administrator', _parentrootroleid_value: IDS.sa, _businessunitid_value: IDS.rootBu, ismanaged: true },
    ],
    // role id -> [{name, depth}]
    roleprivs: {
      [IDS.mailRole]: [...BASELINE.map((n) => ({ name: n, depth: 'Global' })), { name: 'prvReadsbrm_guest', depth: 'Global' }],
    },
    userroles: [{ user: IDS.ourApp, role: IDS.mailRole }, { user: IDS.msApp, role: IDS.sa }, { user: IDS.me, role: IDS.sa }],
    teams: [{ teamid: IDS.team, name: 'Homeless Program', teamtype: 2 }],
    teamroles: [],
    members: [], // { user, team }
    tables: {
      sbrm_guest: tableMeta('sbrm_guest'),
      sbrm_bednight: tableMeta('sbrm_bednight'),
      contact: tableMeta('contact'),
      sbrm_setting: tableMeta('sbrm_setting', 'OrganizationOwned'),
      role: tableMeta('role', 'OrganizationOwned'),
      workflow: tableMeta('workflow'),
      sbrm_dataversewritelog: tableMeta('sbrm_dataversewritelog'),
    },
  };
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const pick = (rec, cols) => Object.fromEntries(cols.map((c) => [c, rec[c] === undefined ? null : rec[c]]));

// $filter: ANDs of `col eq 'text'`, `col eq <guid>`, `col eq null`.
function matcher(filter) {
  const ands = filter.split(' and ').map((c) => {
    let m;
    if ((m = /^(\w+) eq '((?:[^']|'')*)'$/.exec(c.trim()))) { const [, col, v] = m; return (r) => same(r[col], v.replace(/''/g, "'")); }
    if ((m = /^(\w+) eq ([0-9a-f]{8}-[0-9a-f-]{27})$/i.exec(c.trim()))) { const [, col, v] = m; return (r) => r[col] !== null && same(r[col], v); }
    if ((m = /^(\w+) eq null$/.exec(c.trim()))) { const [, col] = m; return (r) => r[col] === null || r[col] === undefined; }
    throw new Error(`fake_identity: unsupported filter clause "${c}"`);
  });
  return (r) => ands.every((f) => f(r));
}

function fakeIdentityDv({ email = 'admin@example.org', userId = IDS.me, d = data(), host = 'https://hgs.invalid' } = {}) {
  const calls = [];
  const find = (set, idCol, id) => (d[set] || []).find((r) => same(r[idCol], id));
  const meRec = find('systemusers', 'systemuserid', userId);
  if (meRec) Object.assign(meRec, { domainname: email, internalemailaddress: email });
  const notFound = () => new DataverseError('Does Not Exist', { code: '0x80040217' });
  const take = () => { if (dv.failNext) { const e = dv.failNext; dv.failNext = null; throw e; } };
  const dv = {
    cliVersion: 'fake',
    host,
    calls,
    data: d,
    failNext: null,       // a DataverseError the next write throws
    failOn: null,         // 'addRolePrivileges' etc.: that verb throws once
    readBackDrops: false, // the platform answers OK but nothing changed
    privsDrop: null,      // a privilege name the platform quietly leaves out
    privsExtra: null,     // a privilege the platform quietly adds beyond the baseline
    createReturnsNoId: false,
    get(p, opts) {
      calls.push({ method: 'GET', path: p, strong: Boolean(opts && opts.strong) });
      let m;
      if (p === 'WhoAmI') return { UserId: userId };
      if ((m = /^systemusers\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        const u = find('systemusers', 'systemuserid', m[1]);
        if (!u) throw notFound();
        return { '@odata.etag': `W/"${u._v || 1}"`, ...pick(u, m[2].split(',')) };
      }
      if ((m = /^systemusers\(([0-9a-f-]{36})\)\/systemuserroles_association\?\$select=(.*)$/.exec(p))) {
        const held = d.userroles.filter((g) => same(g.user, m[1])).map((g) => find('roles', 'roleid', g.role));
        return { value: held.map((r) => pick(r, m[2].split(','))) };
      }
      if ((m = /^systemusers\(([0-9a-f-]{36})\)\/teammembership_association\?\$select=(.*)$/.exec(p))) {
        const ts = (d.members || []).filter((x) => same(x.user, m[1])).map((x) => find('teams', 'teamid', x.team));
        return { value: ts.map((t) => pick(t, m[2].split(','))) };
      }
      if ((m = /^teams\(([0-9a-f-]{36})\)\/teamroles_association\?\$select=(.*)$/.exec(p))) {
        const rs = d.teamroles.filter((x) => same(x.team, m[1])).map((x) => find('roles', 'roleid', x.role));
        return { value: rs.map((r) => pick(r, m[2].split(','))) };
      }
      if ((m = /^roles\(([0-9a-f-]{36})\)\/systemuserroles_association\?\$select=(.*)$/.exec(p))) {
        const us = d.userroles.filter((g) => same(g.role, m[1])).map((g) => find('systemusers', 'systemuserid', g.user));
        return { value: us.map((u) => pick(u, m[2].split(','))) };
      }
      if ((m = /^roles\(([0-9a-f-]{36})\)\/teamroles_association\?\$select=(.*)$/.exec(p))) {
        const ts = d.teamroles.filter((g) => same(g.role, m[1])).map((g) => find('teams', 'teamid', g.team));
        return { value: ts.map((t) => pick(t, m[2].split(','))) };
      }
      if ((m = /^(roles|businessunits)\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        const idCol = m[1] === 'roles' ? 'roleid' : 'businessunitid';
        const r = find(m[1], idCol, m[2]);
        if (!r) throw notFound();
        return { '@odata.etag': `W/"${r._v || 1}"`, ...pick(r, m[3].split(',')) };
      }
      if ((m = /^(systemusers|roles|businessunits)\?\$select=([^&]+)&\$filter=(.*)$/.exec(p))) {
        const keep = matcher(decodeURIComponent(m[3]));
        return { value: d[m[1]].filter(keep).map((r) => pick(r, m[2].split(','))) };
      }
      if ((m = /^EntityDefinitions\(LogicalName='([a-z0-9_]+)'\)\?\$select=LogicalName,OwnershipType,Privileges$/.exec(p))) {
        const t = d.tables[m[1]];
        if (!t) throw new DataverseError(`Could not find an entity with name ${m[1]}`, { code: '0x80060888' });
        return JSON.parse(JSON.stringify(t));
      }
      if ((m = /^RetrieveRolePrivilegesRole\(RoleId=([0-9a-f-]{36})\)$/.exec(p))) {
        const ps = d.roleprivs[m[1].toLowerCase()];
        if (!ps) throw notFound();
        return { RolePrivileges: ps.map((x) => ({ PrivilegeName: x.name, PrivilegeId: pid(x.name), Depth: x.depth, BusinessUnitId: IDS.rootBu })) };
      }
      throw new Error(`fake_identity: unrouted GET ${p}`);
    },
    createAppUser(clientId, unitId) {
      calls.push({ method: 'POST', verb: 'createAppUser', clientId, unitId });
      take();
      if (!find('businessunits', 'businessunitid', unitId)) throw notFound();
      if (d.systemusers.some((u) => same(u.applicationid, clientId))) throw new DataverseError('A record with matching key values already exists', { code: '0x80040237' });
      const id = guid();
      if (!dv.readBackDrops) d.systemusers.push(user(id, '# New Entra App', { applicationid: clientId.toLowerCase(), bu: unitId }));
      return { systemuserid: id };
    },
    setUserDisabled(userId, disabled, etag) {
      calls.push({ method: 'PATCH', verb: 'setUserDisabled', userId, disabled, etag });
      take();
      const u = find('systemusers', 'systemuserid', userId);
      if (!u) throw notFound();
      if (etag !== `W/"${u._v || 1}"`) throw new DataverseError('The version of the existing record does not match', { code: '0x80060882' });
      if (!dv.readBackDrops) { u.isdisabled = disabled; u._v = (u._v || 1) + 1; }
      return {};
    },
    createRole(name, unitId, description) {
      calls.push({ method: 'POST', verb: 'createRole', name, unitId, description });
      take();
      const id = guid();
      d.roles.push({ roleid: id, name, description: description || null, _parentrootroleid_value: id, _businessunitid_value: unitId, ismanaged: false });
      // Dataverse copies a root-unit role into every child unit.
      for (const bu of d.businessunits.filter((b) => b._parentbusinessunitid_value)) {
        d.roles.push({ roleid: guid(), name, _parentrootroleid_value: id, _businessunitid_value: bu.businessunitid, ismanaged: false });
      }
      d.roleprivs[id] = BASELINE.map((n) => ({ name: n, depth: 'Global' }));
      return dv.createReturnsNoId ? {} : { roleid: id, name };
    },
    addRolePrivileges(roleId, privileges) {
      calls.push({ method: 'POST', verb: 'addRolePrivileges', roleId, privileges });
      take();
      if (dv.failOn === 'addRolePrivileges') { dv.failOn = null; throw new DataverseError('Privilege add failed', { code: '0x80040220' }); }
      const held = d.roleprivs[roleId.toLowerCase()];
      if (!held) throw notFound();
      const byId = Object.fromEntries(Object.entries(PRIV).map(([n, i]) => [i, n]));
      for (const p of privileges) {
        const name = byId[p.PrivilegeId];
        if (!name) throw new DataverseError(`privilege ${p.PrivilegeId} does not exist`, { code: '0x80040217' });
        if (name === dv.privsDrop) continue;
        const ex = held.find((x) => x.name === name);
        if (ex) ex.depth = p.Depth; else held.push({ name, depth: p.Depth });
      }
      if (dv.privsExtra) held.push({ name: dv.privsExtra, depth: 'Global' });
      return {};
    },
    deleteRole(roleId, etag) {
      calls.push({ method: 'DELETE', verb: 'deleteRole', roleId, etag });
      take();
      const r = find('roles', 'roleid', roleId);
      if (!r) throw notFound();
      if (etag !== `W/"${r._v || 1}"`) throw new DataverseError('The version of the existing record does not match', { code: '0x80060882' });
      if (!dv.readBackDrops) {
        d.roles = d.roles.filter((x) => !same(x._parentrootroleid_value, roleId) && !same(x.roleid, roleId));
        delete d.roleprivs[roleId.toLowerCase()];
      }
      return {};
    },
    grantRole() { throw new Error('fake_identity: kind appuser / securityrole never gives a role'); },
    revokeRole() { throw new Error('fake_identity: kind appuser / securityrole never takes a role'); },
    update() { throw new Error('fake_identity: never a records PATCH'); },
    create() { throw new Error('fake_identity: never a records POST'); },
    remove() { throw new Error('fake_identity: never a records DELETE'); },
  };
  return dv;
}

const ENVS = {
  hgs: { host: 'https://hgs.invalid', name: 'HGS apps' },
  recovery: { host: 'https://rec.invalid', name: 'Recovery app' },
};
const ACCESS = {
  people: {
    'admin@example.org': { envs: { hgs: 'admin', recovery: 'admin' } },
    'dev@example.org': { envs: { hgs: 'develop' } },
  },
};

module.exports = { fakeIdentityDv, data, IDS, ENVS, ACCESS, BASELINE, pid };
