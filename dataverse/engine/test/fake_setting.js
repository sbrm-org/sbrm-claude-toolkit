'use strict';
// A fake Dataverse for app settings (lib/setting.js): environment variable definitions and their current
// values, the cloud flows that name them, and the solutions a value row sits in. Shapes are as read live from
// HGS on 10/18/26 (sbrm_SharePointDocumentsEnable: definition 84285367-..., value row 338b0829-..., value
// "no", carried in airSlateForms and CMUpdates202411). Every call is recorded, so a test can assert a plan
// issued GETs only.
//
// Platform behaviour it imitates:
//   - a PATCH carries If-Match; a stale tag is refused (0x80060882), as on any record;
//   - Yes/No settings hold the text "yes" or "no" (read across all five apps 10/18: no other spelling);
//   - `contains(clientdata,'<schema name>')` on workflows finds the flows that name a setting (proved live
//     10/18 on HGS: exactly the one flow that reads sbrm_SharePointDocumentsEnable).

const { DataverseError } = require('../lib/cli');

const IDS = {
  me: '99999999-9999-9999-9999-999999999999',
  docsDef: '84285367-e3f6-4af7-a183-5b3a39e27939',
  docsVal: '338b0829-f5e1-ec11-bb3d-000d3a31a448',
  notesDef: 'a0000000-0000-0000-0000-000000000002',
  notesVal: 'b0000000-0000-0000-0000-000000000002',
  countDef: 'a0000000-0000-0000-0000-000000000003',
  countVal: 'b0000000-0000-0000-0000-000000000003',
  jsonDef: 'a0000000-0000-0000-0000-000000000004',
  jsonVal: 'b0000000-0000-0000-0000-000000000004',
  textDef: 'a0000000-0000-0000-0000-000000000005',
  textVal: 'b0000000-0000-0000-0000-000000000005',
  secretDef: 'a0000000-0000-0000-0000-000000000006',
  secretVal: 'b0000000-0000-0000-0000-000000000006',
  sourceDef: 'a0000000-0000-0000-0000-000000000007',
  sourceVal: 'b0000000-0000-0000-0000-000000000007',
  defaultOnlyDef: 'a0000000-0000-0000-0000-000000000008',
  msDef: 'a0000000-0000-0000-0000-000000000009',
  msVal: 'b0000000-0000-0000-0000-000000000009',
  twoDef: 'a0000000-0000-0000-0000-00000000000a',
  twoValA: 'b0000000-0000-0000-0000-00000000000a',
  twoValB: 'b0000000-0000-0000-0000-00000000000b',
  docsFlow: 'c0000000-0000-0000-0000-000000000001',
  offFlow: 'c0000000-0000-0000-0000-000000000002',
  otherFlow: 'c0000000-0000-0000-0000-000000000003',
  airslate: 'd0000000-0000-0000-0000-000000000001',
  cmupdates: 'd0000000-0000-0000-0000-000000000002',
  defaultSol: 'fd140aae-4df4-11dd-bd17-0019b9312238',
};

const TYPE = { text: 100000000, number: 100000001, yesno: 100000002, json: 100000003, source: 100000004, secret: 100000005 };

function def(id, schemaname, displayname, type, defaultvalue, { ismanaged = false, statecode = 0 } = {}) {
  return { environmentvariabledefinitionid: id, schemaname, displayname, type, defaultvalue, ismanaged, statecode };
}
function val(id, defId, value, { ismanaged = false, statecode = 0 } = {}) {
  return { environmentvariablevalueid: id, _environmentvariabledefinitionid_value: defId, value, ismanaged, statecode };
}
const cd = (names) => JSON.stringify({ properties: { definition: { parameters: Object.fromEntries(names.map((n) => [`${n} (${n})`, { type: 'Bool', metadata: { schemaName: n } }])) } } });

function data() {
  return {
    environmentvariabledefinitions: [
      def(IDS.docsDef, 'sbrm_SharePointDocumentsEnable', 'SharePoint Documents - Enable', TYPE.yesno, 'no'),
      def(IDS.notesDef, 'sbrm_NotificationsEnable', 'Notifications - Enable', TYPE.yesno, 'no'),
      def(IDS.countDef, 'sbrm_BatchSize', 'Batch Size', TYPE.number, '25'),
      def(IDS.jsonDef, 'sbrm_RoutingRules', 'Routing Rules', TYPE.json, '{}'),
      def(IDS.textDef, 'sbrm_SiteUrl', 'Site URL', TYPE.text, ''),
      def(IDS.secretDef, 'sbrm_ApiKey', 'API Key', TYPE.secret, null),
      def(IDS.sourceDef, 'sbrm_DocsLibrary', 'Documents Library', TYPE.source, null),
      def(IDS.defaultOnlyDef, 'sbrm_EmailEnable', 'Email - Enable', TYPE.yesno, 'no'),
      def(IDS.msDef, 'msdyn_SLAWebClientDeprecationAcknowledge', 'SLA Acknowledge', TYPE.number, '0', { ismanaged: true }),
      def(IDS.twoDef, 'sbrm_Twice', 'Twice', TYPE.text, ''),
    ],
    environmentvariablevalues: [
      val(IDS.docsVal, IDS.docsDef, 'no'),
      val(IDS.notesVal, IDS.notesDef, 'yes'),
      val(IDS.countVal, IDS.countDef, '25'),
      val(IDS.jsonVal, IDS.jsonDef, '{"a":1}'),
      val(IDS.textVal, IDS.textDef, 'https://example.invalid/sites/a'),
      val(IDS.secretVal, IDS.secretDef, 'vault-reference'),
      val(IDS.sourceVal, IDS.sourceDef, 'https://example.invalid/sites/a'),
      val(IDS.msVal, IDS.msDef, '0', { ismanaged: true }),
      val(IDS.twoValA, IDS.twoDef, 'a'),
      val(IDS.twoValB, IDS.twoDef, 'b'),
    ],
    workflows: [
      { workflowid: IDS.docsFlow, name: 'Guest > Integrate Documents', category: 5, statecode: 1, clientdata: cd(['sbrm_SharePointDocumentsEnable']) },
      { workflowid: IDS.offFlow, name: 'Old Notifications', category: 5, statecode: 0, clientdata: cd(['sbrm_NotificationsEnable']) },
      { workflowid: IDS.otherFlow, name: 'Unrelated', category: 5, statecode: 1, clientdata: cd(['sbrm_Other']) },
    ],
    solutioncomponents: [
      { solutioncomponentid: 'e0000000-0000-0000-0000-000000000001', objectid: IDS.docsVal, componenttype: 381, _solutionid_value: IDS.airslate },
      { solutioncomponentid: 'e0000000-0000-0000-0000-000000000002', objectid: IDS.docsVal, componenttype: 381, _solutionid_value: IDS.cmupdates },
      { solutioncomponentid: 'e0000000-0000-0000-0000-000000000003', objectid: IDS.docsVal, componenttype: 381, _solutionid_value: IDS.defaultSol },
    ],
    solutions: [
      { solutionid: IDS.airslate, uniquename: 'airSlateForms', friendlyname: 'airSlate Forms', ismanaged: false },
      { solutionid: IDS.cmupdates, uniquename: 'CMUpdates202411', friendlyname: 'CM Updates 2024-11', ismanaged: false },
      { solutionid: IDS.defaultSol, uniquename: 'Default', friendlyname: 'Default Solution', ismanaged: false },
    ],
  };
}

const ID_COL = { environmentvariabledefinitions: 'environmentvariabledefinitionid', environmentvariablevalues: 'environmentvariablevalueid', workflows: 'workflowid', solutions: 'solutionid' };

// Tiny $filter evaluator: ANDs of `col eq 'text'`, `col eq <guid>`, `col eq 5`, `contains(col,'text')`.
function matcher(filter) {
  const ands = filter.split(' and ').map((c) => {
    let m;
    if ((m = /^contains\((\w+),'((?:[^']|'')*)'\)$/.exec(c.trim()))) {
      const [, col, v] = m;
      return (r) => String(r[col] || '').includes(v.replace(/''/g, "'"));
    }
    if ((m = /^(\w+) eq '((?:[^']|'')*)'$/.exec(c.trim()))) {
      const [, col, v] = m;
      return (r) => String(r[col]).toLowerCase() === v.replace(/''/g, "'").toLowerCase();
    }
    if ((m = /^(\w+) eq ([0-9a-f]{8}-[0-9a-f-]{27})$/i.exec(c.trim()))) {
      const [, col, v] = m;
      return (r) => String(r[col]).toLowerCase() === v.toLowerCase();
    }
    if ((m = /^(\w+) eq (-?\d+)$/.exec(c.trim()))) {
      const [, col, v] = m;
      return (r) => r[col] === Number(v);
    }
    throw new Error(`fake_setting: unsupported filter clause "${c}"`);
  });
  return (r) => ands.every((f) => f(r));
}

function fakeSettingDv({ email = 'admin@example.org', userId = IDS.me, fullname = 'Test Admin', d = data(), host = 'https://hgs.invalid' } = {}) {
  const calls = [];
  const etags = new Map();
  const tag = (set, id) => `W/"${etags.get(`${set}/${id}`) || 1}"`;
  const bump = (set, id) => etags.set(`${set}/${id}`, (etags.get(`${set}/${id}`) || 1) + 1);
  const find = (set, id) => (d[set] || []).find((r) => String(r[ID_COL[set]]).toLowerCase() === String(id).toLowerCase());
  const dv = {
    cliVersion: 'fake',
    host,
    calls,
    data: d,
    readBackDrops: false, // the platform silently keeps the old value (read-back mismatch)
    touch(set, id, patch) { Object.assign(find(set, id), patch); bump(set, id); },
    get(p) {
      calls.push({ method: 'GET', path: p });
      let m;
      if (p === 'WhoAmI') return { UserId: userId };
      if ((m = /^systemusers\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        if (m[1] === userId) return { fullname, internalemailaddress: email, domainname: email, isdisabled: false };
        throw new DataverseError('Does Not Exist', { code: '0x80040217' });
      }
      if ((m = /^(environmentvariabledefinitions|environmentvariablevalues|workflows|solutions)\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        const rec = find(m[1], m[2]);
        if (!rec) throw new DataverseError('Does Not Exist', { code: '0x80040217' });
        const out = { '@odata.etag': tag(m[1], m[2]) };
        for (const k of m[3].split(',')) out[k] = rec[k] === undefined ? null : rec[k];
        return out;
      }
      if ((m = /^([a-z_]+)\?\$select=([^&]+)&\$filter=(.*)$/.exec(p))) {
        const rows = d[m[1]];
        if (!rows) throw new DataverseError(`Resource not found for the segment '${m[1]}'.`);
        const keep = matcher(decodeURIComponent(m[3]));
        const cols = m[2].split(',');
        return {
          value: rows.filter(keep).map((r) => {
            const out = ID_COL[m[1]] ? { '@odata.etag': tag(m[1], r[ID_COL[m[1]]]) } : {};
            for (const c of cols) out[c] = r[c] === undefined ? null : r[c];
            return out;
          }),
        };
      }
      throw new Error(`fake_setting: unrouted GET ${p}`);
    },
    update(set, id, body, etag) {
      calls.push({ method: 'PATCH', path: `${set}(${id})`, body, etag });
      const rec = find(set, id);
      if (!rec) throw new DataverseError('Does Not Exist', { code: '0x80040217' });
      if (etag !== tag(set, id)) throw new DataverseError('version mismatch', { code: '0x80060882' });
      if (!dv.readBackDrops) Object.assign(rec, body);
      bump(set, id);
      return {};
    },
    create(set, body) {
      calls.push({ method: 'POST', path: set, body });
      throw new Error('fake_setting: a setting change never creates');
    },
    remove(set, id) {
      calls.push({ method: 'DELETE', path: `${set}(${id})` });
      throw new Error('fake_setting: a setting change never deletes');
    },
  };
  return dv;
}

const ENVS = {
  hgs: { host: 'https://hgs.invalid', name: 'HGS App' },
  recovery: { host: 'https://rec.invalid', name: 'Recovery App' },
};
const ACCESS = {
  people: {
    'admin@example.org': { envs: { hgs: 'admin', recovery: 'admin' } },
    'dev@example.org': { envs: { hgs: 'develop' } },
    'writer@example.org': { envs: { hgs: 'write' } },
  },
};

module.exports = { fakeSettingDv, data, IDS, TYPE, ENVS, ACCESS };
