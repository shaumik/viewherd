import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, createSession, executeCommand } from '@viewherd/core';
import { createMemoryStore, createD1Store, createController, createViewherdHandler } from '@viewherd/server';
import { createFileStore } from '@viewherd/server/node';

globalThis.crypto ??= webcrypto;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const panels = [
  { type: 'counter', title: 'Counter', dataSchema: objectSchema({}), actions: {
    increment: { description: 'Increase the count.', inputSchema: objectSchema({ amount: { type: 'integer', minimum: 1, maximum: 10 } }), run(ctx, args) { ctx.app.count += args.amount; return { count: ctx.app.count, actor: ctx.principal.id }; } },
    inspect: { inputSchema: objectSchema({}), run(ctx) { return { count: ctx.app.count }; } },
    fail: { inputSchema: objectSchema({}), run(ctx) { ctx.app.count = 999; throw Object.assign(new Error('Rejected transaction.'), { code: 'example_failure' }); } },
    close: { inputSchema: objectSchema({}), run(ctx) { ctx.call('pane.split', { paneId: ctx.pane.id, direction: 'right', view: 'document', title: 'Survivor', data: { content: 'Persisted' } }); ctx.call('pane.close', { paneId: ctx.pane.id }); return { closed: true }; } }
  } },
  { type: 'other', title: 'Other', dataSchema: objectSchema({}), actions: {
    increment: { inputSchema: objectSchema({ amount: { type: 'integer' } }), run(ctx, args) { ctx.app.count += args.amount * 100; return { count: ctx.app.count }; } }
  } }
];
const registry = createRegistry(panels);
const createState = id => createSession({ id, view: 'counter', title: 'Counter', data: {}, app: { count: 0 }, registry });
const authorize = request => ({ id: request.headers.get('x-user') ?? 'user:a', actor: 'host:authenticated' });
const command = (id, method = 'panel.action', params = { paneId: 'pane_inbox', action: 'increment', args: { amount: 1 } }, sessionId = 'session-a', expectedRevision) => ({ version: 1, requestId: id, sessionId, method, params, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
const request = (path, body, headers = {}, signal) => new Request(`https://example.test${path}`, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
const rpc = (handler, body, headers = {}) => handler(request('/viewherd/rpc', body, headers));
const makeHandler = (options = {}) => createViewherdHandler({ registry, store: createMemoryStore({ createState }), authorize, sessionId: 'session-a', ...options });

function fakeD1() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) { return { bind(...args) { return {
      async first() { await Promise.resolve(); const row = rows.get(args[0]); return row ? { payload: row.payload } : null; },
      async run() {
        await Promise.resolve();
        if (sql.startsWith('INSERT')) { if (!rows.has(args[0])) rows.set(args[0], { revision: args[1], payload: args[2] }); return { meta: { changes: 1 } }; }
        if (sql.startsWith('UPDATE')) { const row = rows.get(args[3]); if (row?.revision !== args[4]) return { meta: { changes: 0 } }; rows.set(args[3], { revision: args[0], payload: args[1] }); return { meta: { changes: 1 } }; }
        throw new Error('Unexpected test SQL.');
      }
    }; } }; }
  };
}

test('server SDK requires authorization and never reads storage for denied access', async () => {
  assert.throws(() => createViewherdHandler({ registry, store: createMemoryStore({ createState }) }), /authorize/);
  let reads = 0;
  const store = { read() { reads++; throw new Error('Unauthorized read.'); }, transact() { reads++; throw new Error('Unauthorized transaction.'); } };
  const handler = makeHandler({ store, authorize: () => null });
  for (const req of [request('/viewherd/snapshot?sessionId=session-a'), request('/viewherd/schema?sessionId=session-a'), request('/viewherd/events?sessionId=session-a'), request('/viewherd/rpc', command('denied')), request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })]) {
    assert.equal((await handler(req)).status, 401);
  }
  assert.equal(reads, 0);
  assert.equal((await makeHandler({ store, authorize: () => { throw Object.assign(new Error('Denied'), { code: 'forbidden' }); } })(request('/viewherd/snapshot'))).status, 403);
});

test('HTTP commands are versioned, isolated, schema discoverable and host-attributed', async () => {
  const store = createMemoryStore({ createState }), handler = makeHandler({ store, sessionId: undefined, authorize: (req, ctx) => {
    if (req.headers.get('x-user') !== ctx.sessionId) throw Object.assign(new Error('Denied'), { code: 'forbidden' });
    return { id: ctx.sessionId, actor: 'host:verified' };
  } });
  const output = await (await rpc(handler, command('one', 'panel.action', { paneId: 'pane_inbox', action: 'increment', args: { amount: 2 }, actor: 'pretend:admin' }, 'team-a'), { 'x-user': 'team-a' })).json();
  assert.equal(output.state.app.count, 2); assert.equal(output.state.events.at(-1).actor, 'host:verified'); assert.equal(output.version, 1);
  const other = await (await handler(request('/viewherd/snapshot?sessionId=team-b', undefined, { 'x-user': 'team-b' }))).json();
  assert.equal(other.app.count, 0);
  assert.equal((await handler(request('/viewherd/snapshot?sessionId=team-a', undefined, { 'x-user': 'team-b' }))).status, 403);
  const schema = await (await handler(request('/viewherd/schema?sessionId=team-a', undefined, { 'x-user': 'team-a' }))).json();
  assert.ok(schema.methods.some(item => item.name === 'panel.action')); assert.ok(schema.panels.some(item => item.type === 'counter'));
  assert.equal((await rpc(handler, { ...command('bad', undefined, undefined, 'team-a'), version: 2 }, { 'x-user': 'team-a' })).status, 400);
  assert.equal((await rpc(handler, { ...command('bad', undefined, undefined, 'team-a'), requestId: '' }, { 'x-user': 'team-a' })).status, 400);
});

test('exact retry receipts bind principal and protect atomic state and expected revisions', async () => {
  const store = createMemoryStore({ createState }), handler = makeHandler({ store });
  const body = command('retry', undefined, undefined, 'session-a', 0);
  const first = await (await rpc(handler, body)).json();
  const retry = await (await rpc(handler, body)).json();
  assert.deepEqual(retry.result, first.result); assert.equal(retry.replayed, true); assert.equal(retry.state.app.count, 1);
  assert.equal((await rpc(handler, body, { 'x-user': 'user:b' })).status, 409);
  assert.equal((await rpc(handler, { ...body, params: { ...body.params, args: { amount: 2 } } })).status, 409);
  const stale = await rpc(handler, command('stale', undefined, undefined, 'session-a', 0));
  assert.equal(stale.status, 409); assert.equal((await stale.json()).state.app.count, 1);
  assert.equal((await rpc(handler, command('failure', 'panel.action', { paneId: 'pane_inbox', action: 'fail', args: {} }))).status, 400);
  const record = await store.read('session-a'); assert.equal(record.state.app.count, 1); assert.equal(record.state.revision, 1); assert.equal(record.receipts.length, 1);
  record.state.app.count = 77; assert.equal((await store.read('session-a')).state.app.count, 1);
});

test('D1 CAS preserves concurrent changes, no-op receipts and distinct SDK sessions', async () => {
  const db = fakeD1(), a = createD1Store(db, { createState }), b = createD1Store(db, { createState });
  const ha = makeHandler({ store: a }), hb = makeHandler({ store: b });
  const results = await Promise.all([rpc(ha, command('a')), rpc(hb, command('b'))]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  const inspect = { paneId: 'pane_inbox', action: 'inspect', args: {} };
  await Promise.all([rpc(ha, command('noop-a', 'panel.action', inspect)), rpc(hb, command('noop-b', 'panel.action', inspect))]);
  const record = await a.read('session-a'); assert.equal(record.state.app.count, 2); assert.equal(record.state.revision, 2); assert.equal(record.storageRevision, 4); assert.equal(record.receipts.length, 4);
  await b.read('session-b'); assert.equal(db.rows.size, 2); assert.ok(db.rows.has('sdk:session-a')); assert.ok(db.rows.has('sdk:session-b')); assert.equal(db.rows.has('default'), false);
});

test('RPC rejects foreign origins and oversized bodies; trusted MCP still requires authorization', async () => {
  const handler = makeHandler();
  assert.equal((await rpc(handler, command('origin'), { origin: 'https://foreign.test' })).status, 403);
  assert.equal((await handler(new Request('https://example.test/viewherd/rpc', { method: 'POST', body: 'x'.repeat(300001) }))).status, 413);
  assert.equal((await handler(request('/no-route'))).status, 404);
  const trusted = makeHandler({ trustedMcpOrigin: true, authorize: () => null });
  assert.equal((await trusted(request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://trusted-dispatch.test' }))).status, 401);
});

test('MCP modern request metadata is checked and tools share the HTTP state and retry dispatcher', async () => {
  const handler = makeHandler();
  const modern = (method, params = {}) => ({ jsonrpc: '2.0', id: 42, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } });
  const headers = method => ({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, accept: 'application/json, text/event-stream' });
  const discover = await (await handler(request('/mcp', modern('server/discover'), headers('server/discover')))).json();
  assert.equal(discover.result.resultType, 'complete'); assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].version, '0.2.0'); assert.equal(discover.result.ttlMs, 0); assert.equal(discover.result.cacheScope, 'private');
  const invalidHeaders = await handler(request('/mcp', modern('server/discover'), { ...headers('server/discover'), 'mcp-method': 'tools/list' }));
  assert.equal(invalidHeaders.status, 400); assert.equal((await invalidHeaders.json()).error.code, -32020);
  const missingMeta = await handler(request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers('tools/list')));
  assert.equal(missingMeta.status, 400); assert.equal((await missingMeta.json()).error.code, -32602);
  const tools = await (await handler(request('/mcp', modern('tools/list'), headers('tools/list')))).json();
  assert.ok(tools.result.tools.some(tool => tool.name === 'viewherd_action_counter_increment')); assert.equal(tools.result.ttlMs, 0); assert.equal(tools.result.cacheScope, 'private');
  const args = { requestId: 'mcp-action', paneId: 'pane_inbox', args: { amount: 3 } };
  const actionBody = modern('tools/call', { name: 'viewherd_action_counter_increment', arguments: args });
  const actionHeaders = { ...headers('tools/call'), 'mcp-name': `=?base64?${Buffer.from('viewherd_action_counter_increment').toString('base64')}?=` };
  const action = await (await handler(request('/mcp', actionBody, actionHeaders))).json();
  assert.equal(action.result.structuredContent.state.app.count, 3);
  const missingArgs = await handler(request('/mcp', modern('tools/call', { name: 'viewherd_action_counter_inspect', arguments: { requestId: 'missing-args', paneId: 'pane_inbox' } }), { ...headers('tools/call'), 'mcp-name': 'viewherd_action_counter_inspect' }));
  assert.equal(missingArgs.status, 400); assert.equal((await missingArgs.json()).error.code, -32602);
  const extraArgs = await handler(request('/mcp', modern('tools/call', { name: 'viewherd_snapshot', arguments: { unexpected: true } }), { ...headers('tools/call'), 'mcp-name': 'viewherd_snapshot' }));
  assert.equal(extraArgs.status, 400); assert.equal((await extraArgs.json()).error.code, -32602);
  const state = await (await handler(request('/viewherd/snapshot'))).json(); assert.equal(state.app.count, 3);
  const retry = await (await handler(request('/mcp', actionBody, actionHeaders))).json(); assert.equal(retry.result.structuredContent.replayed, true);
  const unsupported = await handler(request('/mcp', modern('initialize'), headers('initialize'))); assert.equal(unsupported.status, 404);
  const legacy = await (await handler(request('/mcp', { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } }))).json();
  assert.equal(legacy.result.protocolVersion, '2025-11-25'); assert.equal(legacy.result.resultType, undefined);
  const fallback = await (await handler(request('/mcp', { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01', capabilities: {} } }))).json();
  assert.equal(fallback.result.protocolVersion, '2025-11-25');
});

test('MCP action retries survive closed targets and target guards run inside the transaction', async () => {
  const store = createMemoryStore({ createState }), handler = makeHandler({ store });
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'viewherd_action_counter_close', arguments: { requestId: 'close-once', paneId: 'pane_inbox', args: {} } } };
  const initial = await (await handler(request('/mcp', body))).json(); assert.equal(initial.result.isError, undefined);
  const repeated = await (await handler(request('/mcp', body))).json(); assert.equal(repeated.result.structuredContent.replayed, true);
  const original = createMemoryStore({ createState });
  let replaced = false;
  const racingStore = { kind: 'racing-test', read: original.read, async transact(id, transaction) {
    if (!replaced) { replaced = true; await original.transact(id, async record => {
      const outcome = await executeCommand(record.state, command('external-type', 'view.open', { paneId: 'pane_inbox', view: 'other', data: {} }), { registry, principal: { id: 'external' } });
      return { changed: true, record: { ...record, state: outcome.state, storageRevision: record.storageRevision + 1 }, response: null };
    }); }
    return original.transact(id, transaction);
  } };
  const racingHandler = makeHandler({ store: racingStore });
  const response = await (await racingHandler(request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'viewherd_action_counter_increment', arguments: { requestId: 'wrong-type', paneId: 'pane_inbox', args: { amount: 1 } } } }))).json();
  assert.equal(response.result.isError, true); assert.equal((await original.read('session-a')).state.app.count, 0);
});

test('SSE delivers persisted updates, coalesces backpressure and cancels polling', async () => {
  const backing = createMemoryStore({ createState }); let reads = 0;
  const observed = new Set(), waiting = new Map();
  const waitForPoll = revision => observed.has(revision) ? Promise.resolve() : new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { waiting.delete(revision); reject(new Error(`SSE did not poll persisted revision ${revision}.`)); }, 4000);
    waiting.set(revision, () => { clearTimeout(deadline); resolve(); });
  });
  const store = { kind: 'observed', async read(id) {
    reads++;
    const record = await backing.read(id);
    // Signal after the poll's promise continuation has enqueued or coalesced this revision.
    setImmediate(() => { observed.add(record.state.revision); waiting.get(record.state.revision)?.(); waiting.delete(record.state.revision); });
    return record;
  }, transact: backing.transact };
  const handler = makeHandler({ store, stream: { pollIntervalMs: 5, heartbeatMs: 10000, lifetimeMs: 3000 } });
  const response = await handler(request('/viewherd/events'));
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  try {
    const first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /event: snapshot/); assert.match(first, /"count":0/);
    await rpc(handler, command('stream-a'));
    const next = new TextDecoder().decode((await reader.read()).value); assert.match(next, /event: state.changed/); assert.match(next, /"count":1/);
    await rpc(handler, command('stream-b')); await waitForPoll(2); // Snapshot2 is queued and fills the stream buffer.
    await rpc(handler, command('stream-c')); await waitForPoll(3);
    await rpc(handler, command('stream-d')); await waitForPoll(4);
    const queued = new TextDecoder().decode((await reader.read()).value); assert.match(queued, /"count":2/);
    const latest = new TextDecoder().decode((await reader.read()).value); assert.match(latest, /"count":4/); // Revision3 coalesced into latest4.
    await reader.cancel(); const stoppedAt = reads; await delay(30); assert.equal(reads, stoppedAt);
  } finally { await reader.cancel(); }
});

test('SSE reconnect resync, bounded expiration and authorization revocation close cleanly', async () => {
  const store = createMemoryStore({ createState });
  await store.transact('session-a', record => { record.state.revision = 4; record.state.events = [{ id: 'e', revision: 4, method: 'x', actor: 'x', summary: 'x', time: new Date().toISOString() }]; return { record: { ...record, storageRevision: record.storageRevision + 1 }, response: null, changed: true }; });
  const handler = makeHandler({ store, stream: { pollIntervalMs: 5, heartbeatMs: 100, lifetimeMs: 25 } });
  const response = await handler(request('/viewherd/events', undefined, { 'last-event-id': '1' }));
  const reader = response.body.getReader(); let output = '';
  while (true) { const part = await reader.read(); if (part.done) break; output += new TextDecoder().decode(part.value); }
  assert.match(output, /event: resync_required/); assert.match(output, /event: snapshot/);
  let allowed = true;
  const revoke = makeHandler({ store, authorize: () => allowed ? { id: 'a' } : null, stream: { pollIntervalMs: 5, heartbeatMs: 10000, lifetimeMs: 3000 } });
  const revocationReader = (await revoke(request('/viewherd/events'))).body.getReader();
  try {
    await revocationReader.read(); allowed = false;
    const error = new TextDecoder().decode((await revocationReader.read()).value); assert.match(error, /event: error/); assert.match(error, /unauthorized/); assert.equal((await revocationReader.read()).done, true);
  } finally { await revocationReader.cancel(); }
});

test('local file adapters share serialization and persist detached sessions across factories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'viewherd-sdk-'));
  try {
    const path = join(directory, 'sessions.json'), a = createFileStore({ path, createState }), b = createFileStore({ path, createState });
    await Promise.all([rpc(makeHandler({ store: a }), command('file-a')), rpc(makeHandler({ store: b }), command('file-b'))]);
    assert.equal((await a.read('session-a')).state.app.count, 2);
    const reloaded = createFileStore({ path, createState }); assert.equal((await reloaded.read('session-a')).state.app.count, 2);
    await reloaded.read('session-b'); const stored = JSON.parse(await readFile(path, 'utf8')); assert.equal(Object.keys(stored.sessions).length, 2);
    await assert.rejects(a.transact('session-a', record => { record.state.app.count = 999; throw new Error('Abort'); }), /Abort/);
    assert.equal((await b.read('session-a')).state.app.count, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('backend controllers share the persisted workspace with HTTP, MCP and SSE', async () => {
  const store = createMemoryStore({ createState });
  const handler = makeHandler({ store, stream: { pollIntervalMs: 5, lifetimeMs: 3000 } });
  const controller = createController({ registry, store, sessionId: 'session-a', principal: { id: 'user:a', actor: 'agent:backend' } });
  const reader = (await handler(request('/viewherd/events'))).body.getReader();
  try {
    await reader.read();
    const initial = await controller.snapshot();
    const schema = await controller.schema();
    assert.equal(initial.app.count, 0);
    assert.ok(schema.panels.some(panel => panel.type === 'counter'));
    const first = await controller.call('panel.action', {
      paneId: 'pane_inbox', action: 'increment', args: { amount: 2 },
    }, { requestId: 'backend-increment', expectedRevision: initial.revision });
    assert.equal(first.state.app.count, 2);
    assert.equal(first.state.events.at(-1).actor, 'agent:backend');
    assert.match(new TextDecoder().decode((await reader.read()).value), /"count":2/);

    const httpState = await (await handler(request('/viewherd/snapshot'))).json();
    assert.equal(httpState.app.count, 2);
    const mcp = await (await handler(request('/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'viewherd_action_counter_increment',
        arguments: { requestId: 'mcp-after-backend', paneId: 'pane_inbox', args: { amount: 3 }, expectedRevision: first.revision },
      },
    }))).json();
    assert.equal(mcp.result.structuredContent.state.app.count, 5);
    assert.equal((await controller.snapshot()).app.count, 5);
    const cached = controller.state;
    cached.app.count = 999;
    assert.equal(controller.state.app.count, 5);
  } finally {
    await reader.cancel();
    controller.destroy();
  }
  assert.equal(controller.state, null);
  await assert.rejects(controller.snapshot(), { code: 'controller_destroyed' });
});

test('backend controller retries bind principal and reject overwriting newer human changes', async () => {
  const store = createMemoryStore({ createState });
  let userId = 'user:a';
  const contexts = [];
  const controller = createController({ registry, store, sessionId: 'session-a', principal(context) {
    contexts.push(context);
    return { id: userId, actor: 'agent:backend', serverTime: Date.now() };
  } });
  const action = { paneId: 'pane_inbox', action: 'increment', args: { amount: 2 } };
  const options = { requestId: 'backend-retry', expectedRevision: 0 };
  const first = await controller.call('panel.action', action, options);
  const retry = await controller.call('panel.action', action, options);
  assert.deepEqual(retry.result, first.result);
  assert.equal(retry.replayed, true);
  assert.equal(retry.state.app.count, 2);
  assert.deepEqual(contexts[0], { sessionId: 'session-a', method: 'panel.action', params: action });
  userId = 'user:b';
  await assert.rejects(controller.call('panel.action', action, options), { code: 'id_conflict', status: 409 });
  userId = 'user:a';
  await assert.rejects(controller.call('panel.action', { ...action, args: { amount: 3 } }, options), { code: 'id_conflict', status: 409 });

  await rpc(makeHandler({ store }), command('human-edit'));
  await assert.rejects(controller.call('panel.action', action, {
    requestId: 'stale-backend', expectedRevision: first.revision,
  }), { code: 'revision_conflict', status: 409 });
  assert.equal((await controller.snapshot()).app.count, 3);
  assert.equal((await store.read('session-a')).receipts.length, 2);
});

test('backend controllers require a valid principal, fixed session and JSON commands before storage access', async () => {
  let storageAccesses = 0;
  const store = {
    kind: 'access-guard',
    read() { storageAccesses++; throw new Error('Unexpected read.'); },
    transact() { storageAccesses++; throw new Error('Unexpected transaction.'); },
  };
  assert.throws(() => createController({ registry, store, sessionId: 'session-a' }), /principal/);
  assert.throws(() => createController({ registry, store, sessionId: '../other', principal: { id: 'user:a' } }), { code: 'invalid_session' });
  assert.throws(() => createController({ registry, store, sessionId: 'session-a', principal: { id: '' } }), { code: 'authorization_error' });
  let getterRan = false;
  const accessorPrincipal = { get id() { getterRan = true; return 'user:a'; } };
  assert.throws(() => createController({ registry, store, sessionId: 'session-a', principal: accessorPrincipal }), { code: 'authorization_error' });
  assert.equal(getterRan, false);
  const cyclic = { id: 'user:a' };
  cyclic.self = cyclic;
  const invalid = createController({ registry, store, sessionId: 'session-a', principal: async () => cyclic });
  await assert.rejects(invalid.snapshot(), { code: 'authorization_error' });
  await assert.rejects(invalid.schema(), { code: 'authorization_error' });
  const denied = createController({ registry, store, sessionId: 'session-a', principal: () => null });
  await assert.rejects(denied.snapshot(), { code: 'unauthorized', status: 401 });
  const valid = createController({ registry, store, sessionId: 'session-a', principal: { id: 'user:a' } });
  await assert.rejects(valid.call('session.snapshot', {}, { sessionId: 'session-b' }), { code: 'invalid_request' });
  await assert.rejects(valid.call('view.update', { paneId: 'pane_inbox', data: { content: 'x'.repeat(300001) } }), { code: 'body_limit', status: 413 });
  await assert.rejects(valid.call('pane.list', { broken: undefined }), { code: 'invalid_request' });
  const invalidHttp = makeHandler({ store, authorize: () => cyclic });
  assert.equal((await invalidHttp(request('/viewherd/snapshot'))).status, 500);
  assert.equal(storageAccesses, 0);
});

test('backend cancellation prevents transactions after asynchronous authentication or queueing', async () => {
  const backing = createMemoryStore({ createState });
  let writes = 0;
  const counted = {
    kind: 'counted', read: backing.read,
    transact(id, transaction) { writes++; return backing.transact(id, transaction); },
  };
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const immediate = createController({ registry, store: counted, sessionId: 'session-a', principal: { id: 'user:a' } });
  await assert.rejects(immediate.call('panel.action', command('unused').params, { signal: alreadyAborted.signal }), { name: 'AbortError' });
  assert.equal(writes, 0);

  let releaseAuthentication;
  let startedAuthentication;
  const ready = new Promise(resolve => { startedAuthentication = resolve; });
  const paused = createController({ registry, store: counted, sessionId: 'session-a', principal: async () => {
    startedAuthentication();
    await new Promise(resolve => { releaseAuthentication = resolve; });
    return { id: 'user:a' };
  } });
  const duringAuthentication = new AbortController();
  const pending = paused.call('panel.action', command('unused').params, { signal: duringAuthentication.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready;
  duringAuthentication.abort();
  releaseAuthentication();
  await rejected;
  assert.equal(writes, 0);

  let releaseQueue;
  let enteredQueue;
  const queued = new Promise(resolve => { enteredQueue = resolve; });
  const delayedStore = {
    kind: 'queue', read: backing.read,
    async transact(id, transaction) {
      enteredQueue();
      await new Promise(resolve => { releaseQueue = resolve; });
      return backing.transact(id, transaction);
    },
  };
  const inQueue = new AbortController();
  const queuedController = createController({ registry, store: delayedStore, sessionId: 'session-a', principal: { id: 'user:a' } });
  const queuedCall = queuedController.call('panel.action', command('unused').params, { signal: inQueue.signal });
  const queueRejected = assert.rejects(queuedCall, { name: 'AbortError' });
  await queued;
  inQueue.abort();
  releaseQueue();
  await queueRejected;
  const record = await backing.read('session-a');
  assert.equal(record.state.app.count, 0);
  assert.equal(record.receipts.length, 0);
});

test('backend cancellation and result limits discard an unfinished action and its retry receipt', async () => {
  let resume;
  let began;
  const ready = new Promise(resolve => { began = resolve; });
  const customRegistry = createRegistry([{ type: 'slow', title: 'Slow', dataSchema: objectSchema({}), actions: {
    wait: { inputSchema: objectSchema({}), async run(ctx) {
      ctx.app.count++;
      began();
      await new Promise(resolve => { resume = resolve; });
      return { count: ctx.app.count };
    } },
    large: { inputSchema: objectSchema({}), run(ctx) {
      ctx.app.count++;
      return { content: 'x'.repeat(160001) };
    } },
  } }]);
  const store = createMemoryStore({ createState: id => createSession({ id, view: 'slow', data: {}, app: { count: 0 }, registry: customRegistry }) });
  const controller = createController({ registry: customRegistry, store, sessionId: 'session-a', principal: { id: 'user:a' } });
  const signal = new AbortController();
  const waiting = controller.call('panel.action', { paneId: 'pane_inbox', action: 'wait', args: {} }, { requestId: 'abort-action', signal: signal.signal });
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  await ready;
  signal.abort();
  resume();
  await rejected;
  await assert.rejects(controller.call('panel.action', { paneId: 'pane_inbox', action: 'large', args: {} }, { requestId: 'large-action' }), { code: 'result_limit', status: 413 });
  const record = await store.read('session-a');
  assert.equal(record.state.app.count, 0);
  assert.equal(record.state.revision, 0);
  assert.equal(record.receipts.length, 0);
});
