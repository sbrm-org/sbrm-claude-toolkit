'use strict';
// The go-between for a read connection (1.11.10). Until 1.11.9 the launcher handed Claude Code's stdio straight
// to the Dataverse CLI's `mcp <host>` server. On Kayleen's Mac (10/13, CLI 1.0.81 osx-arm64) that server
// CRASHES (SIGABRT, .NET AccessViolationException) when two requests are in flight at once, and Claude Code
// sends three at every connect: tools/list, prompts/list and resources/list together. tools/list alone ran a
// full minute; the burst killed it at two different places (HTTP connect, JSON metadata), so it is a race
// inside the CLI, and parallel tool calls can hit it too. 1.0.81 is the newest CLI, so the fix lives here:
//
//   - prompts/list, resources/list, resources/templates/list and ping are answered HERE (empty lists, {}).
//     The toolkit uses no prompts or resources, and on Windows the CLI only answered them "An error occurred".
//     initialize's answer loses its prompts/resources capabilities so Claude Code stops asking.
//   - every other request goes to the CLI ONE AT A TIME: the next is sent only when the last is answered.
//   - a cancelled request still queued is never sent; a cancelled request in flight is passed on and, if the
//     CLI never answers it, the queue moves on after a grace period (its late answer is dropped).
//   - Claude Code's answers to the CLI's own requests pass straight through (the CLI is waiting on them).
//   - stdout lines that are not JSON (the CLI's "warn: ..." log lines) go to stderr, not to Claude Code.

const LOCAL = {
  'prompts/list': { prompts: [] },
  'resources/list': { resources: [] },
  'resources/templates/list': { resourceTemplates: [] },
  ping: {},
};

const key = (id) => JSON.stringify(id);

function createProxy({ toClient, toServer, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, cancelGraceMs = 10000 }) {
  const queue = []; // { line, kind: 'request' | 'notify', id?, method? }
  let inflight = null; // { k, method, timer }
  const dropped = new Set(); // keys of abandoned requests whose late answers are discarded

  function pump() {
    while (!inflight && queue.length) {
      const item = queue.shift();
      toServer(item.line);
      if (item.kind === 'request') inflight = { k: key(item.id), method: item.method, timer: null };
    }
  }

  function settle() {
    if (inflight && inflight.timer) clearTimer(inflight.timer);
    inflight = null;
    pump();
  }

  function fromClient(raw) {
    const line = String(raw).trim();
    if (!line) return;
    let m;
    try { m = JSON.parse(line); } catch { queue.push({ line, kind: 'notify' }); pump(); return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { queue.push({ line, kind: 'notify' }); pump(); return; }
    const hasId = m.id !== undefined && m.id !== null;
    if (typeof m.method !== 'string') {
      // An answer to the CLI's own request: it is waiting on this, so it never queues.
      toServer(line);
      return;
    }
    if (hasId) {
      if (Object.prototype.hasOwnProperty.call(LOCAL, m.method)) {
        toClient(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: LOCAL[m.method] }));
        return;
      }
      queue.push({ line, kind: 'request', id: m.id, method: m.method });
      pump();
      return;
    }
    if (m.method === 'notifications/cancelled') {
      const target = m.params && m.params.requestId;
      if (target === undefined || target === null) return;
      const k = key(target);
      const at = queue.findIndex((q) => q.kind === 'request' && key(q.id) === k);
      if (at >= 0) { queue.splice(at, 1); return; }
      if (inflight && inflight.k === k) {
        toServer(line);
        const mine = inflight;
        mine.timer = setTimer(() => {
          if (inflight !== mine) return;
          dropped.add(mine.k);
          log(`request ${mine.k} (${mine.method}) was cancelled and not answered in ${cancelGraceMs} ms; moving on`);
          settle();
        }, cancelGraceMs);
      }
      return; // a cancel for something already answered: nothing to do
    }
    queue.push({ line, kind: 'notify' });
    pump();
  }

  function fromServer(raw) {
    const line = String(raw).trim();
    if (!line) return;
    let m;
    try { m = JSON.parse(line); } catch { log(`not JSON, kept off the connection: ${line.slice(0, 300)}`); return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.method === 'string' || m.id === undefined || m.id === null) {
      toClient(line); // the CLI's own requests and notifications, or anything unrecognised
      return;
    }
    const k = key(m.id);
    if (dropped.has(k)) { dropped.delete(k); return; }
    if (inflight && inflight.k === k) {
      let out = line;
      if (inflight.method === 'initialize' && m.result && m.result.capabilities && typeof m.result.capabilities === 'object') {
        const capabilities = { ...m.result.capabilities };
        delete capabilities.prompts;
        delete capabilities.resources;
        out = JSON.stringify({ ...m, result: { ...m.result, capabilities } });
      }
      toClient(out);
      settle();
      return;
    }
    toClient(line);
  }

  return { fromClient, fromServer, state: () => ({ inflight: inflight && inflight.k, queued: queue.length }) };
}

// Line-split a readable stream (utf8, CRLF tolerated); the last unterminated line is delivered at end.
function onLines(stream, fn, onEnd = () => {}) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      fn(line);
    }
  });
  stream.on('end', () => {
    if (buf) fn(buf);
    buf = '';
    onEnd();
  });
}

// Wire Claude Code's side (clientIn/clientOut) to a spawned CLI whose stdin/stdout are pipes.
function bridge({ clientIn, clientOut, child, log, cancelGraceMs }) {
  const proxy = createProxy({
    toClient: (s) => clientOut.write(`${s}\n`),
    toServer: (s) => { if (child.stdin.writable) child.stdin.write(`${s}\n`); },
    log,
    cancelGraceMs,
  });
  child.stdin.on('error', () => { /* the CLI exited; its exit ends the launcher */ });
  onLines(clientIn, proxy.fromClient, () => child.stdin.end());
  onLines(child.stdout, proxy.fromServer);
  return proxy;
}

module.exports = { createProxy, onLines, bridge, LOCAL };
