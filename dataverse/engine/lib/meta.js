'use strict';
// Table and column metadata, read live at plan time (CONTRACT.md §3-4). Supplies:
//   - what exists (a body column or bind that is not real is refused before any approval);
//   - the display labels the pop-up uses (never logical names, DESIGN.md §5 R5);
//   - choice/yes-no labels, so "Status: 1 -> 2" reads "Status: Active -> Inactive".
// `dv` is a read connection: { get(path, {formatted}) }.

function label(lbl, fallback) {
  return (lbl && lbl.UserLocalizedLabel && lbl.UserLocalizedLabel.Label) || fallback;
}

function q(s) {
  return String(s).replace(/'/g, "''");
}

// AttributeType values that hold a choice and how to read its options.
const CHOICE_CAST = {
  Picklist: 'PicklistAttributeMetadata',
  State: 'StateAttributeMetadata',
  Status: 'StatusAttributeMetadata',
  Boolean: 'BooleanAttributeMetadata',
  Virtual: 'MultiSelectPicklistAttributeMetadata', // only when AttributeTypeName is MultiSelectPicklistType
};

const NUMERIC = new Set(['Money', 'Decimal', 'Double', 'Integer', 'BigInt']);

function loadEntityBySet(dv, set) {
  const res = dv.get(`EntityDefinitions?$filter=EntitySetName eq '${q(set)}'`
    + '&$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,DisplayName,DisplayCollectionName');
  const e = (res.value || [])[0];
  if (!e) return null;
  return shapeEntity(e);
}

function loadEntityByLogical(dv, logical) {
  const e = dv.get(`EntityDefinitions(LogicalName='${q(logical)}')`
    + '?$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,DisplayName,DisplayCollectionName');
  return shapeEntity(e);
}

function shapeEntity(e) {
  return {
    logical: e.LogicalName,
    set: e.EntitySetName,
    primaryId: e.PrimaryIdAttribute,
    primaryName: e.PrimaryNameAttribute,
    singular: label(e.DisplayName, e.LogicalName),
    plural: label(e.DisplayCollectionName, e.EntitySetName),
  };
}

function loadTable(dv, set) {
  const entity = loadEntityBySet(dv, set);
  if (!entity) return null;
  const attrsRes = dv.get(`EntityDefinitions(LogicalName='${q(entity.logical)}')/Attributes`
    + '?$select=LogicalName,AttributeType,AttributeTypeName,DisplayName,IsValidForCreate,IsValidForUpdate,IsValidForRead,AttributeOf');
  const attrs = new Map();
  for (const a of attrsRes.value || []) {
    attrs.set(a.LogicalName, {
      logical: a.LogicalName,
      type: a.AttributeType,
      typeName: a.AttributeTypeName && a.AttributeTypeName.Value,
      label: label(a.DisplayName, a.LogicalName),
      create: !!a.IsValidForCreate,
      update: !!a.IsValidForUpdate,
      read: a.IsValidForRead !== false,
      attributeOf: a.AttributeOf || null,
    });
  }
  const relRes = dv.get(`EntityDefinitions(LogicalName='${q(entity.logical)}')/ManyToOneRelationships`
    + '?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName');
  const navs = new Map();
  for (const r of relRes.value || []) {
    navs.set(r.ReferencingEntityNavigationPropertyName, { attr: r.ReferencingAttribute, referenced: r.ReferencedEntity });
  }
  return { entity, attrs, navs, choices: new Map(), refs: new Map() };
}

function isChoice(attr) {
  if (!attr) return false;
  if (attr.type === 'Virtual') return attr.typeName === 'MultiSelectPicklistType';
  return Object.prototype.hasOwnProperty.call(CHOICE_CAST, attr.type);
}

// value -> label map for a choice column, cached on the table.
function choiceLabels(dv, table, attrName) {
  if (table.choices.has(attrName)) return table.choices.get(attrName);
  const attr = table.attrs.get(attrName);
  const cast = CHOICE_CAST[attr.type];
  const base = `EntityDefinitions(LogicalName='${q(table.entity.logical)}')/Attributes(LogicalName='${q(attrName)}')/Microsoft.Dynamics.CRM.${cast}?$select=LogicalName`;
  const map = new Map();
  if (attr.type === 'Boolean') {
    const r = dv.get(`${base}&$expand=OptionSet($select=TrueOption,FalseOption)`);
    const os = r.OptionSet || {};
    if (os.TrueOption) map.set(true, label(os.TrueOption.Label, 'Yes'));
    if (os.FalseOption) map.set(false, label(os.FalseOption.Label, 'No'));
  } else {
    const expand = (attr.type === 'Picklist' || attr.type === 'Virtual')
      ? '&$expand=OptionSet($select=Options),GlobalOptionSet($select=Options)'
      : '&$expand=OptionSet($select=Options)';
    const r = dv.get(base + expand);
    const opts = ((r.OptionSet && r.OptionSet.Options) || []).concat((r.GlobalOptionSet && r.GlobalOptionSet.Options) || []);
    for (const o of opts) map.set(o.Value, label(o.Label, String(o.Value)));
  }
  table.choices.set(attrName, map);
  return map;
}

// Date columns' format and time-zone behaviour (logical name -> { format, behaviour }), cached on the table.
// Read only when a job writes a date column; lib/localdate.js uses it to store local midnight for a
// date-only, user-local column (a gift's book date).
function dateBehaviours(dv, table) {
  if (table.dates) return table.dates;
  const r = dv.get(`EntityDefinitions(LogicalName='${q(table.entity.logical)}')/Attributes/Microsoft.Dynamics.CRM.DateTimeAttributeMetadata`
    + '?$select=LogicalName,Format,DateTimeBehavior');
  const map = new Map();
  for (const a of r.value || []) {
    if (!a.DateTimeBehavior) continue;
    map.set(a.LogicalName, { format: a.Format || null, behaviour: a.DateTimeBehavior.Value || null });
  }
  table.dates = map;
  return map;
}

// Referenced table info for a lookup target (set name + primary name), cached on the table.
function refTable(dv, table, logical) {
  if (!table.refs.has(logical)) table.refs.set(logical, loadEntityByLogical(dv, logical));
  return table.refs.get(logical);
}

// The Owner column (ownerid) is ONE navigation property onto the abstract `owner` table, which cannot be read or
// pointed at: a record is owned by a user or a team, and the pointer names that table (R-1035, 10/20/26). Every
// other two-target lookup (Customer) has a navigation property per target, so only Owner needs this.
const OWNER = 'owner';
const OWNER_SETS = { systemusers: 'systemuser', teams: 'team' };

// Which table an owner id is in, for a pointer back to it (revert keeps only the id): 'systemusers', 'teams' or null.
function ownerSetOf(dv, guid) {
  const { DataverseError } = require('./cli');
  for (const [set, idCol] of [['systemusers', 'systemuserid'], ['teams', 'teamid']]) {
    try {
      dv.get(`${set}(${guid})?$select=${idCol}`);
      return set;
    } catch (e) {
      if (!(e instanceof DataverseError)) throw e;
    }
  }
  return null;
}

module.exports = { loadTable, choiceLabels, refTable, dateBehaviours, isChoice, NUMERIC, label, OWNER, OWNER_SETS, ownerSetOf };
