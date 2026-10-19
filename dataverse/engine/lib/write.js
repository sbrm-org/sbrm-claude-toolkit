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
// Headers a metadata call may carry. Impersonation (MSCRMCallerID, CallerObjectId) is never allowed.
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
function publishXml({ entities = [], optionsets = [], sitemaps = [], appmodules = [] } = {}) {
  const IDENT = /^[A-Za-z0-9_{}-]+$/;
  const tag = (outer, inner, vals) => (vals.length ? `<${outer}>${vals.map((v) => {
    if (!IDENT.test(v)) throw new Error(`refusing to publish "${v}"`);
    return `<${inner}>${v}</${inner}>`;
  }).join('')}</${outer}>` : '');
  const body = tag('entities', 'entity', entities) + tag('optionsets', 'optionset', optionsets)
    + tag('sitemaps', 'sitemap', sitemaps) + tag('appmodules', 'appmodule', appmodules);
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
    create(set, body, { solution } = {}) {
      return send('POST', set, body, ['Prefer: return=representation', ...solutionHeader(solution)]);
    },
    update(set, id, body, etag) {
      if (!etag) throw new Error('refusing to PATCH without a version tag (If-Match)');
      return send('PATCH', `${set}(${id})`, body, [`If-Match: ${etag}`]);
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
    getMany(paths, concurrency) {
      return getMany(cli, host, paths, concurrency);
    },
  };
}

module.exports = { writeConnection, checkMeta, publishXml, roleCall, META_ACTIONS };
