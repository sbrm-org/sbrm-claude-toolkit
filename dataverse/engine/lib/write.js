'use strict';
// The WRITE connection. Imported by the apply functions ONLY; plan never sees it (cli.js is read-only).
//
// Verbs, each on a fixed or allow-listed path, so nothing a job file supplies can reach another endpoint:
//   create / update / remove   records: POST, PATCH with If-Match, DELETE with If-Match (remove is the
//                              admin delete, ruled 10/7; the caller checks the level)
//   merge                      Dataverse's native Merge action (DESIGN.md §8)
//   metadata                   app development (DESIGN.md §10b): EntityDefinitions, RelationshipDefinitions,
//                              GlobalOptionSetDefinitions, solutions, and the option-value / solution / app
//                              actions; DELETE only on the three definition sets (admin deletes)
//   publish                    PublishXml for the named components only; there is no PublishAllXml
//   grantRole / revokeRole     one security role given to or taken from one user (kind "role", 1.11.13): the
//                              association $ref on systemuserroles_association, both ids checked as GUIDs
//   createAppUser / setUserDisabled / createRole / addRolePrivileges / deleteRole / removeRolePrivilege
//                              application users and SBRM security roles (kinds "appuser", "securityrole", 1.11.31;
//                              removeRolePrivilege 1.11.43): fixed paths, bodies built from checked values only (identityCall)
//
// Every PATCH or DELETE of a record carries If-Match with the version tag read at apply, so Dataverse itself
// refuses the write (412) if anyone changed the record between the apply-time check and the write.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { request, resolveCli, getMany, FORMATTED } = require('./cli');
const store = require('./store');
const ticket = require('./ticket');

// Metadata paths the engine may write. The first group are definition sets (any method, DELETE included);
// the second are unbound actions (POST only).
const META_SETS = /^(?:EntityDefinitions|RelationshipDefinitions|GlobalOptionSetDefinitions|solutions)(?:[(/?]|$)/;
const META_ACTIONS = new Set(['InsertOptionValue', 'UpdateOptionValue', 'OrderOption', 'DeleteOptionValue',
  'UpdateStateValue', 'AddSolutionComponent', 'AddAppComponents', 'RemoveAppComponents', 'ValidateApp']);
const META_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Headers a metadata call may carry. Impersonation (MSCRMCallerID, CallerObjectId) is never allowed here; the one
// place an on-behalf-of header is ever sent is behalfHeader below (a flow, admin, test slice 11/19/26).
const META_HEADER = /^(?:MSCRM\.SolutionUniqueName|MSCRM\.MergeLabels|If-Match|Consistency|Prefer):/i;
const SOLUTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkMeta(method, apiPath, headers) {
  const m = String(method || '').toUpperCase();
  if (!META_METHODS.has(m)) throw new Error(`refusing metadata method ${method}`);
  const p = String(apiPath || '');
  // Only the prefix is allow-listed, so nothing after it may climb out of it (10/7 review: a path like
  // "EntityDefinitions(x)/../../contacts(<id>)" passed): no dot segments, no encoding, no backslash, no
  // doubled slash, no whitespace or line break.
  if (/(?:^|\/)\.\.?(?:\/|$)|%|\\|\/\/|\s/.test(p)) throw new Error(`refusing metadata path ${p.slice(0, 80)}`);
  // `solutions` is only ever CREATED (a new solution; components join through AddSolutionComponent):
  // nothing may navigate off a solution row (10/7 re-verify: `PUT solutions(<id>)/publisherid/$ref`).
  if (/^solutions\b/.test(p) && !(p === 'solutions' && m === 'POST')) throw new Error(`refusing ${m} ${p.slice(0, 80)}`);
  // Definitions may be addressed and cast, but a `$ref` or an unknown bound action is not a definition.
  if (/\$/.test(p)) throw new Error(`refusing metadata path ${p.slice(0, 80)}`);
  const isSet = META_SETS.test(p);
  const isAction = META_ACTIONS.has(p);
  if (!isSet && !isAction) throw new Error(`refusing metadata path ${p.slice(0, 80)}`);
  if (isAction && m !== 'POST') throw new Error(`refusing ${m} on the action ${p}`);
  if (m === 'DELETE' && !/^(?:EntityDefinitions|RelationshipDefinitions|GlobalOptionSetDefinitions)\(/.test(p)) {
    throw new Error(`refusing DELETE on ${p.slice(0, 80)}`);
  }
  for (const h of headers) if (!META_HEADER.test(h) || /[\r\n]/.test(String(h))) throw new Error(`refusing header ${String(h).split(':')[0]}`);
  return m;
}

// <importexportxml> for PublishXml. Only components this apply changed are published, never everyone's
// unpublished drafts (DESIGN.md §10b: no PublishAllXml).
// A dashboard (a systemform with no table, objecttypecode "none") is published by its own id (1.11.30; Microsoft
// Learn, "Analyze data with dashboards": PublishXml naming the dashboard id).
function publishXml({ entities = [], optionsets = [], sitemaps = [], appmodules = [], webresources = [], dashboards = [] } = {}) {
  const IDENT = /^[A-Za-z0-9_{}-]+$/;
  const tag = (outer, inner, vals) => (vals.length ? `<${outer}>${vals.map((v) => {
    if (!IDENT.test(v)) throw new Error(`refusing to publish "${v}"`);
    return `<${inner}>${v}</${inner}>`;
  }).join('')}</${outer}>` : '');
  const body = tag('entities', 'entity', entities) + tag('dashboards', 'dashboard', dashboards) + tag('optionsets', 'optionset', optionsets)
    + tag('sitemaps', 'sitemap', sitemaps) + tag('appmodules', 'appmodule', appmodules) + tag('webresources', 'webresource', webresources);
  if (!body) throw new Error('nothing to publish');
  return `<importexportxml>${body}</importexportxml>`;
}

// One role association (kind "role"). The path is fixed and both ids must be GUIDs, so nothing a plan carries
// can reach another endpoint; the role is named by its full URL on this connection's own host.
const GUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function roleCall(verb, userId, roleId, host) {
  if (!GUID_ONLY.test(String(userId)) || !GUID_ONLY.test(String(roleId))) throw new Error('refusing a role change whose user or role is not a GUID');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(String(host))) throw new Error('refusing a role change on a host that is not a bare https address');
  if (verb === 'grant') {
    return { method: 'POST', path: `systemusers(${userId})/systemuserroles_association/$ref`, body: { '@odata.id': `${host}/api/data/v9.2/roles(${roleId})` } };
  }
  if (verb === 'revoke') return { method: 'DELETE', path: `systemusers(${userId})/systemuserroles_association(${roleId})/$ref`, body: undefined };
  throw new Error(`refusing role verb ${verb}`);
}

// Application users and SBRM security roles (kinds "appuser" and "securityrole", 1.11.31). Each verb has one fixed
// path and a body built here from checked values, so nothing a plan carries can reach another endpoint or column.
const DEPTHS = new Set(['Basic', 'Local', 'Deep', 'Global']);
const ROLE_NAME = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 100 && !/[\x00-\x1f\x7f]/.test(s);
function identityCall(verb, a = {}) {
  const guid = (v, what) => { if (!GUID_ONLY.test(String(v))) throw new Error(`refusing ${verb}: ${what} is not a GUID`); return String(v).toLowerCase(); };
  if (verb === 'createAppUser') {
    return { method: 'POST', path: 'systemusers', body: { applicationid: guid(a.clientId, 'the client id'), 'businessunitid@odata.bind': `/businessunits(${guid(a.unitId, 'the business unit')})` }, headers: ['Prefer: return=representation'] };
  }
  if (verb === 'setUserDisabled') {
    if (typeof a.disabled !== 'boolean') throw new Error('refusing setUserDisabled: disabled must be true or false');
    if (!a.etag) throw new Error('refusing to PATCH without a version tag (If-Match)');
    return { method: 'PATCH', path: `systemusers(${guid(a.userId, 'the user')})`, body: { isdisabled: a.disabled }, headers: [`If-Match: ${a.etag}`] };
  }
  if (verb === 'createRole') {
    if (!ROLE_NAME(a.name)) throw new Error('refusing createRole: the name must be one line, at most 100 characters');
    if (a.description !== undefined && a.description !== null && (typeof a.description !== 'string' || a.description.length > 2000)) throw new Error('refusing createRole: the description must be text, at most 2000 characters');
    const body = { name: a.name, 'businessunitid@odata.bind': `/businessunits(${guid(a.unitId, 'the business unit')})` };
    if (a.description) body.description = a.description;
    return { method: 'POST', path: 'roles', body, headers: ['Prefer: return=representation'] };
  }
  if (verb === 'addRolePrivileges') {
    if (!Array.isArray(a.privileges) || !a.privileges.length || a.privileges.length > 400) throw new Error('refusing addRolePrivileges: 1 to 400 privileges');
    const Privileges = a.privileges.map((p) => {
      if (!DEPTHS.has(p.Depth)) throw new Error(`refusing addRolePrivileges: depth "${p.Depth}"`);
      return { PrivilegeId: guid(p.PrivilegeId, 'a privilege'), Depth: p.Depth, BusinessUnitId: guid(p.BusinessUnitId, 'the business unit') };
    });
    return { method: 'POST', path: `roles(${guid(a.roleId, 'the role')})/Microsoft.Dynamics.CRM.AddPrivilegesRole`, body: { Privileges }, headers: [] };
  }
  if (verb === 'deleteRole') {
    if (!a.etag) throw new Error('refusing to DELETE without a version tag (If-Match)');
    return { method: 'DELETE', path: `roles(${guid(a.roleId, 'the role')})`, body: undefined, headers: [`If-Match: ${a.etag}`] };
  }
  // One privilege taken off an existing role (kind "securityrole", action "remove", 1.11.43). Microsoft Learn,
  // "RemovePrivilegeRole Action": bound to the role, one parameter `Privilege`, an entity reference to the privilege.
  if (verb === 'removeRolePrivilege') {
    return {
      method: 'POST', path: `roles(${guid(a.roleId, 'the role')})/Microsoft.Dynamics.CRM.RemovePrivilegeRole`,
      body: { Privilege: { '@odata.type': 'Microsoft.Dynamics.CRM.privilege', privilegeid: guid(a.privilegeId, 'the privilege') } }, headers: [],
    };
  }
  throw new Error(`refusing identity verb ${verb}`);
}

// The approval, checked HERE on every write this connection sends (1.11.10, guard_review/DESIGN.md §2a, ruled
// 10/13): the object ticket.take() hands back for a ticket the guard minted when Claude Code asked the person.
// Before this only the CLI's apply took a ticket, so a script that loaded this module could write with its own
// "approval". `approval` is the object, or a function that returns it when the write is sent (resolve opens its
// connection before it takes its ticket). The one write that needs none: a NEW Write Log row, which is how the
// health check sends on a row parked by an earlier apply (lib/log.js flushPending). It does not stop a script that
// runs the CLI itself (the design's stated residual).
const LOG_ROW = 'sbrm_dataversewritelogs';
function approved(approval) {
  const a = typeof approval === 'function' ? approval() : approval;
  return ticket.verify(a);
}

// Writing ON BEHALF OF a flow's connection owner (TEST SLICE, 11/19/26; CONTRACT.md §3, §8): Dataverse's own
// on-behalf-of header, which the platform honours when the signed-in person holds "Act on Behalf of Another User"
// (System Administrator does). The record then reads created/modified BY that account and ON BEHALF BY the person.
// It is added HERE and nowhere else: only on a cloud flow (the `workflows` set), only as a GUID the caller resolved
// from the live environment (lib/component.js actAsTarget), never from anything a job file carries. Every other
// write, the Write Log row included, goes as the signed-in person.
function behalfHeader(set, behalf) {
  if (behalf === undefined || behalf === null) return [];
  if (set !== 'workflows') throw new Error('refusing to write on behalf of another user outside a cloud flow');
  if (!GUID_ONLY.test(String(behalf))) throw new Error('refusing an on-behalf-of id that is not a GUID');
  return [`CallerObjectId: ${String(behalf).toLowerCase()}`];
}

function writeConnection(host, cli = resolveCli(), { approval = null } = {}) {
  const send = (method, apiPath, body, headers) => {
    if (!(method === 'POST' && apiPath === LOG_ROW) && !approved(approval)) {
      throw new Error(`refusing to ${method} ${String(apiPath).slice(0, 60)} without an approval from Claude Code's permission prompt (no ticket for this change)`);
    }
    if (body === undefined) return request(cli, host, apiPath, { method, headers });
    const tmp = path.join(store.dir('tmp'), `body-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
    try {
      return request(cli, host, apiPath, { method, headers, bodyFile: tmp });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };
  const solutionHeader = (solution) => {
    if (solution === undefined || solution === null) return [];
    if (!SOLUTION_NAME.test(solution)) throw new Error(`refusing solution name ${solution}`);
    return [`MSCRM.SolutionUniqueName: ${solution}`];
  };
  return {
    host,
    cliVersion: cli.version,
    // `strong`: read past the metadata cache, for read-backs right after a write (10/7 third pass).
    get(apiPath, { formatted = false, strong = false } = {}) {
      return request(cli, host, apiPath, { method: 'GET', headers: [...(formatted ? [FORMATTED] : []), ...(strong ? ['Consistency: Strong'] : [])] });
    },
    // A new record. `solution` (a new view, form, sitemap or flow) puts it in that unmanaged solution.
    // `behalf` (test slice, 11/19/26): a flow written on behalf of its connections' owner; see behalfHeader.
    create(set, body, { solution, behalf } = {}) {
      return send('POST', set, body, ['Prefer: return=representation', ...solutionHeader(solution), ...behalfHeader(set, behalf)]);
    },
    update(set, id, body, etag, { behalf } = {}) {
      if (!etag) throw new Error('refusing to PATCH without a version tag (If-Match)');
      return send('PATCH', `${set}(${id})`, body, [`If-Match: ${etag}`, ...behalfHeader(set, behalf)]);
    },
    // The admin delete of one record (ruled 10/7). Version-tagged like an update.
    remove(set, id, etag) {
      if (!etag) throw new Error('refusing to DELETE without a version tag (If-Match)');
      return send('DELETE', `${set}(${id})`, undefined, [`If-Match: ${etag}`]);
    },
    // Dataverse's native Merge action (DESIGN.md §8). The path is fixed here.
    merge(body) {
      return send('POST', 'Merge', body, []);
    },
    // App development (DESIGN.md §10b). The path, method and headers are checked against the allow-list.
    metadata(method, apiPath, body, headers = []) {
      const m = checkMeta(method, apiPath, headers);
      return send(m, apiPath, m === 'DELETE' ? undefined : (body === undefined ? {} : body), headers);
    },
    publish(components) {
      return send('POST', 'PublishXml', { ParameterXml: publishXml(components) }, []);
    },
    // A security role given to or taken from one user (kind "role"). Admin level; the caller checks it.
    grantRole(userId, roleId) {
      const c = roleCall('grant', userId, roleId, host);
      return send(c.method, c.path, c.body, []);
    },
    revokeRole(userId, roleId) {
      const c = roleCall('revoke', userId, roleId, host);
      return send(c.method, c.path, c.body, []);
    },
    // Application users and SBRM security roles (1.11.31). Admin level; the caller checks it.
    createAppUser(clientId, unitId) {
      const c = identityCall('createAppUser', { clientId, unitId });
      return send(c.method, c.path, c.body, c.headers);
    },
    setUserDisabled(userId, disabled, etag) {
      const c = identityCall('setUserDisabled', { userId, disabled, etag });
      return send(c.method, c.path, c.body, c.headers);
    },
    createRole(name, unitId, description) {
      const c = identityCall('createRole', { name, unitId, description });
      return send(c.method, c.path, c.body, c.headers);
    },
    addRolePrivileges(roleId, privileges) {
      const c = identityCall('addRolePrivileges', { roleId, privileges });
      return send(c.method, c.path, c.body, c.headers);
    },
    deleteRole(roleId, etag) {
      const c = identityCall('deleteRole', { roleId, etag });
      return send(c.method, c.path, c.body, c.headers);
    },
    removeRolePrivilege(roleId, privilegeId) {
      const c = identityCall('removeRolePrivilege', { roleId, privilegeId });
      return send(c.method, c.path, c.body, c.headers);
    },
    // Duplicate-detection rules (kind "duperule", 11/16/26). Admin level; the caller checks it. Unpublish is an
    // UNBOUND action (the bound form answers "Resource not found", 10/7); Publish is bound to the rule.
    unpublishDuplicateRule(ruleId) {
      const c = dupRuleCall('unpublish', ruleId);
      return send(c.method, c.path, c.body, []);
    },
    publishDuplicateRule(ruleId) {
      const c = dupRuleCall('publish', ruleId);
      return send(c.method, c.path, c.body, []);
    },
    // A built-in command-bar button hidden for one table in one app (kind "command", 1.11.43). Admin level; the
    // caller checks it. The new row goes in an SBRM solution, like every other app part made here.
    createCommandHide(args, solution) {
      const c = commandCall('hide', args, host);
      return send(c.method, c.path, c.body, [...c.headers, ...solutionHeader(solution)]);
    },
    linkCommandRule(id, ruleId) {
      const c = commandCall('linkRule', { id, ruleId }, host);
      return send(c.method, c.path, c.body, c.headers);
    },
    setCommandHidden(id, hidden, etag) {
      const c = commandCall('setHidden', { id, hidden, etag }, host);
      return send(c.method, c.path, c.body, c.headers);
    },
    getMany(paths, concurrency) {
      return getMany(cli, host, paths, concurrency);
    },
  };
}

// A built-in command-bar button hidden for one table in one app (kind "command", 1.11.43; Dylan 11/20/26). The row
// is the one the maker portal's command designer itself sends for a Hide (captured 11/23/26 in Donor App Dev): the
// GLOBAL template's own name, context 1 (Entity) with the table, the app, hidden true, origin 2, an EMPTY uniquename
// the server fills in, and the template's label, icon and JavaScript action. Three verbs, each with one fixed path
// and a body built here from checked values only: nothing a plan carries can reach another table, column or endpoint.
const COMMAND_NAME = /^Mscrm\.(Form|HomepageGrid|SubGrid)\.\{!EntityLogicalName\}\.(Deactivate|Activate|NewRecord)$/;
const COMMAND_TABLE = /^sbrm_[a-z0-9_]{1,60}$/;
function commandCall(verb, a = {}, host) {
  const guid = (v, what) => { if (!GUID_ONLY.test(String(v))) throw new Error(`refusing ${verb}: ${what} is not a GUID`); return String(v).toLowerCase(); };
  const text = (v, what, max) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) throw new Error(`refusing ${verb}: ${what} must be text, at most ${max} characters`);
    return v;
  };
  if (verb === 'hide') {
    if (!COMMAND_NAME.test(String(a.name))) throw new Error('refusing hide: the name is not one of the built-in Deactivate, Activate or New buttons');
    if (![0, 1, 2, 3].includes(a.location)) throw new Error('refusing hide: the place must be the form, the main grid, a sub grid or an associated grid');
    if (!COMMAND_TABLE.test(String(a.table))) throw new Error('refusing hide: the table must be one of SBRM\'s own (sbrm_...)');
    const f = a.fields || {};
    if (typeof f.sequence !== 'number' || !Number.isFinite(f.sequence)) throw new Error('refusing hide: the button\'s position is not a number');
    if (typeof f.functionName !== 'string' || !/^[A-Za-z_$][\w$.]{0,199}$/.test(f.functionName)) throw new Error('refusing hide: the button\'s action is not a function name');
    if (![0, 1, 2].includes(f.visibilitytype)) throw new Error('refusing hide: unknown visibility type');
    const body = {
      name: a.name, type: 0, location: a.location, context: 1, contextvalue: a.table, hidden: true, uniquename: '', origin: 2, sequence: f.sequence,
      'ContextEntity@odata.bind': `/entities(${guid(a.entityId, 'the table')})`, 'AppModuleId@odata.bind': `/appmodules(${guid(a.appId, 'the app')})`,
      onclickeventtype: 2, 'OnClickEventJavaScriptWebResourceId@odata.bind': `/webresourceset(${guid(f.webresourceId, 'the button\'s script')})`,
      onclickeventjavascriptfunctionname: f.functionName, visibilitytype: f.visibilitytype,
    };
    const optional = { buttonlabeltext: text(f.label, 'the label', 200), buttontooltiptitle: text(f.tooltipTitle, 'the tooltip title', 200),
      buttonaccessibilitytext: text(f.accessibility, 'the accessibility text', 200), buttontooltipdescription: text(f.tooltipDescription, 'the tooltip', 2000),
      fonticon: text(f.fonticon, 'the icon', 200), onclickeventjavascriptparameters: text(f.parameters, 'the action\'s parameters', 4000) };
    for (const [k, v] of Object.entries(optional)) if (v !== undefined) body[k] = v;
    return { method: 'POST', path: 'appactions', body, headers: ['Prefer: return=representation'] };
  }
  // One of the template's classic visibility rules linked to the new row, so a later "show" brings the button back
  // with the rules it had (the designer sends one of these per rule).
  if (verb === 'linkRule') {
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(String(host))) throw new Error('refusing linkRule on a host that is not a bare https address');
    return { method: 'POST', path: `appactions(${guid(a.id, 'the button row')})/appaction_appactionrule_classicrules/$ref`,
      body: { '@odata.id': `${host}/api/data/v9.2/appactionrules(${guid(a.ruleId, 'the rule')})` }, headers: [] };
  }
  if (verb === 'setHidden') {
    if (typeof a.hidden !== 'boolean') throw new Error('refusing setHidden: hidden must be true or false');
    if (!a.etag) throw new Error('refusing to PATCH without a version tag (If-Match)');
    return { method: 'PATCH', path: `appactions(${guid(a.id, 'the button row')})`, body: { hidden: a.hidden }, headers: [`If-Match: ${a.etag}`] };
  }
  throw new Error(`refusing command verb ${verb}`);
}

function dupRuleCall(verb, ruleId) {
  if (!GUID_ONLY.test(String(ruleId))) throw new Error(`refusing ${verb} of a duplicate rule: the rule is not a GUID`);
  const id = String(ruleId).toLowerCase();
  if (verb === 'unpublish') return { method: 'POST', path: 'UnpublishDuplicateRule', body: { DuplicateRuleId: id } };
  if (verb === 'publish') return { method: 'POST', path: `duplicaterules(${id})/Microsoft.Dynamics.CRM.PublishDuplicateRule`, body: {} };
  throw new Error(`refusing duplicate rule verb ${verb}`);
}

module.exports = { writeConnection, checkMeta, publishXml, roleCall, identityCall, dupRuleCall, commandCall, behalfHeader, META_ACTIONS };
