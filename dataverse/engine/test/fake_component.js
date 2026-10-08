'use strict';
// A fake Dataverse for app components (lib/component.js): views (savedqueries), forms (systemforms),
// sitemaps and cloud flows (workflows), with the connection references, solutions, users, trigger
// subscriptions and Write Log rows a component plan and apply read. Shapes are as read live from Donor App
// Dev on 10/7/26. Every call is recorded, so a test can assert a plan issued GETs only.
//
// Platform behaviour it imitates, each from a live finding (a live finding):
//   - a PATCH or DELETE carries If-Match; a stale tag is refused (0x80060882);
//   - a flow definition that drops trigger concurrency is refused ("cannot be removed once specified");
//   - turning a flow on, or handing it over, when the caller does not own its connections is refused with
//     403 ConnectionAuthorizationFailed (`connectionOwnerOnly`);
//   - a flow that is on with a Dataverse trigger has a callbackregistration carrying the trigger's filter,
//     re-registered on every save (`staleSubscription` keeps the old one).

const { DataverseError } = require('../lib/cli');

const IDS = {
  me: '99999999-9999-9999-9999-999999999999',
  appadmin: 'f00ef932-d3dd-ee11-904d-000d3a3740b2',
  dev2: '88888888-8888-8888-8888-888888888888',
  gone: '77777777-7777-7777-7777-777777777777',
  flow: '11111111-1111-1111-1111-000000000001',
  caller: '11111111-1111-1111-1111-000000000002',
  offflow: '11111111-1111-1111-1111-000000000003',
  mflow: '11111111-1111-1111-1111-000000000004',
  rule: '11111111-1111-1111-1111-000000000005',
  view: '22222222-2222-2222-2222-000000000001',
  mview: '22222222-2222-2222-2222-000000000002',
  form: '33333333-3333-3333-3333-000000000001',
  sitemap: '44444444-4444-4444-4444-000000000001',
  pub: 'b39485ad-5b1d-ef11-840a-6045bd07878a',
  otherpub: '00000001-0000-0000-0000-00000000005a',
};

const REF = (logical, api = 'shared_commondataserviceforapps') => ({ runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: logical }, api: { name: api } });

// A Dataverse-triggered flow, as Power Automate saves it.
function flowCd({ filter = 'msnfp_amount', table = 'msnfp_transaction', message = 3, concurrency = null, note = 'Fires when the amount changes (10/7).', actions = null, refs = null, conditions = [] } = {}) {
  const trigger = {
    metadata: { operationMetadataId: 'aaaaaaaa-0000-0000-0000-000000000001' },
    type: 'OpenApiConnectionWebhook',
    inputs: {
      host: { connectionName: 'shared_commondataserviceforapps', operationId: 'SubscribeWebhookTrigger', apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' },
      parameters: { 'subscriptionRequest/message': message, 'subscriptionRequest/entityname': table, 'subscriptionRequest/scope': 4, ...(filter ? { 'subscriptionRequest/filteringattributes': filter } : {}) },
      authentication: "@parameters('$authentication')",
    },
    conditions: conditions.map((expression) => ({ expression })),
    description: note,
  };
  if (concurrency) trigger.runtimeConfiguration = { concurrency };
  return {
    properties: {
      connectionReferences: refs || { shared_commondataserviceforapps: REF('sbrm_dataverse_appadmin') },
      definition: {
        $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
        contentVersion: '1.0.0.0',
        parameters: { $connections: { defaultValue: {}, type: 'Object' }, $authentication: { defaultValue: {}, type: 'SecureObject' } },
        triggers: { When_a_row_is_modified: trigger },
        actions: actions || {
          Get_donor: {
            runAfter: {}, metadata: { operationMetadataId: 'aaaaaaaa-0000-0000-0000-000000000002' }, type: 'OpenApiConnection', description: 'Reads the donor.',
            inputs: { host: { connectionName: 'shared_commondataserviceforapps', operationId: 'GetItem', apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' }, parameters: { entityName: 'contacts', recordId: "@triggerOutputs()?['body/_msnfp_customerid_value']" } },
          },
          Compose_total: { runAfter: { Get_donor: ['Succeeded'] }, type: 'Compose', inputs: "@body('Get_donor')?['msnfp_lifetimegiving_rollup']" },
        },
      },
    },
    schemaVersion: '1.0.0.0',
  };
}

const FETCH = '<fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false"><entity name="contact"><attribute name="fullname" /><attribute name="emailaddress1" /><attribute name="contactid" /><order attribute="fullname" descending="false" /><filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter></entity></fetch>';
const LAYOUT = '<grid name="resultset" jump="fullname" select="1" icon="1" preview="1" object="2"><row name="result" id="contactid"><cell name="fullname" width="300" /><cell name="emailaddress1" width="150" /></row></grid>';
const FORM = '<form showImage="true"><hiddencontrols><data id="fullname" datafieldname="fullname" classid="{5546E6CD-394C-4bee-94A8-4425E17EF6C6}" /></hiddencontrols>'
  + '<tabs><tab name="SUMMARY_TAB" id="{15bb2d4b-71da-74ea-3c5b-e497d78a55a2}" showlabel="true" expanded="true"><labels><label description="Summary" languagecode="1033" /></labels><columns><column width="100%"><sections>'
  + '<section name="ContactName" showlabel="true" id="{171eb131-b951-e349-d535-1799c43167e5}"><labels><label description="CONTACT NAME" languagecode="1033" /></labels><rows>'
  + '<row><cell id="{8409686a-8e44-2acb-5036-a320ddb10447}" showlabel="true"><labels><label description="First Name" languagecode="1033" /></labels><control id="firstname" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="firstname" disabled="false" /></cell></row>'
  + '<row><cell id="{8783146d-90b8-49b9-cabc-4a673c802073}" showlabel="true"><labels><label description="Last Name" languagecode="1033" /></labels><control id="lastname" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="lastname" disabled="false" /></cell></row>'
  + '<row><cell id="{9783146d-90b8-49b9-cabc-4a673c802073}" showlabel="true"><labels><label description="Email" languagecode="1033" /></labels><control id="emailaddress1" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="emailaddress1" disabled="false" /></cell></row>'
  + '</rows></section></sections></column></columns></tab></tabs>'
  + '<events><event name="onload" application="false" active="true"><Handlers><Handler functionName="Form.onLoad" libraryName="sbrm_contact.js" enabled="true" /></Handlers></event></events></form>';
const SITEMAP = '<SiteMap IntroducedVersion="7.0.0.0"><Area Id="area_donors" ShowGroups="true"><Titles><Title LCID="1033" Title="Donors" /></Titles>'
  + '<Group Id="group_people"><Titles><Title LCID="1033" Title="People" /></Titles>'
  + '<SubArea Id="subarea_contacts" Entity="contact" Icon="/WebResources/x" /><SubArea Id="subarea_accounts" Entity="account" /></Group></Area></SiteMap>';

function data() {
  return {
    workflows: {
      [IDS.flow]: { workflowid: IDS.flow, name: 'Add Soft Credit', ismanaged: false, category: 5, statecode: 1, statuscode: 2, _ownerid_value: IDS.appadmin, description: 'Stamp 9/25.', clientdata: JSON.stringify(flowCd()) },
      [IDS.caller]: { workflowid: IDS.caller, name: 'Gift Batch Posted', ismanaged: false, category: 5, statecode: 1, statuscode: 2, _ownerid_value: IDS.appadmin, description: null, clientdata: JSON.stringify(flowCd({ actions: { Run_child: { runAfter: {}, type: 'Workflow', inputs: { host: { workflowReferenceName: IDS.offflow } } } } })) },
      [IDS.offflow]: { workflowid: IDS.offflow, name: 'Sync Letters', ismanaged: false, category: 5, statecode: 0, statuscode: 1, _ownerid_value: IDS.me, description: null, clientdata: JSON.stringify(flowCd({ refs: { shared_commondataserviceforapps: REF('sbrm_dataverse_owner2') } })) },
      [IDS.mflow]: { workflowid: IDS.mflow, name: 'Microsoft Flow', ismanaged: true, category: 5, statecode: 1, statuscode: 2, _ownerid_value: IDS.appadmin, description: null, clientdata: JSON.stringify(flowCd()) },
      [IDS.rule]: { workflowid: IDS.rule, name: 'Require Phone', ismanaged: false, category: 2, statecode: 1, statuscode: 2, _ownerid_value: IDS.appadmin, description: null, clientdata: null },
    },
    savedqueries: {
      [IDS.view]: { savedqueryid: IDS.view, name: 'Active Donors', ismanaged: false, statecode: 0, returnedtypecode: 'contact', querytype: 0, description: null, fetchxml: FETCH, layoutxml: LAYOUT },
      [IDS.mview]: { savedqueryid: IDS.mview, name: 'Active Contacts', ismanaged: true, statecode: 0, returnedtypecode: 'contact', querytype: 0, description: null, fetchxml: FETCH, layoutxml: LAYOUT },
    },
    systemforms: {
      [IDS.form]: { formid: IDS.form, name: 'SBRM Donor: Contact', ismanaged: false, objecttypecode: 'contact', type: 2, description: 'copy of fundraising contact form', formxml: FORM },
    },
    sitemaps: {
      [IDS.sitemap]: { sitemapid: IDS.sitemap, sitemapname: 'Donor App', sitemapnameunique: 'sbrm_DonorApp', ismanaged: false, sitemapxml: SITEMAP },
    },
    connectionreferences: [
      { connectionreferenceid: 'c0000000-0000-0000-0000-000000000001', connectionreferencelogicalname: 'sbrm_dataverse_appadmin', connectionreferencedisplayname: 'Microsoft Dataverse', connectionid: 'shared-commondataser-1', statecode: 0, _ownerid_value: IDS.appadmin },
      { connectionreferenceid: 'c0000000-0000-0000-0000-000000000002', connectionreferencelogicalname: 'sbrm_outlook_appadmin', connectionreferencedisplayname: 'Office 365 Outlook', connectionid: 'shared-office365-1', statecode: 0, _ownerid_value: IDS.appadmin },
      { connectionreferenceid: 'c0000000-0000-0000-0000-000000000003', connectionreferencelogicalname: 'sbrm_dataverse_owner2', connectionreferencedisplayname: 'Microsoft Dataverse (second owner)', connectionid: 'shared-commondataser-2', statecode: 0, _ownerid_value: IDS.me },
      { connectionreferenceid: 'c0000000-0000-0000-0000-000000000004', connectionreferencelogicalname: 'sbrm_dataverse_unbound', connectionreferencedisplayname: 'Microsoft Dataverse', connectionid: null, statecode: 0, _ownerid_value: IDS.appadmin },
    ],
    solutions: [
      { solutionid: '50000000-0000-0000-0000-000000000001', uniquename: 'SBRMAdHocChanges', friendlyname: 'SBRM Ad-Hoc Changes', ismanaged: false, _publisherid_value: IDS.pub },
      { solutionid: '50000000-0000-0000-0000-000000000002', uniquename: 'msdynce_Fundraising', friendlyname: 'Fundraising', ismanaged: true, _publisherid_value: IDS.otherpub },
      { solutionid: '50000000-0000-0000-0000-000000000003', uniquename: 'Crfb496', friendlyname: 'Common Data Services Default Solution', ismanaged: false, _publisherid_value: IDS.otherpub },
    ],
    systemusers: {
      [IDS.appadmin]: { fullname: 'SBRM App Admin', isdisabled: false },
      [IDS.dev2]: { fullname: 'Dana Martin', isdisabled: false },
      [IDS.gone]: { fullname: 'Former Staff', isdisabled: true },
    },
    callbackregistrations: [
      { callbackregistrationid: 'cb000000-0000-0000-0000-000000000001', name: IDS.flow, entityname: 'msnfp_transaction', message: 3, filteringattributes: 'msnfp_amount', modifiedon: '2026-09-25T10:00:00Z', _ownerid_value: IDS.appadmin },
    ],
    sbrm_dataversewritelogs: [],
    // Unpublished layers (maker-portal edits saved, not published): set -> id -> the fields that differ, or a
    // whole row for a component that exists only unpublished.
    drafts: { savedqueries: {}, systemforms: {}, sitemaps: {} },
    attrs: {
      contact: ['contactid', 'fullname', 'firstname', 'lastname', 'emailaddress1', 'telephone1', 'statecode'],
      msnfp_transaction: ['msnfp_transactionid', 'msnfp_amount'],
    },
  };
}

const ID_COL = { workflows: 'workflowid', savedqueries: 'savedqueryid', systemforms: 'formid', sitemaps: 'sitemapid' };
const FORMATTED = '@OData.Community.Display.V1.FormattedValue';

// Tiny $filter evaluator: ORs of ANDs of `col eq 'text'`, `col eq 5`, `col eq true`, `contains(col,'text')`.
function matcher(filter) {
  const ors = filter.split(' or ').map((part) => part.split(' and ').map((c) => {
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
    if ((m = /^(\w+) eq (true|false|-?\d+)$/.exec(c.trim()))) {
      const [, col, v] = m;
      const want = v === 'true' ? true : v === 'false' ? false : Number(v);
      return (r) => r[col] === want;
    }
    throw new Error(`fake_component: unsupported filter clause "${c}"`);
  }));
  return (r) => ors.some((ands) => ands.every((f) => f(r)));
}

function daTrigger(clientdata) {
  try {
    const t = Object.values(JSON.parse(clientdata).properties.definition.triggers)[0];
    const p = t.inputs.parameters;
    return p['subscriptionRequest/entityname'] ? { table: p['subscriptionRequest/entityname'], filter: p['subscriptionRequest/filteringattributes'] || null, message: p['subscriptionRequest/message'] } : null;
  } catch {
    return null;
  }
}

function hasConcurrency(clientdata) {
  try {
    return Object.values(JSON.parse(clientdata).properties.definition.triggers).some((t) => t.runtimeConfiguration && t.runtimeConfiguration.concurrency);
  } catch {
    return false;
  }
}

function fakeComponentDv({ email = 'dev@example.org', userId = IDS.me, fullname = 'Test Person', d = data() } = {}) {
  const calls = [];
  const notFound = () => new DataverseError('Does Not Exist', { code: '0x80040217' });
  const etags = new Map();
  const tag = (set, id) => `W/"${etags.get(`${set}/${id}`) || 1}"`;
  const bump = (set, id) => etags.set(`${set}/${id}`, (etags.get(`${set}/${id}`) || 1) + 1);
  const userName = (id) => (id === userId ? fullname : (d.systemusers[id] || {}).fullname || id);
  const register = (dv, id) => {
    const w = d.workflows[id];
    const t = w && w.statecode === 1 ? daTrigger(w.clientdata) : null;
    if (dv.staleSubscription) return;
    d.callbackregistrations = d.callbackregistrations.filter((c) => c.name !== id);
    if (t) d.callbackregistrations.push({ callbackregistrationid: `cb-${id}`, name: id, entityname: t.table, message: t.message, filteringattributes: t.filter, modifiedon: new Date().toISOString(), _ownerid_value: w._ownerid_value });
  };

  const dv = {
    cliVersion: 'fake',
    calls,
    data: d,
    connectionOwnerOnly: false,
    staleSubscription: false,
    publishFails: false,
    readBackDrops: null, // a field the platform silently does not store (read-back mismatch)
    failReads: null, // an id whose reads fail with something other than "does not exist", once anything was written
    touch(set, id, patch) { Object.assign(d[set][id], patch); bump(set, id); },
    get(p, opts = {}) {
      calls.push({ method: 'GET', path: p, formatted: !!opts.formatted });
      let m;
      if (p === 'WhoAmI') return { UserId: userId };
      if ((m = /^systemusers\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        if (m[1] === userId) return { fullname, internalemailaddress: email, domainname: email, isdisabled: false };
        if (!d.systemusers[m[1]]) throw notFound();
        return { ...d.systemusers[m[1]] };
      }
      if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\?\$select=LogicalName$/.exec(p))) {
        if (!d.attrs[m[1]]) throw new DataverseError(`Could not find an entity with name ${m[1]}`);
        return { value: d.attrs[m[1]].map((LogicalName) => ({ LogicalName })) };
      }
      // RetrieveUnpublishedMultiple: every component's latest layer (the draft where there is one), as live.
      if ((m = /^(savedqueries|systemforms|sitemaps)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?\$select=([^&]+)&\$filter=(.*)$/.exec(p))) {
        const set = m[1];
        const keep = matcher(decodeURIComponent(m[3]));
        const ids = new Set([...Object.keys(d[set]), ...Object.keys(d.drafts[set])]);
        const rows = [...ids].map((id) => ({ ...(d[set][id] || {}), ...(d.drafts[set][id] || {}) }));
        return { value: rows.filter(keep).map((r) => Object.fromEntries(m[2].split(',').map((c) => [c, r[c] === undefined ? null : r[c]]))) };
      }
      if ((m = /^(workflows|savedqueries|systemforms|sitemaps)\(([0-9a-f-]{36})\)\?\$select=(.*)$/.exec(p))) {
        if (dv.failReads === m[2] && calls.some((c) => c.method !== 'GET')) throw new DataverseError('The service is temporarily unavailable', { code: '0x80072322', status: 503 });
        const rec = d[m[1]][m[2]];
        if (!rec) throw notFound();
        const out = { '@odata.etag': tag(m[1], m[2]) };
        for (const k of m[3].split(',')) {
          out[k] = rec[k] === undefined ? null : rec[k];
          if (opts.formatted && k === '_ownerid_value' && rec[k]) out[`${k}${FORMATTED}`] = userName(rec[k]);
        }
        return out;
      }
      if ((m = /^([a-z_]+)\?\$select=([^&]+)&\$filter=(.*)$/.exec(p))) {
        const set = m[1];
        const rows = ID_COL[set] ? Object.values(d[set]) : d[set];
        if (!rows) throw new DataverseError(`Resource not found for the segment '${set}'.`);
        const keep = matcher(decodeURIComponent(m[3]));
        const cols = m[2].split(',');
        return {
          value: rows.filter(keep).map((r) => {
            const out = {};
            for (const c of cols) {
              out[c] = r[c] === undefined ? null : r[c];
              if (opts.formatted && c === '_ownerid_value' && r[c]) out[`${c}${FORMATTED}`] = userName(r[c]);
            }
            return out;
          }),
        };
      }
      throw new Error(`fake_component: unrouted GET ${p}`);
    },
    update(set, id, body, etag) {
      calls.push({ method: 'PATCH', path: `${set}(${id})`, body, etag });
      const rec = d[set] && d[set][id];
      if (!rec) throw notFound();
      if (etag !== tag(set, id)) throw new DataverseError('version mismatch', { code: '0x80060882' });
      if (set === 'workflows') {
        const activates = body.statecode === 1 || 'ownerid@odata.bind' in body;
        if (activates && dv.connectionOwnerOnly) {
          throw new DataverseError('Flow client error returned with status code "Forbidden" and details "{"error":{"code":"ConnectionAuthorizationFailed","message":"The caller object id is \'x\'. Connection \'shared-commondataser-1\' to \'shared_commondataserviceforapps\' cannot be used to activate this flow, either because this is not a valid connection or because it is not a connection you have access permission for. Either replace the connection with a valid connection you can access or have the connection owner activate the flow, so the connection is shared with you in the context of this flow."}}"', { status: 403, code: '0x80060467' });
        }
        if (body.clientdata && hasConcurrency(rec.clientdata) && !hasConcurrency(body.clientdata)) {
          throw new DataverseError("The 'runtimeConfiguration.concurrency' property cannot be removed once specified.", { code: '0x80060467' });
        }
      }
      for (const [k, v] of Object.entries(body)) {
        if (k === 'ownerid@odata.bind') rec._ownerid_value = /\(([^)]+)\)/.exec(v)[1];
        else if (k !== dv.readBackDrops) rec[k] = v;
      }
      bump(set, id);
      if (d.drafts[set]) delete d.drafts[set][id]; // a PATCH replaces the unpublished layer: the draft is gone
      if (set === 'workflows') register(dv, id);
      return {};
    },
    create(set, body, opts = {}) {
      calls.push({ method: 'POST', path: set, body, solution: opts.solution || null });
      const n = Object.keys(d[set]).length + 1;
      const id = `cccccccc-cccc-cccc-cccc-${String(n).padStart(12, '0')}`;
      d[set][id] = { [ID_COL[set]]: id, ismanaged: false, statecode: 0, statuscode: 1, _ownerid_value: userId, solution: opts.solution || null, ...body };
      return { [ID_COL[set]]: id };
    },
    remove(set, id, etag) {
      calls.push({ method: 'DELETE', path: `${set}(${id})`, etag });
      if (!d[set][id]) throw notFound();
      if (etag !== tag(set, id)) throw new DataverseError('version mismatch', { code: '0x80060882' });
      delete d[set][id];
      return {};
    },
    publish(components) {
      calls.push({ method: 'POST', path: 'PublishXml', body: components });
      if (dv.publishFails) throw new DataverseError('PublishXml failed: a dependency is missing');
      return {};
    },
  };
  return dv;
}

// The dev copy's Write Log, for `proven_in` (lib/proven.js): { planId: entry } of APPLIED entries, each row
// carrying its entry text the way lib/log.js writes it (a fenced json block).
const FENCE = '```';
function devDv(applied = {}) {
  return {
    get(p) {
      const m = /^sbrm_dataversewritelogs\?\$select=[^&]+&\$filter=(.*)$/.exec(p);
      if (!m) throw new Error(`fake devDv: unrouted GET ${p}`);
      const want = /sbrm_planid eq '([^']+)'/.exec(decodeURIComponent(m[1]))[1];
      const e = applied[want];
      return { value: e ? [{ sbrm_planid: want, sbrm_outcome: 'applied', sbrm_entry: `## heading\n\n${FENCE}json\n${JSON.stringify(e, null, 1)}\n${FENCE}\n` }] : [] };
    },
  };
}

// A dev-copy Write Log entry for a component change, shaped as lib/component.js entryFor writes it.
// before / after: the definitions the dev change left in the log (rows[0].before/after.definition).
function devEntry({ set = 'savedqueries', name = 'Active Donors', action = 'update', sections = ['columns'], mode = 'component', before = null, after = null } = {}) {
  return {
    mode, action, component: { set, name }, sections, outcome: 'applied',
    rows: [{ name, outcome: 'written', before: before ? { definition: before } : null, after: after ? { definition: after } : null }],
  };
}

const ENVS = {
  donorapp: { host: 'https://donor.invalid', name: 'Donor App', publisher: IDS.pub, dev: 'fedev' },
  fedev: { host: 'https://dev.invalid', name: 'Donor App Dev', publisher: IDS.pub },
};
const ACCESS = {
  people: {
    'dev@example.org': { envs: { donorapp: 'develop', fedev: 'develop' } },
    'admin@example.org': { envs: { donorapp: 'admin', fedev: 'admin' } },
    'oldadmin@example.org': { envs: { donorapp: 'schema' } },
    'writer@example.org': { envs: { donorapp: 'write' } },
  },
};

module.exports = { fakeComponentDv, devDv, devEntry, data, flowCd, REF, IDS, ENVS, ACCESS, FETCH, LAYOUT, FORM, SITEMAP };
