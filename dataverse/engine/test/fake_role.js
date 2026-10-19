'use strict';
// A fake Dataverse for security-role changes (lib/role.js): users, business units, roles with one copy per
// business unit, direct role grants, teams and the roles teams carry. Shapes as read live 10/19/26:
//   - HGS: one business unit; Dylan holds System Administrator directly; his teams are SBRM Homeless (owner,
//     the BU's default team, no roles), Homeless Guest Services (Entra office group, type 3, no roles) and
//     Homeless Program (Entra security group, type 2) which carries '#_ SBRM Normal'.
//   - Recovery: a root BU and two child BUs (Men's, Women's). Every role has one copy per BU: '#_ SBRM Normal'
//     root 95d443f4 (root BU) with copies in Women's 85451b2e and Men's 7db17ca6, all _parentrootroleid_value
//     95d443f4. System Administrator likewise (71f44b00 root, copies 0cae51a3 / e315860d). A user can hold only
//     the copy in their OWN business unit.
//   - systemusers.accessmode: 0 = a person (read-write), 4 = an app user (non-interactive), 5 = delegated admin.
// Every call is recorded, so a test can assert a plan issued GETs only.

const { DataverseError } = require('../lib/cli');

const IDS = {
  rootBu: '6df44b00-bdf1-eb11-94ee-000d3a339361',
  mensBu: '4f8ff316-0000-0000-0000-000000000001',
  me: '99999999-9999-9999-9999-999999999999',
  tim: 'a1000000-0000-0000-0000-000000000001',
  daian: 'a1000000-0000-0000-0000-000000000002',
  lb: 'a1000000-0000-0000-0000-000000000003',       // in the Men's business unit
  gone: 'a1000000-0000-0000-0000-000000000004',     // disabled
  admin2: 'a1000000-0000-0000-0000-000000000005',   // the other person who is a System Administrator
  appUser: 'a1000000-0000-0000-0000-000000000006',  // an app user holding System Administrator
  twin1: 'a1000000-0000-0000-0000-000000000007',
  twin2: 'a1000000-0000-0000-0000-000000000008',
  normal: '95d443f4-0000-0000-0000-000000000001',   // '#_ SBRM Normal', root copy
  normalMens: '7db17ca6-0000-0000-0000-000000000001',
  clerical: '95d443f4-0000-0000-0000-000000000002',
  clericalMens: '7db17ca6-0000-0000-0000-000000000002',
  rootOnly: '95d443f4-0000-0000-0000-000000000003', // a role with no copy in the Men's BU (never real, a guard)
  sa: '71f44b00-bdf1-eb11-94ee-000d3a339361',
  saMens: '0cae51a3-0000-0000-0000-000000000001',
  sc: '71f44b00-0000-0000-0000-000000000002',
  basic: '71f44b00-0000-0000-0000-000000000003',
  programTeam: 'c1000000-0000-0000-0000-000000000001', // Entra security group team, carries Normal
  ownerTeam: 'c1000000-0000-0000-0000-000000000002',   // the BU's default owner team, no roles
  accessTeam: 'c1000000-0000-0000-0000-000000000003',  // an access team: carries a role here, but access teams never grant
  clericalTeam: 'c1000000-0000-0000-0000-000000000004', // owner team in the Men's BU, carries Clerical
};

function user(id, fullname, email, { bu = IDS.rootBu, isdisabled = false, accessmode = 0 } = {}) {
  return { systemuserid: id, fullname, domainname: email, internalemailaddress: email, isdisabled, accessmode, _businessunitid_value: bu };
}
function role(id, name, root, bu, ismanaged = false) {
  return { roleid: id, name, _parentrootroleid_value: root, _businessunitid_value: bu, ismanaged };
}

function data() {
  return {
    systemusers: [
      user(IDS.me, 'Test Admin', 'admin@example.org'),
      user(IDS.tim, 'Tim Molloy', 'tim@example.org'),
      user(IDS.daian, 'Daian Martinez', 'daian@example.org'),
      user(IDS.lb, 'Larry Chandler', 'lb@example.org', { bu: IDS.mensBu }),
      user(IDS.gone, 'Gone Person', 'gone@example.org', { isdisabled: true }),
      user(IDS.admin2, 'Other Admin', 'admin2@example.org'),
      user(IDS.appUser, '# Some App', 'app@example.org', { accessmode: 4 }),
      user(IDS.twin1, 'Twin One', 'twin@example.org'),
      user(IDS.twin2, 'Twin Two', 'twin@example.org'),
    ],
    roles: [
      role(IDS.normal, '#_ SBRM Normal', IDS.normal, IDS.rootBu),
      role(IDS.normalMens, '#_ SBRM Normal', IDS.normal, IDS.mensBu),
      role(IDS.clerical, '#_ SBRM Clerical', IDS.clerical, IDS.rootBu),
      role(IDS.clericalMens, '#_ SBRM Clerical', IDS.clerical, IDS.mensBu),
      role(IDS.rootOnly, '#_ SBRM Root Only', IDS.rootOnly, IDS.rootBu),
      role(IDS.sa, 'System Administrator', IDS.sa, IDS.rootBu, true),
      role(IDS.saMens, 'System Administrator', IDS.sa, IDS.mensBu, true),
      role(IDS.sc, 'System Customizer', IDS.sc, IDS.rootBu, true),
      role(IDS.basic, 'Basic User', IDS.basic, IDS.rootBu, true),
    ],
    // direct grants: { user, role } (role = the copy actually held)
    userroles: [
      { user: IDS.me, role: IDS.sa },
      { user: IDS.admin2, role: IDS.sa },
      { user: IDS.appUser, role: IDS.sa },
      { user: IDS.tim, role: IDS.normal },
      { user: IDS.daian, role: IDS.normal },
      { user: IDS.lb, role: IDS.normalMens },
      { user: IDS.gone, role: IDS.normal },
    ],
    teams: [
      { teamid: IDS.programTeam, name: 'Homeless Program', teamtype: 2 },
      { teamid: IDS.ownerTeam, name: 'SBRM Homeless', teamtype: 0 },
      { teamid: IDS.accessTeam, name: 'Case Access', teamtype: 1 },
      { teamid: IDS.clericalTeam, name: "Men's Clerical", teamtype: 0 },
    ],
    teamroles: [
      { team: IDS.programTeam, role: IDS.normal },
      { team: IDS.accessTeam, role: IDS.normal }, // Tim is in it: counting access teams would wrongly keep his access
      { team: IDS.clericalTeam, role: IDS.clericalMens },
    ],
    members: [
      { user: IDS.me, team: IDS.ownerTeam },
      { user: IDS.daian, team: IDS.programTeam },
      { user: IDS.daian, team: IDS.ownerTeam },
      { user: IDS.tim, team: IDS.ownerTeam },
      { user: IDS.tim, team: IDS.accessTeam },
      { user: IDS.lb, team: IDS.clericalTeam },
    ],
  };
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const pick = (rec, cols) => Object.fromEntries(cols.map((c) => [c, rec[c] === undefined ? null : rec[c]]));

// Tiny $filter evaluator: ANDs of `col eq 'text'` and `col eq <guid>`.
function matcher(filter) {
  const ands = filter.split(' and ').map((c) => {
    let m;
    if ((m = /^(\w+) eq '((?:[^']|'')*)'$/.exec(c.trim()))) {
      const [, col, v] = m;
      return (r) => same(r[col], v.replace(/''/g, "'"));
    }
    if ((m = /^(\w+) eq ([0-9a-f]{8}-[0-9a-f-]{27})$/i.exec(c.trim()))) {
      const [, col, v] = m;
      return (r) => same(r[col], v);
    }
    throw new Error(`fake_role: unsupported filter clause "${c}"`);
  });
  return (r) => ands.every((f) => f(r));
}

function fakeRoleDv({ email = 'admin@example.org', userId = IDS.me, d = data(), host = 'https://hgs.invalid' } = {}) {
  const calls = [];
  const find = (set, idCol, id) => (d[set] || []).find((r) => same(r[idCol], id));
  // The signed-in person reads back with the email the test signs in as (a develop-level person, say).
  const meRec = find('systemusers', 'systemuserid', userId);
  if (meRec) Object.assign(meRec, { domainname: email, internalemailaddress: email });
  const dv = {
    cliVersion: 'fake',
    host,
    calls,
    data: d,
    readBackDrops: false, // the platform answers OK but keeps the old grants (read-back mismatch)
    failNext: null,       // a DataverseError the next write throws
    get(p) {
      calls.push({ method: 'GET', path: p });
      let m;
      if (p === 'WhoAmI') return { UserId: userId };
      if ((m = /^systemusers\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        const u = find('systemusers', 'systemuserid', m[1]);
        if (!u) throw new DataverseError('Does Not Exist', { code: '0x80040217' });
        return { '@odata.etag': 'W/"1"', ...pick(u, m[2].split(',')) };
      }
      if ((m = /^systemusers\(([0-9a-f-]{36})\)\/systemuserroles_association\?\$select=(.*)$/.exec(p))) {
        const held = d.userroles.filter((g) => same(g.user, m[1])).map((g) => find('roles', 'roleid', g.role));
        return { value: held.map((r) => pick(r, m[2].split(','))) };
      }
      if ((m = /^systemusers\(([0-9a-f-]{36})\)\/teammembership_association\?\$select=(.*)$/.exec(p))) {
        const ts = d.members.filter((x) => same(x.user, m[1])).map((x) => find('teams', 'teamid', x.team));
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
      if ((m = /^roles\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        const r = find('roles', 'roleid', m[1]);
        if (!r) throw new DataverseError('Does Not Exist', { code: '0x80040217' });
        return pick(r, m[2].split(','));
      }
      if ((m = /^(systemusers|roles)\?\$select=([^&]+)&\$filter=(.*)$/.exec(p))) {
        const keep = matcher(decodeURIComponent(m[3]));
        return { value: d[m[1]].filter(keep).map((r) => pick(r, m[2].split(','))) };
      }
      throw new Error(`fake_role: unrouted GET ${p}`);
    },
    grantRole(uid, rid) {
      calls.push({ method: 'POST', verb: 'grant', user: uid, role: rid });
      if (dv.failNext) { const e = dv.failNext; dv.failNext = null; throw e; }
      const u = find('systemusers', 'systemuserid', uid);
      const r = find('roles', 'roleid', rid);
      if (!u || !r) throw new DataverseError('Does Not Exist', { code: '0x80040217' });
      if (!same(u._businessunitid_value, r._businessunitid_value)) throw new DataverseError('The role and the user are in different business units', { code: '0x80041d1d' });
      if (d.userroles.some((g) => same(g.user, uid) && same(g.role, rid))) throw new DataverseError('Cannot insert duplicate key', { code: '0x80040237' });
      if (!dv.readBackDrops) d.userroles.push({ user: uid, role: rid });
      return {};
    },
    revokeRole(uid, rid) {
      calls.push({ method: 'DELETE', verb: 'revoke', user: uid, role: rid });
      if (dv.failNext) { const e = dv.failNext; dv.failNext = null; throw e; }
      if (!dv.readBackDrops) d.userroles = d.userroles.filter((g) => !(same(g.user, uid) && same(g.role, rid)));
      return {};
    },
    update() { throw new Error('fake_role: a role change never patches a record'); },
    create() { throw new Error('fake_role: a role change never creates a record'); },
    remove() { throw new Error('fake_role: a role change never deletes a record'); },
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
    'writer@example.org': { envs: { hgs: 'write' } },
  },
};

module.exports = { fakeRoleDv, data, IDS, ENVS, ACCESS };
