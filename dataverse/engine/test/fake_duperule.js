'use strict';
// A fake Dataverse for duplicate-detection rules (lib/duperule.js). Shapes as read live from the donor app on
// 11/16/26: "Contacts with the same first name and last name" (0c16fb72-...) with two Exact Match conditions,
// blanks NOT ignored, published; "Contacts with the same e-mail address" (7b1003be-...), blanks ignored. Every call
// is recorded, so a test can assert a plan issued GETs only and apply ran in the platform's order.
//
// Platform behaviour it imitates (email_case_fix.py, 10/7/26, and Microsoft's duplicate-rule reference):
//   - a PUBLISHED rule cannot be changed: a PATCH of the rule, or a new or removed condition, is refused;
//   - Unpublish is UNBOUND (UnpublishDuplicateRule {DuplicateRuleId}); Publish is bound to the rule; both are async
//     jobs: the rule reads "publishing" (statuscode 1) for `publishReads` reads before it reads published (2);
//   - statecode 1 + statuscode 2 = published, statecode 0 + statuscode 0 = unpublished;
//   - a PATCH or DELETE carries If-Match; a stale tag is refused (0x80060882).

const { DataverseError } = require('../lib/cli');

const IDS = {
  me: '99999999-9999-9999-9999-999999999999',
  nameRule: '0c16fb72-201d-4581-9ed9-1d4ac969af81',
  emailRule: '7b1003be-b33e-4c83-b8ae-f56c63487a2b',
  managedRule: 'a1000000-0000-0000-0000-000000000003',
  crossRule: 'a1000000-0000-0000-0000-000000000004',
  first: 'c1000000-0000-0000-0000-000000000001',
  last: 'c1000000-0000-0000-0000-000000000002',
  email: 'c1000000-0000-0000-0000-000000000003',
  mcond: 'c1000000-0000-0000-0000-000000000004',
  xcond: 'c1000000-0000-0000-0000-000000000005',
};

const ATTRS = {
  contact: { firstname: 'String', lastname: 'String', emailaddress1: 'String', address1_postalcode: 'String', mobilephone: 'String', birthdate: 'DateTime', gendercode: 'Picklist', parentcustomerid: 'Customer', description: 'Memo' },
  account: { name: 'String', emailaddress1: 'String' },
  lead: { emailaddress1: 'String' },
};

function rule(id, name, table, { published = true, ismanaged = false, matching = table, iscasesensitive = false, excludeinactiverecords = true, description = '' } = {}) {
  return { duplicateruleid: id, name, description, baseentityname: table, matchingentityname: matching, iscasesensitive, excludeinactiverecords, statecode: published ? 1 : 0, statuscode: published ? 2 : 0, ismanaged };
}
function cond(id, ruleId, attr, { operatorcode = 0, operatorparam = null, ignoreblankvalues = false, ismanaged = false, matching = attr } = {}) {
  return { duplicateruleconditionid: id, _regardingobjectid_value: ruleId, baseattributename: attr, matchingattributename: matching, operatorcode, operatorparam, ignoreblankvalues, ismanaged };
}

function data() {
  return {
    duplicaterules: [
      rule(IDS.nameRule, 'Contacts with the same first name and last name', 'contact'),
      rule(IDS.emailRule, 'Contacts with the same e-mail address', 'contact'),
      rule(IDS.managedRule, 'Leads with the same e-mail', 'lead', { ismanaged: true }),
      rule(IDS.crossRule, 'Contacts matching leads', 'contact', { matching: 'lead' }),
    ],
    duplicateruleconditions: [
      cond(IDS.first, IDS.nameRule, 'firstname'),
      cond(IDS.last, IDS.nameRule, 'lastname'),
      cond(IDS.email, IDS.emailRule, 'emailaddress1', { ignoreblankvalues: true }),
      cond(IDS.mcond, IDS.managedRule, 'emailaddress1', { ismanaged: true }),
      cond(IDS.xcond, IDS.crossRule, 'emailaddress1'),
    ],
  };
}

const ID_COL = { duplicaterules: 'duplicateruleid', duplicateruleconditions: 'duplicateruleconditionid' };

function matcher(filter) {
  // Split on " and " OUTSIDE quotes: a rule's own name can hold the word ("first name and last name").
  const parts = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < filter.length; i += 1) {
    if (filter[i] === "'") inQ = !inQ;
    if (!inQ && filter.startsWith(' and ', i)) { parts.push(cur); cur = ''; i += 4; continue; }
    cur += filter[i];
  }
  parts.push(cur);
  const ands = parts.map((c) => {
    let m;
    if ((m = /^(\w+) eq '((?:[^']|'')*)'$/.exec(c.trim()))) {
      const [, col, v] = m;
      return (r) => String(r[col]).toLowerCase() === v.replace(/''/g, "'").toLowerCase();
    }
    if ((m = /^(\w+) eq ([0-9a-f]{8}-[0-9a-f-]{27})$/i.exec(c.trim()))) {
      const [, col, v] = m;
      return (r) => String(r[col]).toLowerCase() === v.toLowerCase();
    }
    throw new Error(`fake_duperule: unsupported filter clause "${c}"`);
  });
  return (r) => ands.every((f) => f(r));
}

function fakeDupeDv({ email = 'admin@example.org', userId = IDS.me, fullname = 'Test Admin', d = data(), host = 'https://donor.invalid', publishReads = 2, unpublishReads = 1 } = {}) {
  const calls = [];
  const etags = new Map();
  const pending = new Map(); // rule id -> { to: statuscode, reads: n }
  let seq = 0;
  const tag = (set, id) => `W/"${etags.get(`${set}/${id}`) || 1}"`;
  const bump = (set, id) => etags.set(`${set}/${id}`, (etags.get(`${set}/${id}`) || 1) + 1);
  const find = (set, id) => (d[set] || []).find((r) => String(r[ID_COL[set]]).toLowerCase() === String(id).toLowerCase());
  const tick = (id) => {
    const p = pending.get(id);
    if (!p) return;
    p.reads -= 1;
    if (p.reads < 0) {
      const r = find('duplicaterules', id);
      Object.assign(r, p.to === 2 ? { statecode: 1, statuscode: 2 } : { statecode: 0, statuscode: 0 });
      pending.delete(id);
    }
  };
  const published = (id) => {
    const r = find('duplicaterules', id);
    return r && (r.statuscode === 2 || r.statuscode === 1);
  };
  const dv = {
    cliVersion: 'fake',
    host,
    calls,
    data: d,
    failOn: null, // e.g. 'create duplicateruleconditions': throw on that call
    neverPublishes: false,
    brokenReads: false, // every rule read fails (a read-back after a part-way failure)
    touch(set, id, patch) { Object.assign(find(set, id), patch); bump(set, id); },
    get(p) {
      calls.push({ method: 'GET', path: p });
      let m;
      if (dv.brokenReads && /^duplicaterule/.test(p)) throw new DataverseError('service unavailable');
      if (p === 'WhoAmI') return { UserId: userId };
      if ((m = /^systemusers\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        if (m[1] === userId) return { fullname, internalemailaddress: email, domainname: email, isdisabled: false };
        throw new DataverseError('Does Not Exist', { code: '0x80040217' });
      }
      if ((m = /^EntityDefinitions\(LogicalName='(\w+)'\)\/Attributes\(LogicalName='(\w+)'\)\?\$select=/.exec(p))) {
        const t = (ATTRS[m[1]] || {})[m[2]];
        if (!t) throw new DataverseError('Could not find', { code: '0x80040217' });
        return { LogicalName: m[2], AttributeType: t };
      }
      if ((m = /^EntityDefinitions\(LogicalName='(\w+)'\)\?\$select=/.exec(p))) {
        if (!ATTRS[m[1]]) throw new DataverseError('Could not find', { code: '0x80040217' });
        return { LogicalName: m[1] };
      }
      if ((m = /^duplicaterules\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        tick(m[1].toLowerCase());
        const rec = find('duplicaterules', m[1]);
        if (!rec) throw new DataverseError('Does Not Exist', { code: '0x80040217' });
        const out = {}; // MEASURED 11/16 (Donor App Dev): no @odata.etag on a duplicate rule
        for (const k of m[2].split(',')) out[k] = rec[k] === undefined ? null : rec[k];
        return out;
      }
      if ((m = /^(duplicaterules|duplicateruleconditions)\?\$select=([^&]+)&\$filter=(.*)$/.exec(p))) {
        const keep = matcher(decodeURIComponent(m[3]));
        const cols = m[2].split(',');
        return {
          value: d[m[1]].filter(keep).map((r) => {
            const out = {}; // MEASURED 11/16: no @odata.etag on rules or conditions, in a collection read either
            for (const c of cols) out[c] = r[c] === undefined ? null : r[c];
            return out;
          }),
        };
      }
      throw new Error(`fake_duperule: unrouted GET ${p}`);
    },
    update(set, id, body, etag) {
      calls.push({ method: 'PATCH', path: `${set}(${id})`, body, etag });
      if (dv.failOn === `update ${set}`) throw new DataverseError('boom');
      const rec = find(set, id);
      if (!rec) throw new DataverseError('Does Not Exist', { code: '0x80040217' });
      if (etag !== '*') throw new DataverseError('no version to match (a duplicate rule has none)', { code: '0x80060882' });
      if (set === 'duplicaterules' && published(id)) throw new DataverseError('A published duplicate rule cannot be modified. Unpublish it first.');
      if (set === 'duplicateruleconditions' && published(rec._regardingobjectid_value)) throw new DataverseError('A published duplicate rule cannot be modified. Unpublish it first.');
      Object.assign(rec, body);
      bump(set, id);
      return {};
    },
    create(set, body) {
      calls.push({ method: 'POST', path: set, body });
      if (dv.failOn === `create ${set}`) { if (dv.breakReadsOnFail) dv.brokenReads = true; throw new DataverseError('boom'); }
      seq += 1;
      if (set === 'duplicaterules') {
        const id = `a2000000-0000-0000-0000-${String(seq).padStart(12, '0')}`;
        d.duplicaterules.push({ ...rule(id, body.name, body.baseentityname, { published: false, matching: body.matchingentityname }), iscasesensitive: Boolean(body.iscasesensitive), excludeinactiverecords: Boolean(body.excludeinactiverecords), description: body.description || '' });
        return { duplicateruleid: id };
      }
      if (set === 'duplicateruleconditions') {
        const m = /^\/duplicaterules\(([0-9a-f-]{36})\)$/.exec(body['regardingobjectid@odata.bind'] || '');
        if (!m) throw new DataverseError('a condition needs its rule');
        if (published(m[1])) throw new DataverseError('A published duplicate rule cannot be modified. Unpublish it first.');
        // MEASURED 11/16 (Donor App Dev): one condition per rule + column + match type, a database constraint.
        if (d.duplicateruleconditions.some((c) => c._regardingobjectid_value === m[1] && c.baseattributename === body.baseattributename && c.operatorcode === body.operatorcode)) {
          throw new DataverseError('Cannot complete the creation of DuplicateRuleCondition because it violates a database constraint. Please delete the existing record or use update.');
        }
        const id = `c2000000-0000-0000-0000-${String(seq).padStart(12, '0')}`;
        if (dv.dropsConditions) return { duplicateruleconditionid: id }; // accepted, never saved (read-back mismatch)
        d.duplicateruleconditions.push(cond(id, m[1], body.baseattributename, { operatorcode: body.operatorcode, operatorparam: body.operatorparam === undefined ? null : body.operatorparam, ignoreblankvalues: body.ignoreblankvalues, matching: body.matchingattributename }));
        return { duplicateruleconditionid: id };
      }
      throw new Error(`fake_duperule: unexpected create in ${set}`);
    },
    remove(set, id, etag) {
      calls.push({ method: 'DELETE', path: `${set}(${id})`, etag });
      if (set !== 'duplicateruleconditions') throw new Error(`fake_duperule: unexpected delete in ${set}`);
      const rec = find(set, id);
      if (!rec) throw new DataverseError('Does Not Exist', { code: '0x80040217' });
      if (etag !== '*') throw new DataverseError('no version to match (a condition has none)', { code: '0x80060882' });
      if (published(rec._regardingobjectid_value)) throw new DataverseError('A published duplicate rule cannot be modified. Unpublish it first.');
      d[set] = d[set].filter((r) => r !== rec);
      return {};
    },
    unpublishDuplicateRule(id) {
      calls.push({ method: 'POST', path: 'UnpublishDuplicateRule', body: { DuplicateRuleId: id } });
      pending.set(id, { to: 0, reads: unpublishReads });
      return {};
    },
    publishDuplicateRule(id) {
      calls.push({ method: 'POST', path: `duplicaterules(${id})/Microsoft.Dynamics.CRM.PublishDuplicateRule`, body: {} });
      const r = find('duplicaterules', id);
      Object.assign(r, { statecode: 0, statuscode: 1 });
      pending.set(id, { to: 2, reads: dv.neverPublishes ? Infinity : publishReads });
      return {};
    },
  };
  return dv;
}

const ENVS = {
  donorapp: { host: 'https://donor.invalid', name: 'Donor App' },
  hgs: { host: 'https://hgs.invalid', name: 'HGS App' },
};
const ACCESS = {
  people: {
    'admin@example.org': { envs: { donorapp: 'admin', hgs: 'admin' } },
    'dev@example.org': { envs: { donorapp: 'develop' } },
  },
};

module.exports = { fakeDupeDv, data, IDS, ENVS, ACCESS };
