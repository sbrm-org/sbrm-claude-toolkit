'use strict';
// A fake read connection: just enough Dataverse metadata + records for the plan step.
// Every call is recorded so a test can assert the plan step never asked for a write.

const { DataverseError } = require('../lib/cli');

const L = (s) => ({ UserLocalizedLabel: { Label: s } });

const ENTITIES = {
  contact: { LogicalName: 'contact', EntitySetName: 'contacts', PrimaryIdAttribute: 'contactid', PrimaryNameAttribute: 'fullname', DisplayName: L('Contact'), DisplayCollectionName: L('Contacts') },
  account: { LogicalName: 'account', EntitySetName: 'accounts', PrimaryIdAttribute: 'accountid', PrimaryNameAttribute: 'name', DisplayName: L('Account'), DisplayCollectionName: L('Accounts') },
  msnfp_transaction: { LogicalName: 'msnfp_transaction', EntitySetName: 'msnfp_transactions', PrimaryIdAttribute: 'msnfp_transactionid', PrimaryNameAttribute: 'msnfp_name', DisplayName: L('Transaction'), DisplayCollectionName: L('Transactions') },
};

// One-to-many relationships for the merge inventory: two cascade-on-merge donor tables, one system table
// (cascades, but is not inventoried) and one that does not cascade.
const REL = (SchemaName, ReferencingEntity, ReferencingAttribute, nav, merge = 'Cascade') => ({
  SchemaName, ReferencingEntity, ReferencingAttribute, ReferencingEntityNavigationPropertyName: nav, CascadeConfiguration: { Merge: merge },
});
const ONE_TO_MANY = {
  account: [
    REL('msnfp_account_msnfp_transaction_customerid', 'msnfp_transaction', 'msnfp_customerid', 'msnfp_customerid_account'),
    REL('contact_customer_accounts', 'contact', 'parentcustomerid', 'parentcustomerid_account'),
    REL('Account_AsyncOperations', 'asyncoperation', 'regardingobjectid', 'regardingobjectid_account'),
    REL('sbrm_account_nocascade', 'sbrm_thing', 'sbrm_accountid', 'sbrm_accountid', 'NoCascade'),
  ],
  contact: [REL('msnfp_contact_msnfp_transaction_customerid', 'msnfp_transaction', 'msnfp_customerid', 'msnfp_customerid_contact')],
};

const A = (LogicalName, AttributeType, label, extra = {}) => ({
  LogicalName, AttributeType, AttributeTypeName: { Value: `${AttributeType}Type` }, DisplayName: L(label),
  IsValidForCreate: true, IsValidForUpdate: true, IsValidForRead: true, AttributeOf: null, ...extra,
});

const ATTRS = {
  contact: [
    A('contactid', 'Uniqueidentifier', 'Contact', { IsValidForUpdate: false }),
    A('fullname', 'String', 'Full Name', { IsValidForCreate: false, IsValidForUpdate: false }),
    A('firstname', 'String', 'First Name'),
    A('lastname', 'String', 'Last Name'),
    A('address1_line1', 'String', 'Address 1: Street 1'),
    A('address1_city', 'String', 'Address 1: City'),
    A('statecode', 'State', 'Status'),
    A('statuscode', 'Status', 'Status Reason'),
    A('parentcustomerid', 'Customer', 'Company Name'),
    A('creditlimit', 'Money', 'Credit Limit'),
    A('donotemail', 'Boolean', 'Do not allow Emails'),
    A('yomifullname', 'String', 'Yomi Full Name', { AttributeOf: 'fullname' }),
    A('createdon', 'DateTime', 'Created On', { IsValidForCreate: false, IsValidForUpdate: false }),
    A('birthdate', 'DateTime', 'Birthday'), // stands in for a gift's book date in the closed-year tests
  ],
  account: [
    A('accountid', 'Uniqueidentifier', 'Account', { IsValidForUpdate: false }),
    A('name', 'String', 'Account Name'),
    A('statecode', 'State', 'Status'),
    A('merged', 'Boolean', 'Merged', { IsValidForCreate: false, IsValidForUpdate: false }),
    A('masterid', 'Lookup', 'Master ID', { IsValidForCreate: false, IsValidForUpdate: false }),
    A('telephone1', 'String', 'Main Phone'),
    A('description', 'Memo', 'Description'),
    A('createdon', 'DateTime', 'Created On', { IsValidForCreate: false, IsValidForUpdate: false }),
  ],
  msnfp_transaction: [
    A('msnfp_transactionid', 'Uniqueidentifier', 'Transaction', { IsValidForUpdate: false }),
    A('msnfp_name', 'String', 'Name'),
    A('msnfp_bookdate', 'DateTime', 'Book Date'),
    A('msnfp_customerid', 'Customer', 'Donor'),
  ],
};

const NAVS = {
  contact: [
    { ReferencingAttribute: 'parentcustomerid', ReferencedEntity: 'account', ReferencingEntityNavigationPropertyName: 'parentcustomerid_account' },
    { ReferencingAttribute: 'parentcustomerid', ReferencedEntity: 'contact', ReferencingEntityNavigationPropertyName: 'parentcustomerid_contact' },
  ],
  account: [],
};

const OPT = (Value, s) => ({ Value, Label: L(s) });
const CHOICES = {
  'contact.statecode': { OptionSet: { Options: [OPT(0, 'Active'), OPT(1, 'Inactive')] } },
  'contact.statuscode': { OptionSet: { Options: [{ ...OPT(1, 'Active'), State: 0 }, { ...OPT(2, 'Inactive'), State: 1 }] } },
  'contact.donotemail': { OptionSet: { TrueOption: OPT(1, 'Do Not Allow'), FalseOption: OPT(0, 'Allow') } },
  'account.statuscode': { OptionSet: { Options: [{ ...OPT(1, 'Active'), State: 0 }, { ...OPT(2, 'Inactive'), State: 1 }] } },
};

const IDS = {
  jane: '11111111-1111-1111-1111-111111111111',
  bob: '22222222-2222-2222-2222-222222222222',
  gone: '33333333-3333-3333-3333-333333333333',
  inactive: '44444444-4444-4444-4444-444444444444',
  acme: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  acme2: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000002',
  zeta: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000003',
  t1: 'bbbbbbbb-bbbb-bbbb-bbbb-000000000001',
  t2: 'bbbbbbbb-bbbb-bbbb-bbbb-000000000002',
  t3: 'bbbbbbbb-bbbb-bbbb-bbbb-000000000003',
  me: '99999999-9999-9999-9999-999999999999',
};

function records() {
  return {
    contacts: {
      [IDS.jane]: { contactid: IDS.jane, fullname: 'Jane Example', address1_line1: '12 Old Rd', address1_city: null, statecode: 0, statuscode: 1, _parentcustomerid_value: null, creditlimit: 10, donotemail: false },
      [IDS.bob]: { contactid: IDS.bob, fullname: 'Bob Sample', address1_line1: '9 Elm St', address1_city: 'Goleta', statecode: 0, statuscode: 1, _parentcustomerid_value: null, creditlimit: null, donotemail: false },
      [IDS.inactive]: { contactid: IDS.inactive, fullname: 'Ina Active', address1_line1: 'x', address1_city: 'y', statecode: 1, statuscode: 2 },
    },
    accounts: {
      [IDS.acme]: { accountid: IDS.acme, name: 'Acme Foundation', statecode: 0, merged: false, _masterid_value: null, telephone1: null, description: 'Long-time foundation donor.', createdon: '2022-03-01T17:00:00Z' },
      [IDS.acme2]: { accountid: IDS.acme2, name: 'Acme Foundation, Inc.', statecode: 0, merged: false, _masterid_value: null, telephone1: '805-555-0100', description: null, createdon: '2026-08-26T17:00:00Z' },
      [IDS.zeta]: { accountid: IDS.zeta, name: 'Zeta Corp', statecode: 0, merged: false, _masterid_value: null, telephone1: null, description: null, createdon: '2024-01-01T17:00:00Z' },
    },
    // t1 is in a long-closed fiscal year, t2 far in the future (open), t3 already on the kept record.
    msnfp_transactions: {
      [IDS.t1]: { msnfp_transactionid: IDS.t1, msnfp_name: 'TRN-1', msnfp_bookdate: '2024-05-01T07:00:00Z', _msnfp_customerid_value: IDS.acme2 },
      [IDS.t2]: { msnfp_transactionid: IDS.t2, msnfp_name: 'TRN-2', msnfp_bookdate: '2099-01-05T08:00:00Z', _msnfp_customerid_value: IDS.acme2 },
      [IDS.t3]: { msnfp_transactionid: IDS.t3, msnfp_name: 'TRN-3', msnfp_bookdate: '2099-02-05T08:00:00Z', _msnfp_customerid_value: IDS.acme },
    },
  };
}

// The Write Access table's rows, built from an access fixture ({ people: { email: { envs, max_rows, merge } } }),
// for one environment (the fake is one environment, the donor app).
function accessRows(access, env = 'donorapp') {
  const out = {};
  let n = 0;
  for (const [email, p] of Object.entries(access.people || {})) {
    if (!(p.envs || {})[env]) continue;
    n += 1;
    const id = `ffffffff-ffff-ffff-ffff-${String(n).padStart(12, '0')}`;
    out[id] = { sbrm_dataversewriteaccessid: id, sbrm_email: email, sbrm_level: p.envs[env], sbrm_maxrows: p.max_rows || null, sbrm_merge: !!(p.merge || {})[env], statecode: 0 };
  }
  return out;
}

function fakeDv({ email = 'dgross@example.org', dupHits = [], userId = IDS.me, ignoreOnWrite = [], beforeWrite = null, data = records(), access = ACCESS } = {}) {
  if (!data.sbrm_dataversewriteaccesses) data.sbrm_dataversewriteaccesses = accessRows(access);
  const calls = [];
  const notFound = () => new DataverseError('Does Not Exist', { code: '0x80040217' });
  const etags = new Map();
  const tag = (set, id) => `W/"${etags.get(`${set}/${id}`) || 1}"`;
  const bump = (set, id) => etags.set(`${set}/${id}`, (etags.get(`${set}/${id}`) || 1) + 1);
  const applyBody = (rec, body) => {
    for (const [k, v] of Object.entries(body)) {
      const m = /^(.+)@odata\.bind$/.exec(k);
      if (m) {
        // Any table's lookup: the contact navs plus every one-to-many relationship's nav (merge children).
        const all = [...NAVS.contact, ...Object.values(ONE_TO_MANY).flat()];
        const nav = all.find((n) => n.ReferencingEntityNavigationPropertyName === m[1]);
        if (!ignoreOnWrite.includes(nav.ReferencingAttribute)) rec[`_${nav.ReferencingAttribute}_value`] = v === null ? null : /\(([^)]+)\)/.exec(v)[1];
      } else if (!ignoreOnWrite.includes(k)) rec[k] = v;
    }
  };
  const dv = {
    cliVersion: 'fake',
    calls,
    data,
    touch(set, id, patch) { Object.assign(data[set][id], patch); bump(set, id); },
    logFails: false,
    create(set, body) {
      calls.push({ method: 'POST', path: set, body });
      if (set === 'sbrm_dataversewritelogs') {
        if (dv.logFails) throw new DataverseError('Principal user is missing prvCreatesbrm_dataversewritelog privilege');
        data[set] = data[set] || {};
        if (Object.values(data[set]).some((r) => r.sbrm_planid === body.sbrm_planid)) {
          throw new DataverseError('A record with matching key values already exists.', { code: '0x80040237' });
        }
        const id = `dddddddd-dddd-dddd-dddd-${String(Object.keys(data[set]).length).padStart(12, '0')}`;
        data[set][id] = { sbrm_dataversewritelogid: id, createdby: userId, _createdby_value: userId, createdon: new Date().toISOString(), ...body };
        return { sbrm_dataversewritelogid: id };
      }
      if (set === 'sbrm_dataverseevents') {
        if (dv.eventFails) throw new DataverseError('Principal user is missing prvCreatesbrm_dataverseevent privilege');
        data[set] = data[set] || {};
        if (Object.values(data[set]).some((r) => r.sbrm_eventid === body.sbrm_eventid)) {
          throw new DataverseError('A record with matching key values already exists.', { code: '0x80040237' });
        }
        const n = Object.keys(data[set]).length + 1;
        const id = `eeeeeeee-eeee-eeee-eeee-${String(n).padStart(12, '0')}`;
        data[set][id] = { sbrm_dataverseeventid: id, sbrm_number: `D-${String(n).padStart(4, '0')}`, createdby: userId, _createdby_value: userId, createdon: new Date().toISOString(), ...body };
        return {};
      }
      const id = `cccccccc-cccc-cccc-cccc-${String(Object.keys(data[set]).length).padStart(12, '0')}`;
      const rec = { contactid: id, statecode: 0, statuscode: 1 };
      applyBody(rec, body);
      data[set][id] = rec;
      return { ...rec };
    },
    update(set, id, body, etag) {
      calls.push({ method: 'PATCH', path: `${set}(${id})`, body, etag });
      if (beforeWrite) beforeWrite(dv, set, id);
      if (!data[set][id]) throw notFound();
      if (etag !== tag(set, id)) throw new DataverseError('version mismatch', { code: '0x80060882' });
      const wasMerged = data[set][id].merged === true;
      applyBody(data[set][id], body);
      // As the platform does (seen live 10/7, F&E Dev): reactivating a merged record clears merged + masterid.
      if (wasMerged && body.statecode === 0) Object.assign(data[set][id], { merged: false, _masterid_value: null });
      bump(set, id);
      return {};
    },
    get(p, opts = {}) {
      calls.push({ method: 'GET', path: p, formatted: !!opts.formatted });
      let m;
      if (p === 'WhoAmI') return { UserId: userId };
      if ((m = /^systemusers\(([^)]+)\)/.exec(p))) return { fullname: 'Test Person', internalemailaddress: email, domainname: email };
      if ((m = /^EntityDefinitions\?\$filter=EntitySetName eq '([^']+)'/.exec(p))) {
        return { value: Object.values(ENTITIES).filter((e) => e.EntitySetName === m[1]) };
      }
      if ((m = /^EntityDefinitions\?\$select=[^&]+&\$filter=(.*)$/.exec(p))) {
        const names = [...decodeURIComponent(m[1]).matchAll(/LogicalName eq '([^']+)'/g)].map((x) => x[1]);
        return { value: names.filter((x) => ENTITIES[x]).map((x) => ENTITIES[x]) };
      }
      if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\(LogicalName='([^']+)'\)/.exec(p))) {
        const c = CHOICES[`${m[1]}.${m[2]}`];
        if (!c) throw new DataverseError('not a choice');
        return c;
      }
      if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes/.exec(p))) return { value: ATTRS[m[1]] };
      if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/ManyToOneRelationships/.exec(p))) return { value: NAVS[m[1]] || [] };
      if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/OneToManyRelationships/.exec(p))) return { value: ONE_TO_MANY[m[1]] || [] };
      if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)/.exec(p))) return ENTITIES[m[1]];
      // The Write Access table (lib/access.js): every active row, or unreadable on request.
      if ((m = /^sbrm_dataversewriteaccesses\?\$select=[^&]+&\$filter=(.*)$/.exec(p))) {
        if (dv.accessUnreadable) throw new DataverseError("Principal user is missing prvReadsbrm_dataversewriteaccess privilege");
        return { value: Object.values(data.sbrm_dataversewriteaccesses || {}).filter((r) => (r.statecode || 0) === 0) };
      }
      // The two toolkit tables: "<column> eq '<value>'" filters exactly; a createdon window returns every row.
      if ((m = /^(sbrm_dataversewritelogs|sbrm_dataverseevents)\?\$select=[^&]+&\$filter=(.*)$/.exec(p))) {
        if (dv.tablesMissing) throw new DataverseError(`Resource not found for the segment '${m[1]}'.`);
        const f = decodeURIComponent(m[2]).split('&')[0];
        const rows = Object.values(data[m[1]] || {});
        const eq = /^(\w+) eq '([^']+)'$/.exec(f);
        if (eq) return { value: rows.filter((r) => r[eq[1]] === eq[2]) };
        if (/^createdon ge /.test(f)) return { value: rows };
        throw new Error(`fake dv: unsupported filter ${f}`);
      }
      if ((m = /^(sbrm_dataversewritelogs|sbrm_dataverseevents)\?\$top=1&\$select=[^&]+$/.exec(p))) {
        if (dv.tablesMissing) throw new DataverseError(`Resource not found for the segment '${m[1]}'.`);
        return { value: Object.values(data[m[1]] || {}).slice(0, 1) };
      }
      if ((m = /^([a-z_]+)\?\$top=1&\$select=[^&]+&\$filter=(.*)$/.exec(p))) {
        const f = decodeURIComponent(m[2]);
        if (f.includes('BAD')) throw new DataverseError('Could not find a property named BAD');
        return { value: dupHits.includes(f) ? [{}] : [] };
      }
      if ((m = /^([a-z_]+)\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        const rec = (data[m[1]] || {})[m[2]];
        if (!rec) throw notFound();
        const out = { '@odata.etag': tag(m[1], m[2]) };
        for (const k of m[3].split(',')) {
          out[k] = rec[k] === undefined ? null : rec[k];
          if (opts.formatted && k === 'statuscode') out['statuscode@OData.Community.Display.V1.FormattedValue'] = rec[k] === 1 ? 'Active' : 'Inactive';
        }
        return out;
      }
      // A whole record (no $select): every column, as Dataverse returns it.
      if ((m = /^([a-z_]+)\(([0-9a-f-]{36})\)$/.exec(p))) {
        const rec = (data[m[1]] || {})[m[2]];
        if (!rec) throw notFound();
        return { '@odata.etag': tag(m[1], m[2]), ...rec };
      }
      // Any other table: "_x_value eq <guid>" (children of a record) or "pk eq a or pk eq b" (by id).
      if ((m = /^([a-z_]+)\?\$select=([^&]+)&\$filter=(.*)$/.exec(p))) {
        if (!data[m[1]]) throw new DataverseError(`Resource not found for the segment '${m[1]}'.`);
        const f = decodeURIComponent(m[3]);
        const cols = m[2].split(',');
        const rows = Object.values(data[m[1]]);
        const pick = (r) => Object.fromEntries(cols.map((c) => [c, r[c] === undefined ? null : r[c]]));
        const ref = /^(_\w+_value) eq ([0-9a-f-]{36})$/.exec(f);
        if (ref) return { value: rows.filter((r) => r[ref[1]] === ref[2]).map(pick) };
        const ors = f.split(' or ').map((x) => /^(\w+) eq ([0-9a-f-]{36})$/.exec(x));
        if (ors.every(Boolean)) return { value: rows.filter((r) => ors.some((o) => r[o[1]] === o[2])).map(pick) };
        throw new Error(`fake dv: unsupported filter ${f}`);
      }
      throw new Error(`fake dv: unrouted GET ${p}`);
    },
    // Parallel reads, as cli.getMany returns them.
    getMany(paths) {
      return Promise.resolve(paths.map((p) => {
        try { return { ok: true, value: dv.get(p) }; } catch (error) { return { ok: false, error }; }
      }));
    },
    // Dataverse's Merge, as far as the engine depends on it: children re-pointed, duplicate flagged merged
    // into the kept record and deactivated, UpdateContent written onto the kept record.
    mergeFails: false,
    merge(body) {
      calls.push({ method: 'POST', path: 'Merge', body });
      if (dv.mergeFails) throw new DataverseError('Merge failed: the record is locked');
      const set = body.Target['@odata.type'] === 'Microsoft.Dynamics.CRM.account' ? 'accounts' : 'contacts';
      const pk = set === 'accounts' ? 'accountid' : 'contactid';
      const keep = body.Target[pk];
      const sub = body.Subordinate[pk];
      if (!data[set][keep] || !data[set][sub]) throw notFound();
      for (const [s, recs] of Object.entries(data)) {
        for (const r of Object.values(recs)) {
          if (r === data[set][sub]) continue;
          for (const k of Object.keys(r)) if (/^_.+_value$/.test(k) && k !== '_masterid_value' && r[k] === sub && !(dv.mergeLeaves || []).includes(s)) r[k] = keep;
        }
      }
      Object.assign(data[set][sub], { merged: true, _masterid_value: keep, statecode: 1 });
      const { '@odata.type': _t, ...content } = body.UpdateContent; // eslint-disable-line no-unused-vars
      Object.assign(data[set][keep], content);
      bump(set, keep);
      bump(set, sub);
      return {};
    },
  };
  return dv;
}

const ENVS = { donorapp: { host: 'https://example.invalid', name: 'Donor App' } };
const ACCESS = {
  default_max_rows: 25,
  people: {
    'dgross@example.org': { envs: { donorapp: 'schema' } },
    'writer@example.org': { envs: { donorapp: 'write' }, max_rows: 2 },
    'merger@example.org': { envs: { donorapp: 'write' }, merge: { donorapp: true } },
  },
};

module.exports = { fakeDv, records, IDS, ENVS, ACCESS };
