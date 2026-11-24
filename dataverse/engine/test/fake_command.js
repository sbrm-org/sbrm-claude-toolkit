'use strict';
// A fake Dataverse for kind "command" (lib/command.js): the command bar's `appactions` table as read live in Donor
// App Dev 11/20 and 11/23/26 (Shared Dataverse Write\cmdbar\). Shapes:
//   - the generic buttons are GLOBAL template rows: context 0, managed, hidden false, one per place (location 0 form,
//     1 main grid, 2 sub grid, 3 associated grid), name "Mscrm.<Form|HomepageGrid|SubGrid>.{!EntityLogicalName}.<X>",
//     a JavaScript action (onclickeventtype 2, a web resource, a function name) and classic rules reached through
//     appaction_appactionrule_classicrules.
//   - an override is a row with the template's name, context 1, contextvalue the table, an app, hidden true/false.
//   - a POST with an empty uniquename gets one from the server.
// Every call is recorded, so a test can assert a plan issued GETs only.

const crypto = require('crypto');
const { DataverseError } = require('../lib/cli');

const IDS = {
  me: '99999999-9999-9999-9999-999999999999',
  dev: 'a1000000-0000-0000-0000-000000000002',
  app: 'ab000000-0000-0000-0000-000000000001',       // SBRM Homeless
  otherApp: 'ab000000-0000-0000-0000-000000000002',  // SBRM Meals
  table: 'e7000000-0000-0000-0000-000000000001',     // sbrm_waitlistcount's metadata id
  solution: '50000000-0000-0000-0000-000000000001',
  managedSolution: '50000000-0000-0000-0000-000000000002',
  defaultSolution: '50000000-0000-0000-0000-000000000003', // unmanaged, but under Microsoft's publisher
  publisher: '9811ffde-0000-0000-0000-000000000001',       // SBRM's
  msPublisher: 'd21aab71-0000-0000-0000-000000000001',
  script: 'adea1aea-b2aa-e611-80d6-00155d88c343',
};
const guid = () => crypto.randomUUID();
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const PARTS = { 0: 'Form', 1: 'HomepageGrid', 2: 'SubGrid', 3: 'SubGrid' };
function template(button, location, rules = 2) {
  return {
    appactionid: guid(), name: `Mscrm.${PARTS[location]}.{!EntityLogicalName}.${button}`, location, context: 0, contextvalue: null, hidden: false, ismanaged: true,
    statecode: 0, type: 0, sequence: 100100000 + location, buttonlabeltext: button === 'NewRecord' ? 'New' : button, buttontooltiptitle: button,
    buttonaccessibilitytext: button, buttontooltipdescription: `${button} these {EntityLogicalNameCollectionMarker}.`, fonticon: '$clientsvg:PageBlock',
    onclickeventtype: 2, _onclickeventjavascriptwebresourceid_value: IDS.script, onclickeventjavascriptfunctionname: `XrmCore.Commands.${button}.run`,
    onclickeventjavascriptparameters: '[{"type":12,"value":null}]', visibilitytype: 2, uniquename: `msdyn_Mscrm.${PARTS[location]}.{!EntityLogicalName}.${button}!${location}`,
    _appmoduleid_value: null, _rules: Array.from({ length: rules }, guid), _v: 1,
  };
}

function data() {
  const appactions = [];
  for (const b of ['Deactivate', 'Activate', 'NewRecord']) for (const loc of [0, 1, 2, 3]) appactions.push(template(b, loc));
  return {
    systemusers: [
      { systemuserid: IDS.me, fullname: 'Test Admin', internalemailaddress: 'admin@example.org', domainname: 'admin@example.org' },
      { systemuserid: IDS.dev, fullname: 'Dana Dev', internalemailaddress: 'dev@example.org', domainname: 'dev@example.org' },
    ],
    appmodules: [
      { appmoduleid: IDS.app, name: 'SBRM Homeless', uniquename: 'sbrm_Homeless' },
      { appmoduleid: IDS.otherApp, name: 'SBRM Meals', uniquename: 'sbrm_Meals' },
    ],
    tables: { sbrm_waitlistcount: IDS.table },
    solutions: [
      { solutionid: IDS.solution, uniquename: 'SBRMWaitlistCount', friendlyname: 'SBRM Waitlist Count', ismanaged: false, _publisherid_value: IDS.publisher },
      { solutionid: IDS.managedSolution, uniquename: 'MicrosoftThing', friendlyname: 'Microsoft Thing', ismanaged: true, _publisherid_value: IDS.msPublisher },
      { solutionid: IDS.defaultSolution, uniquename: 'Default', friendlyname: 'Default Solution', ismanaged: false, _publisherid_value: IDS.msPublisher },
    ],
    appactions,
  };
}

// An override row as an earlier job (or the designer) left it.
function override(d, { button = 'Deactivate', location = 1, table = 'sbrm_waitlistcount', app = IDS.app, hidden = true, ismanaged = false } = {}) {
  const r = {
    appactionid: guid(), name: `Mscrm.${PARTS[location]}.{!EntityLogicalName}.${button}`, location, context: 1, contextvalue: table, hidden, ismanaged, statecode: 0,
    uniquename: `sbrm__x!${table}!${location}`, _appmoduleid_value: app, _rules: [], _v: 1,
  };
  d.appactions.push(r);
  return r;
}

function fakeCommandDv({ email = 'admin@example.org', userId = IDS.me, d = data(), host = 'https://hgs.invalid' } = {}) {
  const calls = [];
  const notFound = () => new DataverseError('Does Not Exist', { code: '0x80040217' });
  const pick = (rec, cols) => Object.fromEntries(cols.map((c) => [c, rec[c] === undefined ? null : rec[c]]));
  const shape = (r, select, expand) => ({ '@odata.etag': `W/"${r._v}"`, ...pick(r, select.split(',')), ...(expand ? { appaction_appactionrule_classicrules: r._rules.map((id) => ({ appactionruleid: id })) } : {}) });
  const eqs = (filter) => Object.fromEntries(decodeURIComponent(filter).split(' and ').map((c) => {
    const m = /^(\w+) eq (?:'((?:[^']|'')*)'|(\d+))$/.exec(c.trim());
    if (!m) throw new Error(`fake_command: unsupported filter clause ${c}`);
    return [m[1], m[2] !== undefined ? m[2].replace(/''/g, "'") : Number(m[3])];
  }));
  const fail = (verb) => { if (dv.failOn === verb) { dv.failOn = null; throw new DataverseError(`${verb} failed`, { code: '0x80040220' }); } };
  const dv = {
    cliVersion: 'fake', host, calls, data: d,
    failOn: null,          // 'createCommandHide' | 'linkCommandRule' | 'setCommandHidden': that verb throws once
    createReturnsNoId: false,
    ignoreHidden: false,   // the platform answers OK but the row's hidden flag does not change
    dropRules: false,      // the platform answers OK to a rule link but links nothing
    get(p, opts) {
      calls.push({ method: 'GET', path: p, strong: Boolean(opts && opts.strong) });
      let m;
      if (p === 'WhoAmI') return { UserId: userId };
      if ((m = /^systemusers\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        const u = d.systemusers.find((x) => same(x.systemuserid, m[1]));
        if (!u) throw notFound();
        return pick({ ...u, ...(same(u.systemuserid, userId) ? { internalemailaddress: email, domainname: email } : {}) }, m[2].split(','));
      }
      if ((m = /^appmodules\?\$select=([^&]*)&\$filter=(.*)$/.exec(p))) {
        const f = eqs(m[2]);
        return { value: d.appmodules.filter((a) => a.uniquename === f.uniquename).map((a) => pick(a, m[1].split(','))) };
      }
      if ((m = /^EntityDefinitions\(LogicalName='([a-z0-9_]+)'\)\?\$select=MetadataId,LogicalName(,IsManaged)?$/.exec(p))) {
        if (!d.tables[m[1]]) throw new DataverseError(`Could not find an entity with name ${m[1]}`, { code: '0x80060888' });
        return { MetadataId: d.tables[m[1]], LogicalName: m[1], ...(m[2] ? { IsManaged: (d.managedTables || []).includes(m[1]) } : {}) };
      }
      if ((m = /^solutions\?\$select=([^&]*)&\$filter=(.*)$/.exec(p))) {
        const f = eqs(m[2]);
        return { value: d.solutions.filter((s) => s.uniquename === f.uniquename).map((s) => pick(s, m[1].split(','))) };
      }
      if ((m = /^appactions\?\$select=([^&]*)(&\$expand=[^&]*)?&\$filter=(.*)$/.exec(p))) {
        const f = eqs(m[3]);
        const rows = d.appactions.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v));
        return { value: rows.map((r) => shape(r, m[1], Boolean(m[2]))) };
      }
      if ((m = /^appactions\(([0-9a-f-]{36})\)\?\$select=([^&]*)(&\$expand=[^&]*)?$/.exec(p))) {
        const r = d.appactions.find((x) => same(x.appactionid, m[1]));
        if (!r) throw notFound();
        return shape(r, m[2], Boolean(m[3]));
      }
      throw new Error(`fake_command: unrouted GET ${p}`);
    },
    createCommandHide(args, solution) {
      calls.push({ method: 'POST', verb: 'createCommandHide', args: JSON.parse(JSON.stringify(args)), solution });
      fail('createCommandHide');
      const id = guid();
      d.appactions.push({
        appactionid: id, name: args.name, location: args.location, context: 1, contextvalue: args.table, hidden: !dv.ignoreHidden, ismanaged: false, statecode: 0,
        uniquename: `sbrm__${args.name}!app!${args.table}!${args.location}`, _appmoduleid_value: args.appId, _rules: [], _v: 1, _solution: solution, _fields: args.fields, _entity: args.entityId,
      });
      return dv.createReturnsNoId ? {} : { appactionid: id };
    },
    linkCommandRule(id, ruleId) {
      calls.push({ method: 'POST', verb: 'linkCommandRule', id, ruleId });
      fail('linkCommandRule');
      const r = d.appactions.find((x) => same(x.appactionid, id));
      if (!r) throw notFound();
      if (!dv.dropRules) r._rules.push(ruleId);
      return {};
    },
    setCommandHidden(id, hidden, etag) {
      calls.push({ method: 'PATCH', verb: 'setCommandHidden', id, hidden, etag });
      fail('setCommandHidden');
      const r = d.appactions.find((x) => same(x.appactionid, id));
      if (!r) throw notFound();
      if (etag !== `W/"${r._v}"`) throw new DataverseError('The version of the existing record doesn\'t match the RowVersion property provided.', { code: '0x80060882' });
      if (!dv.ignoreHidden) r.hidden = hidden;
      r._v += 1;
      return {};
    },
    update() { throw new Error('fake_command: never a records PATCH'); },
    create() { throw new Error('fake_command: never a records POST'); },
    remove() { throw new Error('fake_command: never a DELETE'); },
  };
  return dv;
}

const ENVS = { hgs: { host: 'https://hgs.invalid', name: 'HGS apps', publisher: IDS.publisher }, recovery: { host: 'https://rec.invalid', name: 'Recovery app', publisher: IDS.publisher } };
const ACCESS = { people: { 'admin@example.org': { envs: { hgs: 'admin', recovery: 'admin' } }, 'dev@example.org': { envs: { hgs: 'develop' } } } };

module.exports = { fakeCommandDv, data, override, IDS, ENVS, ACCESS };
