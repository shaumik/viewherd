import { createSession, executeCommand } from '@viewherd/core';

const sdkServerReads = new Set(['session.snapshot', 'api.schema', 'workspace.list', 'tab.list', 'pane.list', 'pane.get']);
const sdkServerVersions = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const sdkServerInfo = { name: 'viewherd', version: '0.2.0' };
const sdkServerEncoder = new TextEncoder();
const sdkServerLimits = Object.freeze({ requestBytes: 300000, stateBytes: 900000, receiptCount: 24, receiptBytes: 200000, resultBytes: 160000 });
const sdkServerClone = value => JSON.parse(JSON.stringify(value));
const sdkServerError = (code, message, status) => Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
const sdkServerJson = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
const sdkServerObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sdkServerBytes = value => sdkServerEncoder.encode(JSON.stringify(value)).byteLength;

function sdkServerSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value)) throw sdkServerError('invalid_session', 'sessionId must contain 1–120 letters, digits, dots, underscores, colons or hyphens.', 400);
  return value;
}

function sdkServerCommand(body) {
  if (!sdkServerObject(body) || body.version !== 1) throw sdkServerError('invalid_request', 'A version: 1 command envelope is required.', 400);
  sdkServerSessionId(body.sessionId);
  if (typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 128 || /[\u0000-\u001f\u007f]/.test(body.requestId)) throw sdkServerError('invalid_request', 'requestId must be a non-empty string of at most 128 characters without control characters.', 400);
  if (typeof body.method !== 'string' || !body.method || body.method.length > 80) throw sdkServerError('invalid_request', 'method must be a non-empty string of at most 80 characters.', 400);
  if (body.params !== undefined && !sdkServerObject(body.params)) throw sdkServerError('invalid_request', 'params must be an object.', 400);
  if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)) throw sdkServerError('invalid_request', 'expectedRevision must be a non-negative integer.', 400);
  for (const key of Object.keys(body)) if (!['version', 'requestId', 'sessionId', 'method', 'params', 'expectedRevision'].includes(key)) throw sdkServerError('invalid_request', `Unknown command field: ${key}.`, 400);
  return { ...body, params: body.params ?? {} };
}

function sdkServerCanonical(value, depth = 0) {
  if (depth > 32) throw sdkServerError('invalid_request', 'Command data is nested too deeply.', 400);
  if (Array.isArray(value)) return value.map(item => sdkServerCanonical(item, depth + 1));
  if (sdkServerObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sdkServerCanonical(value[key], depth + 1)]));
  return value;
}

async function sdkServerFingerprint(command, principal) {
  const value = sdkServerCanonical([command.version, command.sessionId, command.method, command.params, command.expectedRevision ?? null, principal.id]);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', sdkServerEncoder.encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sdkServerInitialRecord(createState, sessionId) {
  const state = sdkServerClone(await createState(sessionId));
  if (!sdkServerObject(state) || state.sessionId !== sessionId || !Number.isSafeInteger(state.revision) || state.revision < 0) throw sdkServerError('storage_error', 'createState must return a Viewherd session with the requested sessionId and a non-negative revision.', 503);
  if (sdkServerBytes(state) > sdkServerLimits.stateBytes) throw sdkServerError('state_limit', 'Initial session exceeds the 900 KB state limit.', 413);
  return { state, receipts: [], storageRevision: 0 };
}

function sdkServerValidateStoreOutput(output, original) {
  if (!sdkServerObject(output) || !sdkServerObject(output.record) || typeof output.changed !== 'boolean') throw sdkServerError('storage_error', 'Transaction must return {record, response, changed}.', 503);
  if (output.record.state.sessionId !== original.state.sessionId || !Number.isSafeInteger(output.record.storageRevision) || output.record.storageRevision < 0) throw sdkServerError('storage_error', 'Transaction produced an invalid session record.', 503);
  if (output.changed && output.record.storageRevision !== original.storageRevision + 1) throw sdkServerError('storage_error', 'A stored transaction must advance storageRevision exactly once.', 503);
  if (sdkServerBytes(output.record.state) > sdkServerLimits.stateBytes) throw sdkServerError('state_limit', 'Session exceeds the 900 KB state limit.', 413);
  return output;
}

/** Ephemeral, session-isolated store. All reads and transaction records are detached copies. */
export function createMemoryStore({ createState = id => createSession({ id }), maxSessions = 1000 } = {}) {
  if (typeof createState !== 'function' || !Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new TypeError('createState must be a function and maxSessions a positive integer.');
  const records = new Map(), queues = new Map(), initializing = new Map();
  const serial = (sessionId, run) => {
    const operation = (queues.get(sessionId) ?? Promise.resolve()).then(run);
    const tail = operation.catch(() => {});
    queues.set(sessionId, tail);
    tail.finally(() => { if (queues.get(sessionId) === tail) queues.delete(sessionId); });
    return operation;
  };
  const ensure = async sessionId => {
    if (!records.has(sessionId)) {
      if (!initializing.has(sessionId)) {
        if (records.size + initializing.size >= maxSessions) throw sdkServerError('session_limit', 'Memory store session limit reached.', 503);
        initializing.set(sessionId, sdkServerInitialRecord(createState, sessionId));
      }
      try { records.set(sessionId, await initializing.get(sessionId)); }
      finally { initializing.delete(sessionId); }
    }
    return records.get(sessionId);
  };
  return {
    kind: 'memory',
    read(sessionId) { sdkServerSessionId(sessionId); return serial(sessionId, async () => sdkServerClone(await ensure(sessionId))); },
    transact(sessionId, transaction) {
      sdkServerSessionId(sessionId);
      if (typeof transaction !== 'function') throw new TypeError('transaction must be a function.');
      return serial(sessionId, async () => {
        const original = await ensure(sessionId);
        const output = sdkServerValidateStoreOutput(await transaction(sdkServerClone(original)), original);
        if (output.changed) records.set(sessionId, sdkServerClone(output.record));
        return sdkServerClone(output.response);
      });
    }
  };
}

/** D1 compare-and-swap adapter; uses the existing webdr_sessions migration. */
export function createD1Store(db, { createState = id => createSession({ id }), retries = 6 } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof createState !== 'function' || !Number.isSafeInteger(retries) || retries < 1 || retries > 20) throw new TypeError('D1 database, createState function and 1–20 retries are required.');
  const read = async sessionId => {
    sdkServerSessionId(sessionId);
    const id = `sdk:${sessionId}`;
    let row = await db.prepare('SELECT payload FROM webdr_sessions WHERE id = ?').bind(id).first();
    if (!row) {
      const record = await sdkServerInitialRecord(createState, sessionId);
      await db.prepare('INSERT OR IGNORE INTO webdr_sessions (id,revision,payload,updated_at) VALUES (?,?,?,?)').bind(id, record.storageRevision, JSON.stringify(record), Date.now()).run();
      row = await db.prepare('SELECT payload FROM webdr_sessions WHERE id = ?').bind(id).first();
    }
    if (!row) throw sdkServerError('storage_error', 'Unable to initialize the requested session.', 503);
    const record = JSON.parse(row.payload);
    if (record.state.sessionId !== sessionId || !Number.isSafeInteger(record.storageRevision) || !Array.isArray(record.receipts)) throw sdkServerError('storage_error', 'Invalid stored session record.', 503);
    return record;
  };
  return {
    kind: 'cloudflare-d1', read,
    async transact(sessionId, transaction) {
      sdkServerSessionId(sessionId);
      if (typeof transaction !== 'function') throw new TypeError('transaction must be a function.');
      for (let attempt = 0; attempt < retries; attempt++) {
        const original = await read(sessionId);
        const output = sdkServerValidateStoreOutput(await transaction(sdkServerClone(original)), original);
        if (!output.changed) return sdkServerClone(output.response);
        const result = await db.prepare('UPDATE webdr_sessions SET revision = ?, payload = ?, updated_at = ? WHERE id = ? AND revision = ?').bind(output.record.storageRevision, JSON.stringify(output.record), Date.now(), `sdk:${sessionId}`, original.storageRevision).run();
        if (result.meta?.changes === 1) return sdkServerClone(output.response);
      }
      throw sdkServerError('revision_conflict', 'Session is busy. Refresh and retry with a new requestId.', 409);
    }
  };
}

async function sdkServerReadBody(request) {
  const length = request.headers.get('content-length');
  if (length && Number(length) > sdkServerLimits.requestBytes) throw sdkServerError('body_limit', 'Request body exceeds 300 KB.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw sdkServerError('invalid_request', 'Request body is required.', 400);
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > sdkServerLimits.requestBytes) { await reader.cancel(); throw sdkServerError('body_limit', 'Request body exceeds 300 KB.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { throw sdkServerError('invalid_json', 'Request body must be valid UTF-8 JSON.', 400); }
}

function sdkServerStatus(error) {
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 600) return error.status;
  const code = String(error.code ?? '').toLowerCase();
  if (code === 'unauthorized') return 401;
  if (code === 'forbidden' || code === 'origin_rejected') return 403;
  if (code === 'revision_conflict' || code === 'id_conflict') return 409;
  if (code === 'not_found') return 404;
  if (code === 'body_limit' || code === 'state_limit' || code === 'result_limit') return 413;
  if (code === 'storage_error' || code === 'storage_unavailable' || code === 'session_limit') return 503;
  return error.code ? 400 : 500;
}

function sdkServerPublicError(error) {
  return { code: String(error.code ?? 'internal_error').toLowerCase(), message: error.code ? error.message : 'The server could not complete this request.' };
}

async function sdkServerAuthorize(authorize, request, context) {
  let principal;
  try { principal = await authorize(request, context); }
  catch (error) {
    if (error.code === 'forbidden' || error.status === 403) throw sdkServerError('forbidden', error.message || 'Access to this session is denied.', 403);
    if (error.code === 'unauthorized' || error.status === 401) throw sdkServerError('unauthorized', error.message || 'Authentication is required.', 401);
    throw sdkServerError('authorization_error', 'Host authorization failed.', 500);
  }
  if (principal === null || principal === undefined || principal === false) throw sdkServerError('unauthorized', 'Authentication is required.', 401);
  if (!sdkServerObject(principal) || typeof principal.id !== 'string' || !principal.id.trim() || principal.id.length > 120 || (principal.actor !== undefined && (typeof principal.actor !== 'string' || !principal.actor.trim() || principal.actor.length > 120))) throw sdkServerError('authorization_error', 'Host authorize must return an authenticated principal with a string id of at most 120 characters.', 500);
  return principal;
}

async function sdkServerApply(record, command, registry, principal, targetType) {
  const hash = await sdkServerFingerprint(command, principal);
  const cached = record.receipts.find(receipt => receipt.requestId === command.requestId);
  if (cached) {
    if (cached.hash !== hash) throw sdkServerError('id_conflict', 'requestId was already used by another principal or for a different command.', 409);
    return { record, changed: false, response: { version: 1, requestId: command.requestId, sessionId: command.sessionId, result: cached.result, revision: record.state.revision, state: record.state, replayed: true } };
  }
  if (command.expectedRevision !== undefined && command.expectedRevision !== record.state.revision) throw sdkServerError('revision_conflict', 'Session changed. Refresh and retry with a new requestId.', 409);
  if (targetType && record.state.panes[command.params.paneId]?.view !== targetType) throw sdkServerError('invalid_target', `This action requires a ${targetType} pane.`, 400);
  const output = await executeCommand(record.state, command, { registry, principal });
  const remember = !sdkServerReads.has(command.method);
  let receipts = record.receipts;
  if (remember) {
    if (sdkServerBytes(output.result) > sdkServerLimits.resultBytes) throw sdkServerError('result_limit', 'Action result exceeds the 160 KB retry-receipt limit.', 413);
    receipts = [...receipts, { requestId: command.requestId, hash, result: output.result }].slice(-sdkServerLimits.receiptCount);
    while (sdkServerBytes(receipts) > sdkServerLimits.receiptBytes) receipts.shift();
  }
  const storageChanged = output.changed || remember;
  return {
    record: { state: output.state, receipts, storageRevision: record.storageRevision + (storageChanged ? 1 : 0) },
    changed: storageChanged,
    response: { version: 1, requestId: command.requestId, sessionId: command.sessionId, result: output.result, revision: output.state.revision, state: output.state }
  };
}

function sdkServerMcpTools(registry, fixedSessionId) {
  const session = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$', description: 'Authorized application session.' };
  const base = { sessionId: session };
  const requiredSession = fixedSessionId ? [] : ['sessionId'];
  const tools = [
    { name: 'viewherd_snapshot', description: 'Read the authoritative application session, panel graph and application data.', inputSchema: { type: 'object', properties: base, required: requiredSession, additionalProperties: false } },
    { name: 'viewherd_schema', description: 'Discover workspace operations and registered application panel actions with JSON schemas.', inputSchema: { type: 'object', properties: base, required: requiredSession, additionalProperties: false } },
    { name: 'viewherd_call', description: 'Execute one Viewherd command. Supply a stable requestId for retries and expectedRevision to protect human changes. Actions update the same state shown in the web application.', inputSchema: { type: 'object', properties: { ...base, requestId: { type: 'string', minLength: 1, maxLength: 128 }, method: { type: 'string' }, params: { type: 'object' }, expectedRevision: { type: 'integer', minimum: 0 } }, required: [...requiredSession, 'requestId', 'method'], additionalProperties: false } }
  ];
  const actions = new Map();
  for (const panel of registry.schema()) for (const action of panel.actions) {
    const prefix = `viewherd_action_${panel.type}_${action.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56);
    let name = prefix, suffix = 2;
    while (actions.has(name)) name = `${prefix}_${suffix++}`;
    actions.set(name, { type: panel.type, action: action.name });
    tools.push({ name, description: `${panel.title}: ${action.description || action.name}. Executes against an existing ${panel.type} pane.`, inputSchema: { type: 'object', properties: { ...base, requestId: { type: 'string', minLength: 1, maxLength: 128 }, paneId: { type: 'string', minLength: 1 }, args: action.inputSchema, expectedRevision: { type: 'integer', minimum: 0 } }, required: [...requiredSession, 'requestId', 'paneId', 'args'], additionalProperties: false } });
  }
  return { tools, actions };
}

function sdkServerMcpHeader(value) {
  if (value === null) return null;
  if (value.startsWith('=?base64?') && value.endsWith('?=')) {
    const encoded = value.slice(9, -2);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw sdkServerError('header_mismatch', 'Malformed Base64 MCP header.', 400);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0))); }
    catch { throw sdkServerError('header_mismatch', 'Malformed Base64 MCP header.', 400); }
  }
  if (!/^[\x20-\x7e\t]*$/.test(value) || value !== value.trim()) throw sdkServerError('header_mismatch', 'Malformed MCP header.', 400);
  return value;
}

function sdkServerToolArguments(args, tool) {
  const schema = tool.inputSchema;
  const invalid = message => { throw Object.assign(sdkServerError('invalid_params', message, 400), { rpcCode: -32602 }); };
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) invalid(`Tool argument ${key} is required.`);
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property) invalid(`Unknown tool argument: ${key}.`);
    if (property.type === 'object' && !sdkServerObject(value)) invalid(`Tool argument ${key} must be an object.`);
    if (property.type === 'string' && typeof value !== 'string') invalid(`Tool argument ${key} must be a string.`);
    if (property.type === 'integer' && (!Number.isSafeInteger(value) || (property.minimum !== undefined && value < property.minimum))) invalid(`Tool argument ${key} must be a non-negative safe integer.`);
    if (typeof value === 'string' && ((property.minLength !== undefined && value.length < property.minLength) || (property.maxLength !== undefined && value.length > property.maxLength) || (property.pattern !== undefined && !new RegExp(property.pattern).test(value)))) invalid(`Tool argument ${key} does not match its declared schema.`);
  }
}

function sdkServerMcpEra(request, body) {
  const meta = body.params?._meta;
  const claimed = sdkServerObject(meta) && Object.keys(meta).some(key => key.startsWith('io.modelcontextprotocol/'));
  const header = request.headers.get('mcp-protocol-version');
  const modern = claimed || (header !== null && !header.startsWith('2025-'));
  if (!modern) {
    // Initialization proposes a revision; the legacy handshake may select another supported legacy revision.
    const version = body.method === 'initialize' ? header : header ?? '2025-03-26';
    if (version && !sdkServerVersions.includes(version)) throw Object.assign(sdkServerError('unsupported_protocol', 'Unsupported protocol version.', 400), { rpcCode: -32022, data: { supported: sdkServerVersions, requested: version } });
    return false;
  }
  if (!sdkServerObject(meta) || typeof meta['io.modelcontextprotocol/protocolVersion'] !== 'string' || !sdkServerObject(meta['io.modelcontextprotocol/clientCapabilities'])) throw Object.assign(sdkServerError('invalid_params', 'Modern MCP requests require protocolVersion and clientCapabilities in params._meta.', 400), { rpcCode: -32602 });
  const version = meta['io.modelcontextprotocol/protocolVersion'];
  if (!header || header !== version || request.headers.get('mcp-method') !== body.method) throw Object.assign(sdkServerError('header_mismatch', 'MCP protocol and method headers must match the request body.', 400), { rpcCode: -32020 });
  if (body.method === 'tools/call' && sdkServerMcpHeader(request.headers.get('mcp-name')) !== body.params?.name) throw Object.assign(sdkServerError('header_mismatch', 'Mcp-Name must match params.name.', 400), { rpcCode: -32020 });
  if (version !== '2026-07-28') throw Object.assign(sdkServerError('unsupported_protocol', 'Unsupported modern protocol version.', 400), { rpcCode: -32022, data: { supported: sdkServerVersions, requested: version } });
  return true;
}

function sdkServerStream(request, initial, { sessionId, store, authorize, pollIntervalMs, lifetimeMs, heartbeatMs }) {
  let timer, lifetime, controller, stopped = false, cursor = initial.state.revision, lastHeartbeat = Date.now();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer); clearTimeout(lifetime);
    request.signal.removeEventListener('abort', abort);
    try { controller?.close(); } catch {}
  };
  const abort = () => stop();
  const write = (event, data, revision) => {
    if (stopped) return;
    try { controller.enqueue(sdkServerEncoder.encode(`${revision === undefined ? '' : `id: ${revision}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
    catch { stop(); }
  };
  const snapshot = (state, event) => write(event, { sessionId, revision: state.revision, state }, state.revision);
  const poll = async () => {
    if (stopped) return;
    try {
      await sdkServerAuthorize(authorize, request, { sessionId, method: 'session.snapshot', params: {} });
      if (stopped) return;
      const record = await store.read(sessionId);
      if (stopped) return;
      if (record.state.revision > cursor && controller.desiredSize > 0) { snapshot(record.state, 'state.changed'); if (!stopped) cursor = record.state.revision; }
      if (Date.now() - lastHeartbeat >= heartbeatMs && controller.desiredSize > 0) { controller.enqueue(sdkServerEncoder.encode(': keep-alive\n\n')); lastHeartbeat = Date.now(); }
    } catch (error) { write('error', { sessionId, error: sdkServerPublicError(error) }); stop(); }
    if (!stopped) timer = setTimeout(poll, pollIntervalMs);
  };
  const stream = new ReadableStream({
    start(target) {
      controller = target;
      if (request.signal.aborted) { stop(); return; }
      request.signal.addEventListener('abort', abort, { once: true });
      const header = request.headers.get('last-event-id');
      const previous = header !== null && /^\d+$/.test(header) ? Number(header) : null;
      const firstRevision = initial.state.events?.[0]?.revision;
      if (previous !== null && (previous > cursor || (firstRevision !== undefined && previous < firstRevision - 1))) write('resync_required', { sessionId, revision: cursor, reason: 'The cursor is outside retained history.' });
      snapshot(initial.state, 'snapshot');
      lifetime = setTimeout(stop, lifetimeMs);
      timer = setTimeout(poll, pollIntervalMs);
    },
    cancel() { stop(); }
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' } });
}

/** Web-standard Request -> Response handler. Authentication and session access are mandatory host responsibilities. */
export function createViewherdHandler({ registry, store, authorize, basePath = '/viewherd', mcpPath = '/mcp', sessionId: fixedSessionId, trustedMcpOrigin = false, stream = {} } = {}) {
  if (!registry || typeof registry.schema !== 'function' || typeof registry.get !== 'function' || !store || typeof store.read !== 'function' || typeof store.transact !== 'function' || typeof authorize !== 'function') throw new TypeError('registry, store and authorize(request, context) are required.');
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.randomUUID !== 'function') throw new TypeError('Web Crypto is required. In Node 18, assign globalThis.crypto from node:crypto webcrypto before creating the handler.');
  if (fixedSessionId !== undefined) sdkServerSessionId(fixedSessionId);
  if (typeof basePath !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath) || typeof mcpPath !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(mcpPath) || mcpPath === basePath) throw new TypeError('basePath and mcpPath must be distinct absolute route paths without a trailing slash.');
  if (typeof trustedMcpOrigin !== 'boolean') throw new TypeError('trustedMcpOrigin must be a boolean.');
  const polling = { pollIntervalMs: stream.pollIntervalMs ?? 900, lifetimeMs: stream.lifetimeMs ?? 25000, heartbeatMs: stream.heartbeatMs ?? 10000 };
  for (const [key, value] of Object.entries(polling)) if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${key} must be a positive number.`);
  if (polling.lifetimeMs > 60000) throw new TypeError('Stream lifetime must be at most 60 seconds.');
  const { tools, actions } = sdkServerMcpTools(registry, fixedSessionId);
  const resolveSession = value => {
    const resolved = sdkServerSessionId(value ?? fixedSessionId);
    if (fixedSessionId && resolved !== fixedSessionId) throw sdkServerError('forbidden', 'This handler is restricted to its configured session.', 403);
    return resolved;
  };
  const dispatch = async (request, raw, targetType) => {
    const command = sdkServerCommand(raw);
    resolveSession(command.sessionId);
    const principal = await sdkServerAuthorize(authorize, request, { sessionId: command.sessionId, method: command.method, params: command.params });
    return store.transact(command.sessionId, record => sdkServerApply(record, command, registry, principal, targetType));
  };
  const read = async (request, sessionId, method) => {
    const principal = await sdkServerAuthorize(authorize, request, { sessionId, method, params: {} });
    const record = await store.read(sessionId);
    if (method === 'api.schema') return (await executeCommand(record.state, { version: 1, requestId: `schema:${globalThis.crypto.randomUUID()}`, sessionId, method, params: {} }, { registry, principal })).result;
    return record.state;
  };
  const mcp = async request => {
    let body, modern = false;
    const respond = (result, status = 200) => sdkServerJson({ jsonrpc: '2.0', id: body.id, result: modern ? { ...result, resultType: 'complete', _meta: { ...result._meta, 'io.modelcontextprotocol/serverInfo': sdkServerInfo } } : result }, status);
    try {
      body = await sdkServerReadBody(request);
      if (!sdkServerObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || (body.params !== undefined && !sdkServerObject(body.params)) || (body.id !== undefined && typeof body.id !== 'string' && !Number.isSafeInteger(body.id))) throw Object.assign(sdkServerError('invalid_request', 'A single valid JSON-RPC request is required.', 400), { rpcCode: -32600 });
      modern = sdkServerMcpEra(request, body);
      const args = body.params?.arguments ?? {};
      if (body.method === 'tools/call' && !sdkServerObject(args)) throw Object.assign(sdkServerError('invalid_params', 'Tool arguments must be an object.', 400), { rpcCode: -32602 });
      const sessionId = resolveSession(args.sessionId ?? new URL(request.url).searchParams.get('sessionId') ?? fixedSessionId);
      await sdkServerAuthorize(authorize, request, { sessionId, method: body.method, params: body.params ?? {} });
      if (body.id === undefined) {
        if (!modern && body.method === 'notifications/initialized') return new Response(null, { status: 202 });
        throw Object.assign(sdkServerError('method_not_found', 'Unsupported notification.', 400), { rpcCode: -32601 });
      }
      if (body.method === 'server/discover') return respond({ supportedVersions: sdkServerVersions, capabilities: { tools: {} }, instructions: 'Read viewherd_schema to discover application actions. Commands require stable requestIds; expectedRevision protects human edits.', ...(modern ? { ttlMs: 0, cacheScope: 'private' } : {}) });
      if (body.method === 'initialize' && !modern) {
        const requested = body.params?.protocolVersion;
        const version = sdkServerVersions.includes(requested) && requested !== '2026-07-28' ? requested : '2025-11-25';
        return respond({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: sdkServerInfo });
      }
      if (body.method === 'ping') return respond({});
      if (body.method === 'tools/list') return respond({ tools, ...(modern ? { ttlMs: 0, cacheScope: 'private' } : {}) });
      if (body.method !== 'tools/call') throw Object.assign(sdkServerError('method_not_found', 'MCP method not found.', 404), { rpcCode: -32601 });
      try {
        const tool = tools.find(item => item.name === body.params.name);
        if (!tool) throw Object.assign(sdkServerError('unknown_tool', 'Unknown Viewherd tool.', 400), { rpcCode: -32602 });
        sdkServerToolArguments(args, tool);
        let result;
        if (body.params.name === 'viewherd_snapshot') result = await read(request, sessionId, 'session.snapshot');
        else if (body.params.name === 'viewherd_schema') result = await read(request, sessionId, 'api.schema');
        else if (body.params.name === 'viewherd_call') result = await dispatch(request, { version: 1, sessionId, requestId: args.requestId, method: args.method, params: args.params ?? {}, ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }) });
        else if (actions.has(body.params.name)) {
          const action = actions.get(body.params.name);
          result = await dispatch(request, { version: 1, sessionId, requestId: args.requestId, method: 'panel.action', params: { paneId: args.paneId, action: action.action, args: args.args ?? {} }, ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }) }, action.type);
        } else throw Object.assign(sdkServerError('unknown_tool', 'Unknown Viewherd tool.', 400), { rpcCode: -32602 });
        return respond({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
      } catch (error) {
        if ([401, 403, 500, 503].includes(sdkServerStatus(error)) || error.rpcCode) throw error;
        return respond({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: sdkServerPublicError(error) }) }], structuredContent: { error: sdkServerPublicError(error) } });
      }
    } catch (error) {
      return sdkServerJson({ jsonrpc: '2.0', ...(body && body.id !== undefined ? { id: body.id } : {}), error: { code: error.rpcCode ?? (error.code === 'invalid_json' ? -32700 : -32603), message: sdkServerPublicError(error).message, ...(error.data === undefined ? {} : { data: error.data }) } }, sdkServerStatus(error));
    }
  };
  return async request => {
    let command;
    const url = new URL(request.url);
    try {
      const known = [`${basePath}/snapshot`, `${basePath}/schema`, `${basePath}/events`, `${basePath}/rpc`, mcpPath].includes(url.pathname);
      if (!known) return sdkServerJson({ version: 1, error: { code: 'not_found', message: 'Route not found.' } }, 404);
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin && !(url.pathname === mcpPath && trustedMcpOrigin)) throw sdkServerError('origin_rejected', 'Use the same origin as this Viewherd handler.', 403);
      if (url.pathname === mcpPath) {
        if (request.method !== 'POST') return sdkServerJson({ error: { code: 'method_not_allowed', message: 'MCP uses POST.' } }, 405, { allow: 'POST' });
        return mcp(request);
      }
      if (url.pathname === `${basePath}/rpc`) {
        if (request.method !== 'POST') throw sdkServerError('method_not_allowed', 'RPC uses POST.', 405);
        command = await sdkServerReadBody(request);
        return sdkServerJson(await dispatch(request, command));
      }
      if (request.method !== 'GET') throw sdkServerError('method_not_allowed', 'This route uses GET.', 405);
      const sessionId = resolveSession(url.searchParams.get('sessionId') ?? fixedSessionId);
      if (url.pathname === `${basePath}/snapshot`) return sdkServerJson(await read(request, sessionId, 'session.snapshot'));
      if (url.pathname === `${basePath}/schema`) return sdkServerJson(await read(request, sessionId, 'api.schema'));
      await sdkServerAuthorize(authorize, request, { sessionId, method: 'session.snapshot', params: {} });
      const initial = await store.read(sessionId);
      return sdkServerStream(request, initial, { sessionId, store, authorize, ...polling });
    } catch (error) {
      const status = sdkServerStatus(error);
      const envelope = { version: 1, requestId: typeof command?.requestId === 'string' ? command.requestId : null, sessionId: typeof command?.sessionId === 'string' ? command.sessionId : url.searchParams.get('sessionId') ?? fixedSessionId ?? null, error: sdkServerPublicError(error) };
      if (status === 409 && command?.sessionId) {
        // Conflict state is returned only after dispatch authenticated the exact session.
        try {
          await sdkServerAuthorize(authorize, request, { sessionId: resolveSession(command.sessionId), method: command.method, params: command.params ?? {} });
          envelope.state = (await store.read(command.sessionId)).state;
        } catch {}
      }
      return sdkServerJson(envelope, status);
    }
  };
}

/** Compatibility alias; new applications should use createViewherdHandler. */
export { createViewherdHandler as createWebdrHandler };
