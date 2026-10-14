/** Server-side chat orchestration. UI changes always go through the Viewherd SDK. */
const studioAgentActions = new Set(['createDirections', 'refine', 'select', 'compare', 'inspect', 'export', 'remove', 'reset']);
const assistantEncoder = new TextEncoder();
const assistantOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const assistantObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const assistantFail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const assistantJson = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

function assistantError(error) {
  if (error?.code === 'revision_conflict') return 'The design changed while I was working. Your newer edit is safe. Send the request again to continue.';
  if (error?.code === 'agent_cancelled') return 'This request was cancelled because the studio changed. Send a new message to continue.';
  if (error?.code === 'assistant_timeout') return 'This request took too long. The changes already completed are saved.';
  if (error?.name === 'AbortError' || error?.code === 'assistant_cancelled') return 'This request was interrupted. The changes already completed are saved.';
  if (error?.code === 'agent_credentials') return 'The model connection is not configured. Ask the app owner to check the server settings.';
  if (error?.code === 'agent_rate_limit') return 'The model is busy. Try again in a moment; completed changes are saved.';
  if (['agent_unavailable', 'agent_response', 'agent_limit'].includes(error?.code)) return 'The model could not finish this request. The changes already completed are saved.';
  if (typeof error?.message === 'string' && ['schema_validation', 'design_not_found', 'last_design', 'turn_in_progress', 'turn_conflict', 'unsupported_action', 'tool_limit', 'invalid_reply'].includes(error.code)) return error.message.slice(0, 600);
  return 'I could not finish this request. The changes already completed are saved.';
}

function assistantStatus(error) {
  if (['turn_in_progress', 'turn_conflict', 'request_conflict', 'revision_conflict', 'agent_cancelled'].includes(error?.code)) return 409;
  if (error?.code === 'unauthorized') return 401;
  if (['forbidden', 'agent_forbidden'].includes(error?.code)) return 403;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  return 400;
}

function assistantCheckOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw assistantFail('forbidden', 'Use the assistant from this app.', 403);
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw assistantFail('forbidden', 'Use the assistant from this app.', 403);
}

async function assistantBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw assistantFail('content_type', 'Send a JSON message.', 415);
  if (Number(request.headers.get('content-length') || 0) > 12000) throw assistantFail('body_too_large', 'Keep the message under 2,000 characters.', 413);
  if (!request.body) throw assistantFail('invalid_message', 'Write a message first.');
  const reader = request.body.getReader();
  const abortRead = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener('abort', abortRead, { once: true });
  let bytes = 0, chunks = [];
  try {
    while (true) {
      if (request.signal.aborted) throw assistantFail('assistant_cancelled', 'The request was cancelled.');
      const { value, done } = await reader.read();
      if (request.signal.aborted) throw assistantFail('assistant_cancelled', 'The request was cancelled.');
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 12000) throw assistantFail('body_too_large', 'Keep the message under 2,000 characters.', 413);
      chunks.push(value);
    }
  } finally {
    request.signal.removeEventListener('abort', abortRead);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw assistantFail('invalid_json', 'Send a valid JSON message.'); }
  if (!assistantObject(value) || Object.keys(value).some(key => !['requestId', 'message'].includes(key))) throw assistantFail('invalid_message', 'Send only requestId and message.');
  if (typeof value.requestId !== 'string' || !value.requestId.trim() || value.requestId.length > 80 || /[\u0000-\u001f\u007f]/.test(value.requestId)) throw assistantFail('invalid_message', 'Supply a requestId of 1–80 characters.');
  if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 2000 || /[\u0000\u000b\u000c\u007f]/.test(value.message)) throw assistantFail('invalid_message', 'Write a message of 1–2,000 characters.');
  return { requestId: value.requestId, message: value.message.trim() };
}

function assistantController(state) {
  const pane = Object.values(state.panes ?? {}).find(item => item.view === 'studio');
  if (!pane) throw assistantFail('studio_not_found', 'Open the studio panel first.');
  return pane.id;
}

/** Keep photos, identity, authorization and raw export files out of model context. */
export function projectStudioSnapshot(state) {
  const app = state.app ?? {};
  return {
    sessionId: state.sessionId, revision: state.revision, selectedDesignId: app.selectedDesignId,
    designs: Object.values(app.designs ?? {}).map(design => Object.fromEntries(['id', 'name', 'format', 'theme', 'headline', 'subhead', 'eyebrow', 'cta'].filter(key => assistantOwn(design, key)).map(key => [key, design[key]]))),
    panels: Object.values(state.panes ?? {}).map(pane => ({ id: pane.id, type: pane.view, title: pane.title, ...(typeof pane.data?.designId === 'string' ? { designId: pane.data.designId } : {}) })),
    asset: { name: app.asset?.name ?? 'Product photo' },
    lastExport: app.lastExport ? { filename: app.lastExport.filename, designId: app.lastExport.designId, width: app.lastExport.width, height: app.lastExport.height } : null,
  };
}

function assistantPublicTurn(turn) {
  return { id: turn.id, message: turn.message, mode: turn.mode, status: turn.status, reply: turn.reply || '', steps: (turn.steps || []).map(step => ({ ...step })), expiresAt: turn.expiresAt };
}
function assistantSmallResult(value, depth = 0) {
  if (depth > 6) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.startsWith('data:') ? '[image omitted]' : value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 32).map(item => assistantSmallResult(item, depth + 1));
  if (assistantObject(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !['svg', 'src', 'asset', 'dataURL', 'state', 'ownerId', 'principal', 'authorization'].includes(key)).slice(0, 32).map(([key, item]) => [key, assistantSmallResult(item, depth + 1)]));
  return null;
}
function assistantReplay(turn, mode) {
  const events = [{ type: 'start', turnId: turn.id, mode, replayed: true }];
  if (turn.reply) events.push({ type: 'text', text: turn.reply });
  for (const step of turn.steps || []) events.push({ type: 'tool', step });
  events.push({ type: 'done', turn: assistantPublicTurn(turn) });
  return new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

/** agent is a server adapter. clientFor must authenticate and bind a trusted principal. */
export function createStudioAssistantHandler({ clientFor, agent }) {
  if (typeof clientFor !== 'function' || typeof agent?.run !== 'function' || !['demo', 'openai'].includes(agent.mode)) throw new TypeError('Supply an authenticated SDK client factory and an agent adapter.');
  return async request => {
    let client, principal, input;
    try {
      assistantCheckOrigin(request);
      if (!['GET', 'POST'].includes(request.method)) return assistantJson({ error: { code: 'method_not_allowed', message: 'Use GET or POST.' } }, 405, { allow: 'GET, POST' });
      if (request.method === 'POST') input = await assistantBody(request);
      ({ client, principal } = await clientFor(request, { turnId: input?.requestId }));
      if (!client || typeof client.snapshot !== 'function' || typeof client.call !== 'function' || typeof principal?.id !== 'string' || !principal.id) throw assistantFail('forbidden', 'An authenticated studio user is required.', 403);
      const state = await client.snapshot();
      if (request.method === 'GET') {
        client.destroy?.();
        return assistantJson({ mode: agent.mode, ...(agent.model ? { model: agent.model } : {}), streaming: true });
      }
      if (request.signal.aborted) throw assistantFail('assistant_cancelled', 'The request was cancelled.');
      const existing = (state.app?.chat?.turns || []).find(turn => turn.id === input.requestId);
      if (existing) {
        if (existing.ownerId !== principal.id || existing.message !== input.message) throw assistantFail('turn_conflict', 'This requestId was already used for a different message.', 409);
        if (existing.status === 'running') {
          if (existing.expiresAt > Date.now()) throw assistantFail('turn_in_progress', 'This message is already running. Wait for it to finish.', 409);
          const expired = await client.call('panel.action', { paneId: assistantController(state), action: 'finishTurn', args: { turnId: input.requestId, status: 'failed', reply: existing.reply || 'This request expired. Send a new message to continue.' } }, { requestId: `chat:${input.requestId}:expire` });
          client.destroy?.();
          return assistantReplay(expired.result.turn, existing.mode);
        }
        client.destroy?.();
        return assistantReplay(existing, existing.mode);
      }
      const start = await client.call('panel.action', { paneId: assistantController(state), action: 'beginTurn', args: { turnId: input.requestId, message: input.message, mode: agent.mode, expiresAt: Date.now() + 120000 } }, { requestId: `chat:${input.requestId}:begin` });
      const turn = start.result?.turn;
      if (!turn) throw assistantFail('invalid_response', 'The studio did not start this request.');
      if (start.result.replayed) {
        if (turn.status === 'running') throw assistantFail('turn_in_progress', 'This message is already running. Wait for it to finish.', 409);
        client.destroy?.();
        return assistantReplay(turn, turn.mode);
      }
      const history = (start.state.app?.chat?.turns || []).filter(item => item.id !== turn.id && item.status !== 'running').slice(-12).map(assistantPublicTurn);
      return assistantStream({ request, client, agent, input, history, initialRevision: start.revision });
    } catch (error) {
      client?.destroy?.();
      const publicCodes = ['forbidden', 'unauthorized', 'agent_forbidden', 'content_type', 'body_too_large', 'invalid_message', 'invalid_json', 'assistant_cancelled', 'turn_conflict', 'turn_in_progress', 'request_conflict', 'revision_conflict', 'agent_cancelled'];
      const safe = publicCodes.includes(error?.code);
      return assistantJson({ error: { code: safe ? error.code : 'assistant_error', message: safe && typeof error?.message === 'string' ? error.message.slice(0, 600) : 'The assistant is unavailable.' } }, assistantStatus(error));
    }
  };
}

function assistantStream({ request, client, agent, input, history, initialRevision }) {
  const aborter = new AbortController();
  let streamController, closed = false, timer, text = '', toolCount = 0, toolRunning = false;
  let observedRevision = initialRevision;
  const verifiedSteps = new Map();
  const send = event => {
    if (closed) return;
    try { streamController.enqueue(assistantEncoder.encode(JSON.stringify(event) + '\n')); }
    catch { closed = true; aborter.abort(assistantFail('assistant_cancelled', 'The request was interrupted.')); }
  };
  const stop = reason => {
    if (!aborter.signal.aborted) aborter.abort(reason || assistantFail('assistant_cancelled', 'The request was interrupted.'));
  };
  const disconnect = () => stop(assistantFail('assistant_cancelled', 'The request was interrupted.'));
  const alive = () => { if (aborter.signal.aborted) throw aborter.signal.reason || assistantFail('assistant_cancelled', 'The request was interrupted.'); };
  const persist = async (action, args, suffix, expectedRevision) => {
    const state = await client.snapshot();
    return client.call('panel.action', { paneId: assistantController(state), action, args: { turnId: input.requestId, ...args } }, { requestId: `chat:${input.requestId}:${suffix}`, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  };
  const emit = event => {
    alive();
    if (!assistantObject(event) || event.type !== 'text' || typeof event.text !== 'string') throw assistantFail('invalid_reply', 'The assistant returned an invalid message.');
    if (text.length + event.text.length > 4000) throw assistantFail('invalid_reply', 'The assistant reply was too long.');
    text += event.text;
    if (event.text) send({ type: 'text', text: event.text });
  };
  const call = async command => {
    alive();
    if (!assistantObject(command) || !studioAgentActions.has(command.action) || !assistantObject(command.args ?? {}) || Object.keys(command).some(key => !['action', 'args', 'label'].includes(key))) throw assistantFail('unsupported_action', 'That action is not available in this studio.');
    if (toolRunning) throw assistantFail('unsupported_action', 'Studio actions must run one at a time.');
    if (++toolCount > 10) throw assistantFail('tool_limit', 'This request needs more than ten actions. Ask for the next step in another message.');
    const id = `step_${toolCount}`;
    const label = typeof command.label === 'string' && command.label.trim() ? command.label.trim().slice(0, 120) : command.action;
    const step = { id, label, status: 'running', action: command.action };
    verifiedSteps.set(id, step);
    let completed = false;
    toolRunning = true;
    try {
      const before = await client.snapshot();
      if (before.revision !== observedRevision) throw assistantFail('revision_conflict', 'The studio changed after the agent read it.', 409);
      const started = await persist('updateTurn', { reply: text, step }, `${id}:running`, observedRevision);
      alive();
      send({ type: 'tool', step });
      const state = await client.snapshot();
      alive();
      if (state.revision !== started.revision) throw assistantFail('revision_conflict', 'The studio changed while this action was starting.', 409);
      const result = await client.call('panel.action', { paneId: assistantController(state), action: command.action, args: command.args || {} }, { requestId: `chat:${input.requestId}:${id}:action`, expectedRevision: state.revision, signal: aborter.signal });
      const done = { ...step, status: 'done', revision: result.revision };
      completed = true;
      verifiedSteps.set(id, done);
      send({ type: 'tool', step: done });
      // A completed action stays completed even if the reader disconnects just after it.
      const recorded = await persist('updateTurn', { reply: text, step: done }, `${id}:done`);
      // Metadata is our own revision. Any extra revision belongs to another writer:
      // require the agent to read that writer's state before its next mutation.
      observedRevision = recorded.revision === result.revision + 1 ? recorded.revision : result.revision;
      alive();
      return { revision: result.revision, result: assistantSmallResult(result.result) };
    } catch (error) {
      if (!completed) {
        const failed = { ...step, status: 'failed', error: assistantError(error) };
        verifiedSteps.set(id, failed);
        try { await persist('updateTurn', { reply: text, step: failed }, `${id}:failed`); } catch {}
        send({ type: 'tool', step: failed });
      }
      throw error;
    } finally { toolRunning = false; }
  };
  const task = async () => {
    let finalTurn;
    const abortPromise = new Promise((_, reject) => {
      if (aborter.signal.aborted) return reject(aborter.signal.reason);
      aborter.signal.addEventListener('abort', () => reject(aborter.signal.reason), { once: true });
    });
    try {
      alive();
      const reply = await Promise.race([Promise.resolve().then(() => agent.run({ message: input.message, history, snapshot: async () => { alive(); const state = await client.snapshot(); alive(); observedRevision = state.revision; return projectStudioSnapshot(state); }, call, emit, signal: aborter.signal })), abortPromise]);
      alive();
      if (typeof reply !== 'string' || !reply.trim() || reply.length > 4000) throw assistantFail('invalid_reply', 'The assistant returned an invalid reply.');
      if (!text) emit({ type: 'text', text: reply });
      else if (reply.startsWith(text) && reply.length > text.length) emit({ type: 'text', text: reply.slice(text.length) });
      finalTurn = (await persist('finishTurn', { status: 'completed', reply, steps: [...verifiedSteps.values()] }, 'finish:completed')).result?.turn;
      if (finalTurn) send({ type: 'done', turn: assistantPublicTurn(finalTurn) });
    } catch (error) {
      const message = assistantError(error);
      const reply = text ? `${text.slice(0, 3300)}\n\n${message}` : message;
      try { finalTurn = (await persist('finishTurn', { status: 'failed', reply, steps: [...verifiedSteps.values()] }, 'finish:failed')).result?.turn; } catch {}
      send({ type: 'error', message });
      if (finalTurn) send({ type: 'done', turn: assistantPublicTurn(finalTurn) });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', disconnect);
      if (!aborter.signal.aborted) aborter.abort(assistantFail('assistant_cancelled', 'This request has finished.'));
      client.destroy?.();
      if (!closed) { closed = true; try { streamController.close(); } catch {} }
    }
  };
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      request.signal.addEventListener('abort', disconnect, { once: true });
      if (request.signal.aborted) disconnect();
      timer = setTimeout(() => stop(assistantFail('assistant_timeout', 'The request took too long.')), 60000);
      send({ type: 'start', turnId: input.requestId, mode: agent.mode });
      // Every rejection is caught inside task; the request handler can return the stream now.
      void task().catch(() => { if (!closed) { closed = true; try { streamController.close(); } catch {} } });
    },
    cancel() { closed = true; disconnect(); },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
