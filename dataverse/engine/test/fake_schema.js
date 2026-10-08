'use strict';
// A fake Dataverse for app development (kind "schema"): metadata to read AND write, shaped like the live
// answers read 10/7/26 in Donor App Dev (a by-key read of something missing is an error 0x80060888 /
// 0x80040217; a $filter listing of it is an empty list; a GET of one column carries "#Microsoft..." in
// @odata.type and no OptionSet unless expanded).
//
// Every call is recorded (dv.calls) so a test can assert the plan step only ever GETs, and every metadata
// write goes through write.js's REAL allow-list (checkMeta) and publish builder (publishXml), so a step the
// engine generates that the write connection would refuse fails here too.
//
// Knobs a test sets on the returned object:
//   provisionReads  n: a table created next answers "does not exist" to its next n by-name reads, and
//                   refuses columns until then (a live finding 10/6: "An unexpected error occurred.")
//   tableTimeout    true: the next table create lands but the call throws the CLI's 100 s timeout (10/7)
//   failOn          ({method, path, body}) -> message | null: that write throws
//   hideOnce        Set of "table.column": the next read of that column after it is created misses it
//   keyStatus       EntityKeyIndexStatus a new key reports (default 'Pending')
//   publishFails    true: PublishXml throws
//   formsUnreadable true: the forms/views reads fail (drafts cannot be checked)
//   labelsUnreadable true: the RetrieveEntity reads fail (unpublished labels cannot be checked)
//   data.labelDrafts { "table" | "table.column": label }: someone's unpublished label edits
//   afterGet        (path) -> void: runs after a GET has answered (something changing mid-plan)
//   getFails        (path) -> message | {message, code, status} | null: that GET throws (default: a 429 throttle)
//   timeoutOn       (call) -> 'lands' | 'lost' | null: that write times out client side, after landing or not
//   Every GET records { strong } (Consistency: Strong), so a test can see read-backs ask for it.

const { DataverseError } = require('../lib/cli');
const { checkMeta, publishXml } = require('../lib/write');

const PUB = 'b39485ad-5b1d-ef11-840a-6045bd07878a';
const MS_PUB = 'd21aab71-79e7-11dd-8874-00188b01e34f';
const OTHER_PUB = '20908c0d-3da3-ed11-aad1-000d3a354049';
const USERS = {
  'dgross@example.org': '99999999-9999-9999-9999-999999999999',
  'dev2@example.org': '88888888-8888-8888-8888-888888888888',
  'writer@example.org': '77777777-7777-7777-7777-777777777777',
  'reader@example.org': '66666666-6666-6666-6666-666666666666',
};

const L = (s) => ({ LocalizedLabels: [{ Label: s, LanguageCode: 1033 }], UserLocalizedLabel: { Label: s, LanguageCode: 1033 } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

let seq = 0;
const newId = () => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

const TYPE_OF = {
  StringAttributeMetadata: 'String', MemoAttributeMetadata: 'Memo', IntegerAttributeMetadata: 'Integer', DecimalAttributeMetadata: 'Decimal',
  MoneyAttributeMetadata: 'Money', BooleanAttributeMetadata: 'Boolean', DateTimeAttributeMetadata: 'DateTime', PicklistAttributeMetadata: 'Picklist',
  MultiSelectPicklistAttributeMetadata: 'Virtual', LookupAttributeMetadata: 'Lookup', UniqueIdentifierAttributeMetadata: 'Uniqueidentifier',
};

// Labels as Dataverse returns them (UserLocalizedLabel filled), from whatever a body sent.
function normLabels(v) {
  if (Array.isArray(v)) return v.map(normLabels);
  if (v && typeof v === 'object') {
    if (Array.isArray(v.LocalizedLabels)) return L((v.LocalizedLabels[0] || {}).Label);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normLabels(x)]));
  }
  return v;
}

function entity(logical, display, plural, { managed = false, primaryName = 'sbrm_name', set = `${logical}s`, audit = true } = {}) {
  return {
    MetadataId: newId(), LogicalName: logical, SchemaName: logical, EntitySetName: set, IsManaged: managed,
    DisplayName: L(display), DisplayCollectionName: L(plural), Description: L(`${display} table.`),
    IsAuditEnabled: { Value: audit, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyauditsettings' },
    ChangeTrackingEnabled: true, IsQuickCreateEnabled: false, OwnershipType: 'UserOwned',
    PrimaryIdAttribute: `${logical}id`, PrimaryNameAttribute: primaryName,
  };
}

function attr(logical, odataType, display, extra = {}) {
  const t = TYPE_OF[odataType];
  return {
    '@odata.type': `#Microsoft.Dynamics.CRM.${odataType}`, MetadataId: newId(), LogicalName: logical, SchemaName: logical,
    AttributeType: t, AttributeTypeName: { Value: t === 'Virtual' ? 'MultiSelectPicklistType' : `${t}Type` },
    DisplayName: L(display), Description: L(''), IsManaged: false, IsPrimaryId: false, IsPrimaryName: false, AttributeOf: null,
    HasChanged: null, ModifiedOn: '2026-10-01T00:00:00Z',
    RequiredLevel: { Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
    ...extra,
  };
}

const OPT = (Value, s) => ({ Value, Label: L(s) });

// The donor app in miniature: Microsoft's managed tables, one of ours in our ad-hoc solution, one of ours
// built outside any SBRM solution, and one of the toolkit's own tables.
function world() {
  const SOL = newId();
  const widget = entity('sbrm_widget', 'Widget', 'Widgets');
  const lonely = entity('sbrm_lonely', 'Lonely', 'Lonelies');
  const log = entity('sbrm_dataversewritelog', 'Dataverse Write Log', 'Dataverse Write Logs');
  const w = {
    solutions: {
      SBRMAdHoc: { solutionid: SOL, uniquename: 'SBRMAdHoc', friendlyname: 'SBRM Ad-Hoc Changes', ismanaged: false, _publisherid_value: PUB },
      msdyn_Nonprofit: { solutionid: newId(), uniquename: 'msdyn_Nonprofit', friendlyname: 'Nonprofit Accelerator', ismanaged: true, _publisherid_value: MS_PUB },
      VendorStuff: { solutionid: newId(), uniquename: 'VendorStuff', friendlyname: 'Vendor Stuff', ismanaged: false, _publisherid_value: OTHER_PUB },
    },
    components: [{ solutionid: SOL, objectid: widget.MetadataId }, { solutionid: SOL, objectid: log.MetadataId }],
    entities: {
      contact: entity('contact', 'Contact', 'Contacts', { managed: true, primaryName: 'fullname' }),
      msnfp_transaction: entity('msnfp_transaction', 'Transaction', 'Transactions', { managed: true, primaryName: 'msnfp_name' }),
      sbrm_widget: widget, sbrm_lonely: lonely, sbrm_dataversewritelog: log,
    },
    attrs: {
      contact: {
        contactid: attr('contactid', 'UniqueIdentifierAttributeMetadata', 'Contact', { IsManaged: true, IsPrimaryId: true }),
        fullname: attr('fullname', 'StringAttributeMetadata', 'Full Name', { IsManaged: true, IsPrimaryName: true, MaxLength: 160 }),
        donotemail: attr('donotemail', 'BooleanAttributeMetadata', 'Do not allow Emails', { IsManaged: true }),
        sbrm_altphone: attr('sbrm_altphone', 'StringAttributeMetadata', 'Alt Phone', { MaxLength: 100, FormatName: { Value: 'Text' } }),
        // Ours, on a Microsoft table, pointing at Widget: deleting Widget takes it with it.
        sbrm_favoritewidgetid: attr('sbrm_favoritewidgetid', 'LookupAttributeMetadata', 'Favorite Widget'),
      },
      msnfp_transaction: {
        msnfp_transactionid: attr('msnfp_transactionid', 'UniqueIdentifierAttributeMetadata', 'Transaction', { IsManaged: true, IsPrimaryId: true }),
        msnfp_name: attr('msnfp_name', 'StringAttributeMetadata', 'Name', { IsManaged: true, IsPrimaryName: true, MaxLength: 100 }),
        msnfp_type: attr('msnfp_type', 'PicklistAttributeMetadata', 'Type', { IsManaged: true }),
      },
      sbrm_widget: {
        sbrm_widgetid: attr('sbrm_widgetid', 'UniqueIdentifierAttributeMetadata', 'Widget', { IsPrimaryId: true }),
        sbrm_name: attr('sbrm_name', 'StringAttributeMetadata', 'Name', { IsPrimaryName: true, MaxLength: 100, RequiredLevel: { Value: 'ApplicationRequired', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' } }),
        sbrm_notes: attr('sbrm_notes', 'MemoAttributeMetadata', 'Notes', { MaxLength: 2000, Format: 'TextArea' }),
        sbrm_code: attr('sbrm_code', 'StringAttributeMetadata', 'Code', { MaxLength: 50, FormatName: { Value: 'Text' } }),
        sbrm_size: attr('sbrm_size', 'PicklistAttributeMetadata', 'Size'),
        sbrm_region: attr('sbrm_region', 'PicklistAttributeMetadata', 'Region'),
        sbrm_contactid: attr('sbrm_contactid', 'LookupAttributeMetadata', 'Contact'),
      },
      sbrm_lonely: {
        sbrm_lonelyid: attr('sbrm_lonelyid', 'UniqueIdentifierAttributeMetadata', 'Lonely', { IsPrimaryId: true }),
        sbrm_name: attr('sbrm_name', 'StringAttributeMetadata', 'Name', { IsPrimaryName: true, MaxLength: 100 }),
      },
      sbrm_dataversewritelog: {
        sbrm_dataversewritelogid: attr('sbrm_dataversewritelogid', 'UniqueIdentifierAttributeMetadata', 'Log', { IsPrimaryId: true }),
        sbrm_name: attr('sbrm_name', 'StringAttributeMetadata', 'Name', { IsPrimaryName: true, MaxLength: 200 }),
        sbrm_reason: attr('sbrm_reason', 'StringAttributeMetadata', 'Reason Given', { MaxLength: 500 }),
      },
    },
    // Local choices by "table.column"; a column on a global choice is in attrGlobal instead.
    optionSets: {
      'sbrm_widget.sbrm_size': { Name: 'sbrm_widget_sbrm_size', IsGlobal: false, IsManaged: false, MetadataId: newId(), Options: [OPT(338300000, 'Small'), OPT(338300001, 'Large')] },
      'msnfp_transaction.msnfp_type': { Name: 'msnfp_transaction_msnfp_type', IsGlobal: false, IsManaged: true, MetadataId: newId(), Options: [OPT(844060000, 'Donation')] },
    },
    globals: {
      sbrm_regions: { Name: 'sbrm_regions', MetadataId: newId(), IsManaged: false, IsGlobal: true, DisplayName: L('Regions'), Options: [OPT(338300000, 'North'), OPT(338300001, 'South')] },
      msnfp_paymenttypes: { Name: 'msnfp_paymenttypes', MetadataId: newId(), IsManaged: true, IsGlobal: true, DisplayName: L('Payment Types'), Options: [OPT(844060000, 'Cash')] },
    },
    attrGlobal: { 'sbrm_widget.sbrm_region': 'sbrm_regions' },
    relationships: {
      sbrm_sbrm_widget_contact_FavoriteWidgetId: { '@odata.type': '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata', SchemaName: 'sbrm_sbrm_widget_contact_FavoriteWidgetId', MetadataId: newId(), IsManaged: false, IsCustomRelationship: true, RelationshipType: 'OneToManyRelationship', ReferencedEntity: 'sbrm_widget', ReferencingEntity: 'contact', ReferencingAttribute: 'sbrm_favoritewidgetid' },
      contact_customer_accounts: { '@odata.type': '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata', SchemaName: 'contact_customer_accounts', MetadataId: newId(), IsManaged: true, IsCustomRelationship: false, RelationshipType: 'OneToManyRelationship', ReferencedEntity: 'account', ReferencingEntity: 'contact', ReferencingAttribute: 'parentcustomerid' },
      sbrm_contact_sbrm_widget_ContactId: { '@odata.type': '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata', SchemaName: 'sbrm_contact_sbrm_widget_ContactId', MetadataId: newId(), IsManaged: false, IsCustomRelationship: true, RelationshipType: 'OneToManyRelationship', ReferencedEntity: 'contact', ReferencingEntity: 'sbrm_widget', ReferencingAttribute: 'sbrm_contactid' },
    },
    keys: { sbrm_widget: [], sbrm_dataversewritelog: [] },
    // Forms and views: `xml` is the published copy, `draft` (when set) an unpublished edit someone left.
    forms: [
      { formid: 'f0000000-0000-0000-0000-000000000001', name: 'Widget main', objecttypecode: 'sbrm_widget', xml: '<form>main</form>' },
      { formid: 'f0000000-0000-0000-0000-000000000002', name: 'Contact main', objecttypecode: 'contact', xml: '<form>contact</form>' },
    ],
    views: [
      { savedqueryid: 'v0000000-0000-0000-0000-000000000001', name: 'Active Widgets', returnedtypecode: 'sbrm_widget', fetchxml: '<fetch/>', layoutxml: '<grid/>' },
    ],
    publishers: {
      [PUB]: { customizationprefix: 'sbrm', customizationoptionvalueprefix: 10000 },
      [OTHER_PUB]: { customizationprefix: 'sbrm', customizationoptionvalueprefix: 33830 },
      '9811ffde-bb43-4f05-be7c-2eb124dedf0c': { customizationprefix: 'sbrm', customizationoptionvalueprefix: 33830 },
    },
    records: {
      sbrm_widgets: [
        { sbrm_widgetid: 'w1', sbrm_name: 'One', sbrm_notes: 'has notes', sbrm_code: 'A', sbrm_size: 338300000, _sbrm_contactid_value: 'c1' },
        { sbrm_widgetid: 'w2', sbrm_name: 'Two', sbrm_notes: null, sbrm_code: 'B', sbrm_size: 338300001, _sbrm_contactid_value: null },
        { sbrm_widgetid: 'w3', sbrm_name: 'Three', sbrm_notes: null, sbrm_code: 'C', sbrm_size: 338300001, _sbrm_contactid_value: null },
      ],
      contacts: [{ contactid: 'c1', fullname: 'Jane Example', sbrm_altphone: null, _sbrm_favoritewidgetid_value: 'w1' }],
      sbrm_lonelies: [],
      sbrm_dataversewritelogs: [],
    },
  };
  return w;
}

// host: the environment this fake answers as (a revert checks its log entry belongs here).
function fakeSchemaDv({ email = 'dgross@example.org', data = world(), host = 'https://fedev.invalid' } = {}) {
  const calls = [];
  const notFound = (what, code = '0x80060888') => new DataverseError(`${what} does not exist.`, { code });
  const W = data;
  const dv = {
    cliVersion: 'fake', host, calls, data: W,
    provisionReads: 0, tableTimeout: false, failOn: null, hideOnce: new Set(), keyStatus: 'Pending', publishFails: false,
    notReady: {}, // table -> by-name reads left before it answers
  };

  const ready = (t) => {
    if (!W.entities[t]) return false;
    if ((dv.notReady[t] || 0) > 0) { dv.notReady[t] -= 1; return false; }
    return true;
  };
  const pick = (o, sel) => (sel ? Object.fromEntries(sel.split(',').filter((k) => k in o).map((k) => [k, clone(o[k])])) : clone(o));
  const hidden = (t, c) => {
    const k = `${t}.${c}`;
    if (dv.hideOnce.has(k) && dv.hideOnce.has(`${k}:armed`)) { dv.hideOnce.delete(k); dv.hideOnce.delete(`${k}:armed`); return true; }
    return false;
  };
  const optionSetOf = (t, c) => (W.attrGlobal[`${t}.${c}`] ? W.globals[W.attrGlobal[`${t}.${c}`]] : W.optionSets[`${t}.${c}`]);
  const filterEq = (f, field) => {
    const m = new RegExp(`${field} eq '([^']*)'`).exec(f);
    return m ? m[1] : null;
  };

  const route = (p) => {
    calls.push({ method: 'GET', path: p });
    const gf = dv.getFails && dv.getFails(p);
    if (gf) throw (typeof gf === 'object' ? new DataverseError(gf.message, { code: gf.code, status: gf.status }) : new DataverseError(gf, { code: '0x80072322', status: 429 }));
    let m;
    if (p === 'WhoAmI') return { UserId: USERS[email] || '11111111-1111-1111-1111-111111111111' };
    if (/^systemusers\(/.test(p)) return { fullname: email.split('@')[0], internalemailaddress: email, domainname: email };
    if ((m = /^solutions\?\$select=[^&]+&\$filter=(.*)$/.exec(p))) {
      const name = filterEq(decodeURIComponent(m[1]), 'uniquename');
      return { value: W.solutions[name] ? [clone(W.solutions[name])] : [] };
    }
    if ((m = /^publishers\(([^)]+)\)\?\$select=/.exec(p))) {
      const x = W.publishers[m[1]];
      if (!x) throw notFound(`publisher ${m[1]}`, '0x80040217');
      return { publisherid: m[1], ...clone(x) };
    }
    // Every solution a component is in (Default is implied for everything unmanaged, so it is not stored).
    if ((m = /^solutioncomponents\?\$select=_solutionid_value&\$filter=(.*)&\$expand=solutionid\(\$select=uniquename,ismanaged\)$/.exec(p))) {
      const oid = (/objectid eq (\S+)/.exec(decodeURIComponent(m[1])) || [])[1];
      const sols = Object.values(W.solutions);
      return { value: [{ solutionid: { uniquename: 'Default', ismanaged: false } }, ...W.components.filter((c) => c.objectid === oid).map((c) => ({ solutionid: clone(sols.find((x) => x.solutionid === c.solutionid)) }))] };
    }
    if ((m = /^EntityDefinitions\(([0-9a-f-]{36})\)\?\$select=LogicalName$/.exec(p))) {
      const e = Object.values(W.entities).find((x) => x.MetadataId === m[1]);
      if (!e) throw notFound(`EntityMetadata With Id = ${m[1]}`);
      return { LogicalName: e.LogicalName, MetadataId: e.MetadataId };
    }
    // Grouped counts (the duplicate check before an alternate key; groupby read live 10/7).
    if ((m = /^(\w+)\?\$apply=groupby\(\(([^)]+)\),aggregate\(\$count%20as%20n\)\)$/.exec(p))) {
      if (dv.aggregateFails) throw new DataverseError('AggregateQueryRecordLimit exceeded');
      const rows = W.records[m[1]];
      if (!rows) throw new DataverseError(`Resource not found for the segment '${m[1]}'.`);
      const cols = m[2].split(',');
      const groups = new Map();
      for (const r of rows) {
        const k = JSON.stringify(cols.map((c) => (r[c] === undefined ? null : r[c])));
        groups.set(k, (groups.get(k) || 0) + 1);
      }
      return { value: [...groups].map(([k, n]) => ({ ...Object.fromEntries(cols.map((c, i) => [c, JSON.parse(k)[i]])), n })) };
    }
    if ((m = /^solutioncomponents\?\$select=objectid&\$filter=(.*)$/.exec(p))) {
      const f = decodeURIComponent(m[1]);
      const [, sid, oid] = /_solutionid_value eq (\S+) and objectid eq (\S+)/.exec(f);
      return { value: W.components.filter((c) => c.solutionid === sid && c.objectid === oid).map((c) => ({ objectid: c.objectid })) };
    }
    if ((m = /^EntityDefinitions\?\$select=([^&]+)&\$filter=(.*)$/.exec(p))) {
      const t = filterEq(decodeURIComponent(m[2]), 'LogicalName');
      return { value: W.entities[t] ? [pick(W.entities[t], m[1])] : [] };
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\?\$select=([^&]+)&\$filter=(.*)$/.exec(p))) {
      if (!W.entities[m[1]]) throw notFound(`EntityMetadata With Id = LogicalName='${m[1]}'`);
      const c = filterEq(decodeURIComponent(m[3]), 'LogicalName');
      const a = W.attrs[m[1]][c];
      if (!a || hidden(m[1], c)) return { value: [] };
      return { value: [{ '@odata.type': a['@odata.type'], ...pick(a, m[2]) }] };
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\(LogicalName='([^']+)'\)\/Microsoft\.Dynamics\.CRM\.(\w+)\?\$select=[^&]+&\$expand=OptionSet,GlobalOptionSet$/.exec(p))) {
      const a = (W.attrs[m[1]] || {})[m[2]];
      if (!a) throw notFound(`Attribute ${m[2]}`, '0x80040217');
      const os = optionSetOf(m[1], m[2]);
      const isGlobal = Boolean(W.attrGlobal[`${m[1]}.${m[2]}`]);
      return { LogicalName: a.LogicalName, IsManaged: a.IsManaged, OptionSet: clone(os), GlobalOptionSet: isGlobal ? clone(os) : null };
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\(LogicalName='([^']+)'\)$/.exec(p))) {
      if (!W.entities[m[1]]) throw notFound(`EntityMetadata With Id = LogicalName='${m[1]}'`);
      const a = W.attrs[m[1]][m[2]];
      if (!a || hidden(m[1], m[2])) throw notFound(`Attribute ${m[2]}`, '0x80040217');
      return { '@odata.context': 'fake#attribute', ...clone(a) };
    }
    // A table's whole definition (what a table delete logs), and its choice columns' option sets.
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\?\$expand=Attributes,Keys,OneToManyRelationships,ManyToOneRelationships,ManyToManyRelationships$/.exec(p))) {
      const t = m[1];
      if (!ready(t)) throw notFound(`EntityMetadata With Id = LogicalName='${t}'`);
      const rels = Object.values(W.relationships);
      return {
        '@odata.context': 'fake#entity', ...clone(W.entities[t]),
        Attributes: clone(Object.values(W.attrs[t] || {})), Keys: clone(W.keys[t] || []),
        OneToManyRelationships: clone(rels.filter((r) => r.ReferencedEntity === t)),
        ManyToOneRelationships: clone(rels.filter((r) => r.ReferencingEntity === t)),
        ManyToManyRelationships: clone(rels.filter((r) => r.Entity1LogicalName === t || r.Entity2LogicalName === t)),
      };
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\/Microsoft\.Dynamics\.CRM\.(PicklistAttributeMetadata|MultiSelectPicklistAttributeMetadata)\?\$select=LogicalName&\$expand=OptionSet$/.exec(p))) {
      if (!W.entities[m[1]]) throw notFound(`EntityMetadata With Id = LogicalName='${m[1]}'`);
      const type = m[2] === 'PicklistAttributeMetadata' ? 'Picklist' : 'Virtual';
      return { value: Object.values(W.attrs[m[1]]).filter((a) => a.AttributeType === type).map((a) => ({ LogicalName: a.LogicalName, OptionSet: clone(optionSetOf(m[1], a.LogicalName) || null) })) };
    }
    // A table as published (false) or as it would be after a publish (true): `labelDrafts` holds someone's
    // unpublished label edits, by "table" or "table.column" (RetrieveEntity, read live 10/7).
    if ((m = /^RetrieveEntity\(EntityFilters=Microsoft\.Dynamics\.CRM\.EntityFilters'Attributes',LogicalName='([^']+)',MetadataId=0{8}-0{4}-0{4}-0{4}-0{12},RetrieveAsIfPublished=(true|false)\)$/.exec(p))) {
      if (dv.labelsUnreadable) throw new DataverseError('RetrieveEntity failed');
      const t = m[1];
      if (!W.entities[t]) throw notFound(`EntityMetadata With Id = LogicalName='${t}'`);
      const next = m[2] === 'true';
      const lbl = (key, base) => (next && W.labelDrafts && W.labelDrafts[key] !== undefined ? L(W.labelDrafts[key]) : base);
      return {
        EntityMetadata: {
          ...clone(W.entities[t]), DisplayName: lbl(t, clone(W.entities[t].DisplayName)),
          Attributes: Object.values(W.attrs[t] || {}).map((a) => ({ ...clone(a), DisplayName: lbl(`${t}.${a.LogicalName}`, clone(a.DisplayName)) })),
        },
      };
    }
    // Forms and views, published and in their draft state (RetrieveUnpublishedMultiple, read live 10/7).
    if ((m = /^(systemforms|savedqueries)(\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\))?\?\$filter=([^&]+)&\$select=(.*)$/.exec(p))) {
      if (dv.formsUnreadable) throw new DataverseError('Principal user is missing prvReadSystemForm privilege');
      const forms = m[1] === 'systemforms';
      const f = decodeURIComponent(m[3]);
      const t = filterEq(f, forms ? 'objecttypecode' : 'returnedtypecode');
      const list = (forms ? W.forms : W.views).filter((x) => (forms ? x.objecttypecode : x.returnedtypecode) === t);
      const draft = Boolean(m[2]);
      return {
        value: list.filter((x) => draft || !x.unpublishedOnly).map((x) => (forms
          ? { formid: x.formid, name: x.name, formxml: draft && x.draft ? x.draft : x.xml }
          : { savedqueryid: x.savedqueryid, name: x.name, fetchxml: draft && x.draft ? x.draft : x.fetchxml, layoutxml: x.layoutxml })),
      };
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/OneToManyRelationships\?\$select=/.exec(p))) {
      if (!W.entities[m[1]]) throw notFound(`EntityMetadata With Id = LogicalName='${m[1]}'`);
      return { value: clone(Object.values(W.relationships).filter((r) => r.ReferencedEntity === m[1])) };
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Keys\?\$select=/.exec(p))) {
      if (!W.entities[m[1]]) throw notFound(`EntityMetadata With Id = LogicalName='${m[1]}'`);
      return { value: clone(W.keys[m[1]] || []) };
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)(\?\$select=.*)?$/.exec(p))) {
      if (!ready(m[1])) throw notFound(`EntityMetadata With Id = LogicalName='${m[1]}'`);
      return { '@odata.context': 'fake#entity', ...clone(W.entities[m[1]]) };
    }
    if ((m = /^RelationshipDefinitions\?\$select=[^&]+&\$filter=(.*)$/.exec(p))) {
      const s = filterEq(decodeURIComponent(m[1]), 'SchemaName');
      const r = W.relationships[s];
      return { value: r ? [{ '@odata.type': r['@odata.type'], SchemaName: r.SchemaName, MetadataId: r.MetadataId, IsManaged: r.IsManaged, RelationshipType: r.RelationshipType }] : [] };
    }
    if ((m = /^RelationshipDefinitions\(SchemaName='([^']+)'\)$/.exec(p))) {
      if (!W.relationships[m[1]]) throw notFound(`Relationship ${m[1]}`, '0x80040217');
      return clone(W.relationships[m[1]]);
    }
    if ((m = /^GlobalOptionSetDefinitions\(Name='([^']+)'\)$/.exec(p))) {
      if (!W.globals[m[1]]) throw new DataverseError(`Could not find an optionset with name ${m[1]} and id 00000000-0000-0000-0000-000000000000.`, { code: '0x80040217' });
      return clone(W.globals[m[1]]);
    }
    if ((m = /^sbrm_dataversewritelogs\?\$select=[^&]+&\$filter=([^&]*)(&.*)?$/.exec(p))) {
      const f = decodeURIComponent(m[1]);
      const by = (/_createdby_value eq (\S+)/.exec(f) || [])[1];
      if (by) return { value: W.records.sbrm_dataversewritelogs.filter((r) => r._createdby_value === by && (!/sbrm_mode eq 'schema'/.test(f) || r.sbrm_mode === 'schema')) };
      const id = filterEq(f, 'sbrm_planid');
      return { value: W.records.sbrm_dataversewritelogs.filter((r) => r.sbrm_planid === id) };
    }
    if ((m = /^(\w+)\?\$select=\w+&\$count=true&\$top=1(?:&\$filter=(.*))?$/.exec(p))) {
      let rows = W.records[m[1]];
      if (!rows) throw new DataverseError(`Resource not found for the segment '${m[1]}'.`);
      if (m[2]) {
        const f = decodeURIComponent(m[2]);
        const x = /^(\w+) (eq|ne) (null|\d+)$/.exec(f);
        if (!x) throw new Error(`fake: unsupported count filter ${f}`);
        const val = x[3] === 'null' ? null : Number(x[3]);
        rows = rows.filter((r) => {
          const v = r[x[1]] === undefined ? null : r[x[1]];
          return x[2] === 'eq' ? v === val : v !== val;
        });
      }
      return { '@odata.count': rows.length, value: rows.slice(0, 1) };
    }
    throw new Error(`fake schema dv: unrouted GET ${p}`);
  };

  // afterGet(path): runs AFTER a read has answered (a change landing between two reads of the plan).
  dv.get = (p, o = {}) => {
    const at = calls.length;
    try {
      const r = route(p);
      if (dv.afterGet) dv.afterGet(p);
      return r;
    } finally {
      if (calls[at]) calls[at].strong = Boolean(o.strong);
    }
  };

  dv.getMany = (paths) => Promise.resolve(paths.map((p) => {
    try { return { ok: true, value: dv.get(p) }; } catch (error) { return { ok: false, error }; }
  }));

  const solutionFrom = (headers) => {
    const h = (headers || []).find((x) => /^MSCRM\.SolutionUniqueName:/i.test(x));
    return h ? h.split(':')[1].trim() : null;
  };
  const addComponent = (headers, objectid) => {
    const name = solutionFrom(headers);
    if (name && W.solutions[name]) W.components.push({ solutionid: W.solutions[name].solutionid, objectid });
  };
  const optionTarget = (b) => {
    if (b.OptionSetName) {
      const g = W.globals[b.OptionSetName];
      if (!g) throw new DataverseError(`Could not find optionset ${b.OptionSetName}`, { code: '0x80040217' });
      return g;
    }
    const os = optionSetOf(b.EntityLogicalName, b.AttributeLogicalName);
    if (!os) throw new DataverseError(`no option set on ${b.EntityLogicalName}.${b.AttributeLogicalName}`);
    return os;
  };
  const newAttr = (t, body) => {
    const odata = body['@odata.type'].replace(/^#?Microsoft\.Dynamics\.CRM\./, '');
    const { OptionSet, 'GlobalOptionSet@odata.bind': gbind, ...rest } = normLabels(clone(body));
    const c = body.SchemaName.toLowerCase();
    const a = { ...attr(c, odata, ''), ...rest, '@odata.type': `#Microsoft.Dynamics.CRM.${odata}`, LogicalName: c, AttributeType: TYPE_OF[odata] };
    a.AttributeTypeName = { Value: a.AttributeType === 'Virtual' ? 'MultiSelectPicklistType' : `${a.AttributeType}Type` };
    if (OptionSet && (odata === 'PicklistAttributeMetadata' || odata === 'MultiSelectPicklistAttributeMetadata')) {
      W.optionSets[`${t}.${c}`] = { Name: `${t}_${c}`, IsGlobal: false, IsManaged: false, MetadataId: newId(), Options: OptionSet.Options.map((o) => ({ Value: o.Value, Label: o.Label })) };
    }
    if (gbind) {
      const gid = /\(([^)]+)\)/.exec(gbind)[1];
      const g = Object.values(W.globals).find((x) => x.MetadataId === gid);
      if (!g) throw new DataverseError('global option set not found');
      W.attrGlobal[`${t}.${c}`] = g.Name;
    }
    W.attrs[t][c] = a;
    if (dv.hideOnce.has(`${t}.${c}`)) dv.hideOnce.add(`${t}.${c}:armed`);
    return a;
  };

  const TIMEOUT = 'System.Threading.Tasks.TaskCanceledException: The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.';
  dv.metadata = (method, apiPath, body, headers = []) => {
    const t = dv.timeoutOn && dv.timeoutOn({ method: String(method).toUpperCase(), path: apiPath, body });
    if (t === 'lost') { calls.push({ method: String(method).toUpperCase(), path: apiPath, body: clone(body), headers: [...headers], lost: true }); throw new DataverseError(TIMEOUT); }
    const r = writeMeta(method, apiPath, body, headers);
    if (t === 'lands') throw new DataverseError(TIMEOUT);
    return r;
  };
  const writeMeta = (method, apiPath, body, headers = []) => {
    checkMeta(method, apiPath, headers); // the real allow-list: a step it would refuse fails the test
    const call = { method: String(method).toUpperCase(), path: apiPath, body: clone(body), headers: [...headers] };
    calls.push(call);
    if (dv.failOn) {
      const msg = dv.failOn(call);
      if (msg) throw new DataverseError(msg);
    }
    let m;
    const M = call.method;
    if (M === 'POST' && apiPath === 'solutions') {
      const pub = /\(([^)]+)\)/.exec(body['publisherid@odata.bind'])[1];
      W.solutions[body.uniquename] = { solutionid: newId(), uniquename: body.uniquename, friendlyname: body.friendlyname, ismanaged: false, _publisherid_value: pub };
      return {};
    }
    if (M === 'POST' && apiPath === 'EntityDefinitions') {
      const t = body.SchemaName.toLowerCase();
      const e = entity(t, '', '');
      const b = normLabels(clone(body));
      delete b['@odata.type'];
      const { Attributes: atts, ...props } = b;
      Object.assign(e, props, { LogicalName: t, PrimaryNameAttribute: atts[0].SchemaName.toLowerCase() });
      e.CreatedOn = '2026-10-07T20:00:00Z';
      W.entities[t] = e;
      W.attrs[t] = { [`${t}id`]: attr(`${t}id`, 'UniqueIdentifierAttributeMetadata', e.DisplayName.UserLocalizedLabel.Label, { IsPrimaryId: true }) };
      W.attrs[t][atts[0].SchemaName.toLowerCase()] = { ...newAttrShape(atts[0]), IsPrimaryName: true };
      W.keys[t] = [];
      W.records[e.EntitySetName] = [];
      addComponent(headers, e.MetadataId);
      if (dv.provisionReads) dv.notReady[t] = dv.provisionReads;
      if (dv.tableTimeout) {
        dv.tableTimeout = false;
        throw new DataverseError('POST EntityDefinitions failed (exit 1): System.Threading.Tasks.TaskCanceledException: The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.');
      }
      return {};
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)$/.exec(apiPath))) {
      const t = m[1];
      if (!W.entities[t]) throw notFound(`EntityMetadata With Id = LogicalName='${t}'`);
      if (M === 'PUT') {
        const b = normLabels(clone(body));
        delete b['@odata.type'];
        W.entities[t] = { ...b, MetadataId: W.entities[t].MetadataId };
        return {};
      }
      if (M === 'DELETE') {
        const set = W.entities[t].EntitySetName;
        // As Dataverse does: every relationship to or from it goes, and the lookups on other tables with it.
        for (const [k, r] of Object.entries(W.relationships)) {
          if (r.ReferencedEntity === t && r.ReferencingEntity !== t && W.attrs[r.ReferencingEntity]) delete W.attrs[r.ReferencingEntity][r.ReferencingAttribute];
          if ([r.ReferencedEntity, r.ReferencingEntity, r.Entity1LogicalName, r.Entity2LogicalName].includes(t)) delete W.relationships[k];
        }
        delete W.entities[t]; delete W.attrs[t]; delete W.keys[t]; delete W.records[set];
        return {};
      }
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes$/.exec(apiPath)) && M === 'POST') {
      const t = m[1];
      if (!W.entities[t]) throw notFound(`EntityMetadata With Id = LogicalName='${t}'`);
      if ((dv.notReady[t] || 0) > 0) throw new DataverseError('An unexpected error occurred.');
      const a = newAttr(t, body);
      addComponent(headers, a.MetadataId);
      return {};
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Attributes\(LogicalName='([^']+)'\)$/.exec(apiPath))) {
      const [, t, c] = m;
      if (!W.attrs[t] || !W.attrs[t][c]) throw notFound(`Attribute ${c}`, '0x80040217');
      if (M === 'PUT') {
        const b = normLabels(clone(body));
        b['@odata.type'] = `#${String(b['@odata.type']).replace(/^#/, '')}`;
        W.attrs[t][c] = { ...b, MetadataId: W.attrs[t][c].MetadataId, ModifiedOn: '2026-10-07T12:00:00Z' };
        return {};
      }
      if (M === 'DELETE') {
        delete W.attrs[t][c];
        for (const r of W.records[W.entities[t].EntitySetName] || []) delete r[c];
        return {};
      }
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Keys$/.exec(apiPath)) && M === 'POST') {
      W.keys[m[1]] = W.keys[m[1]] || [];
      W.keys[m[1]].push({ LogicalName: body.SchemaName.toLowerCase(), SchemaName: body.SchemaName, MetadataId: newId(), IsManaged: false, KeyAttributes: [...body.KeyAttributes], EntityKeyIndexStatus: dv.keyStatus, DisplayName: normLabels(body.DisplayName) });
      return {};
    }
    if ((m = /^EntityDefinitions\(LogicalName='([^']+)'\)\/Keys\(LogicalName='([^']+)'\)$/.exec(apiPath)) && M === 'DELETE') {
      W.keys[m[1]] = (W.keys[m[1]] || []).filter((k) => k.LogicalName !== m[2]);
      return {};
    }
    if (apiPath === 'RelationshipDefinitions' && M === 'POST') {
      const b = normLabels(clone(body));
      const odata = `#${b['@odata.type']}`;
      if (/OneToMany/.test(odata)) {
        const t = b.ReferencingEntity;
        if ((dv.notReady[t] || 0) > 0) throw new DataverseError('An unexpected error occurred.');
        const look = b.Lookup.SchemaName.toLowerCase();
        W.relationships[b.SchemaName] = { '@odata.type': odata, SchemaName: b.SchemaName, MetadataId: newId(), IsManaged: false, RelationshipType: 'OneToManyRelationship', ReferencedEntity: b.ReferencedEntity, ReferencingEntity: t, ReferencingAttribute: look, CascadeConfiguration: b.CascadeConfiguration };
        W.attrs[t][look] = { ...attr(look, 'LookupAttributeMetadata', b.Lookup.DisplayName.UserLocalizedLabel.Label), RequiredLevel: b.Lookup.RequiredLevel };
      } else {
        W.relationships[b.SchemaName] = { '@odata.type': odata, SchemaName: b.SchemaName, MetadataId: newId(), IsManaged: false, RelationshipType: 'ManyToManyRelationship', Entity1LogicalName: b.Entity1LogicalName, Entity2LogicalName: b.Entity2LogicalName, IntersectEntityName: b.IntersectEntityName };
      }
      addComponent(headers, W.relationships[b.SchemaName].MetadataId);
      return {};
    }
    if ((m = /^RelationshipDefinitions\(SchemaName='([^']+)'\)$/.exec(apiPath)) && M === 'DELETE') {
      const r = W.relationships[m[1]];
      if (!r) throw notFound(`Relationship ${m[1]}`, '0x80040217');
      if (r.ReferencingAttribute && W.attrs[r.ReferencingEntity]) delete W.attrs[r.ReferencingEntity][r.ReferencingAttribute];
      delete W.relationships[m[1]];
      return {};
    }
    if (apiPath === 'AddSolutionComponent') {
      const sol = W.solutions[body.SolutionUniqueName];
      if (!sol) throw new DataverseError(`no solution ${body.SolutionUniqueName}`);
      W.components.push({ solutionid: sol.solutionid, objectid: body.ComponentId });
      return {};
    }
    if (apiPath === 'InsertOptionValue') {
      const os = optionTarget(body);
      if (os.Options.some((o) => o.Value === body.Value)) throw new DataverseError(`value ${body.Value} already exists`);
      os.Options.push({ Value: body.Value, Label: normLabels(body.Label) });
      return { NewOptionValue: body.Value };
    }
    if (apiPath === 'UpdateOptionValue') {
      const o = optionTarget(body).Options.find((x) => x.Value === body.Value);
      if (!o) throw new DataverseError(`no option ${body.Value}`);
      o.Label = normLabels(body.Label);
      return {};
    }
    if (apiPath === 'OrderOption') {
      const os = optionTarget(body);
      // As Dataverse: the new order must list every option exactly once.
      const have = os.Options.map((x) => x.Value).sort().join(',');
      if ([...body.Values].sort().join(',') !== have) throw new DataverseError(`OrderOption: Values must list every option (${have})`);
      os.Options = body.Values.map((v) => os.Options.find((x) => x.Value === v));
      return {};
    }
    if (apiPath === 'DeleteOptionValue') {
      const os = optionTarget(body);
      os.Options = os.Options.filter((x) => x.Value !== body.Value);
      return {};
    }
    throw new Error(`fake schema dv: unrouted ${M} ${apiPath}`);
  };

  function newAttrShape(body) {
    const odata = body['@odata.type'].replace(/^#?Microsoft\.Dynamics\.CRM\./, '');
    const b = normLabels(clone(body));
    return { ...attr(body.SchemaName.toLowerCase(), odata, ''), ...b, '@odata.type': `#Microsoft.Dynamics.CRM.${odata}`, LogicalName: body.SchemaName.toLowerCase(), AttributeType: TYPE_OF[odata] };
  }

  dv.publish = (components) => {
    const xml = publishXml(components); // the real builder: no PublishAllXml, names checked
    calls.push({ method: 'POST', path: 'PublishXml', body: { ParameterXml: xml } });
    if (dv.publishFails) throw new DataverseError('PublishXml failed');
    return {};
  };

  return dv;
}

const ENVS = {
  donorapp: { host: 'https://donorapp.invalid', name: 'Donor App', publisher: PUB, dev: 'fedev' },
  fedev: { host: 'https://fedev.invalid', name: 'Donor App Dev', publisher: PUB },
  hgs: { host: 'https://hgs.invalid', name: 'HGS apps', publisher: '9811ffde-bb43-4f05-be7c-2eb124dedf0c' },
};
const both = (level) => ({ donorapp: level, fedev: level, hgs: level });
const ACCESS = {
  people: {
    'dgross@example.org': { envs: both('admin') },
    'dev2@example.org': { envs: both('develop') },
    'writer@example.org': { envs: both('write') },
    'reader@example.org': { envs: both('read') },
  },
};

module.exports = { fakeSchemaDv, world, ENVS, ACCESS, USERS, PUB, OTHER_PUB, L };
