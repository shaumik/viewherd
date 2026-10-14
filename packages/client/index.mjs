/** Viewherd's browser-safe HTTP and event-stream client. No dependencies. */
export class ViewherdError extends Error {
  constructor(code, message, { status = 0, response, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ViewherdError';
    this.code = code;
    this.status = status;
    this.response = response;
    this.state = response?.state;
  }
}

let wdClientSequence = 0;
const wdClientRequestId = () => globalThis.crypto?.randomUUID?.() || `wd_${Date.now().toString(36)}_${(++wdClientSequence).toString(36)}_${Math.random().toString(36).slice(2)}`;
const wdClientRevision = state => Number.isSafeInteger(state?.revision) && state.revision >= 0;
const wdClientAbort = error => error?.name === 'AbortError';

/** One client owns one session and shares one SSE connection across subscribers. */
export function createClient({ baseUrl = '/viewherd', sessionId, fetch: wdFetch = globalThis.fetch, headers, onConnection } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('createClient requires a nonempty sessionId.');
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new TypeError('baseUrl must be a nonempty URL or path.');
  if (typeof wdFetch !== 'function') throw new TypeError('A fetch implementation is required.');
  const base = baseUrl.replace(/\/+$/, '');
  const listeners = new Set();
  let latest = null, lastEventId = null, destroyed = false, streamController = null, streamTask = null;
  let connectionStatus = 'disconnected';

  const alive = () => { if (destroyed) throw new ViewherdError('client_destroyed', 'This Viewherd client has been destroyed.'); };
  const endpoint = route => `${base}/${route}?sessionId=${encodeURIComponent(sessionId)}`;
  async function requestHeaders(extra = {}) {
    const value = typeof headers === 'function' ? await headers() : headers;
    const result = new Headers(value || {});
    for (const [key, val] of Object.entries(extra)) result.set(key, val);
    return result;
  }
  function connection(status, attempt = 0, error) {
    connectionStatus = status;
    if (typeof onConnection === 'function') {
      try { onConnection({ status, attempt, ...(error ? { error } : {}) }); }
      catch (callbackError) { console.error('Viewherd onConnection callback failed.', callbackError); }
    }
  }
  function emit(state, event) {
    for (const listener of [...listeners]) {
      try { listener(state, event); }
      catch (callbackError) { console.error('Viewherd subscriber failed.', callbackError); }
    }
  }
  function accept(state, event) {
    if (!wdClientRevision(state)) throw new ViewherdError('invalid_response', 'The server returned a snapshot without a valid revision.');
    if (state.sessionId !== sessionId) throw new ViewherdError('session_mismatch', 'The response does not identify this session.');
    if (state.version !== 1) throw new ViewherdError('invalid_response', 'The server returned an unsupported snapshot version.');
    if (latest && state.revision < latest.revision) return false;
    if (latest && state.revision === latest.revision) return false;
    latest = state;
    emit(state, { ...event, sessionId, revision: state.revision });
    return true;
  }
  async function jsonResponse(response, expectedRequestId) {
    let data;
    try { data = await response.json(); }
    catch (cause) { throw new ViewherdError('invalid_response', 'The Viewherd server returned an invalid JSON response.', { status: response.status, cause }); }
    alive();
    const matchingCommand = expectedRequestId === undefined || (data?.version === 1 && data.sessionId === sessionId && data.requestId === expectedRequestId);
    if (!response.ok || data?.error) {
      if (data?.state && !matchingCommand) throw new ViewherdError('invalid_response', 'The Viewherd error snapshot does not match its command.', { status: response.status, response: data });
      if (data?.state) accept(data.state, { type: 'snapshot', source: 'error' });
      throw new ViewherdError(data?.error?.code || `http_${response.status}`, data?.error?.message || `Viewherd request failed (${response.status}).`, { status: response.status, response: data });
    }
    if (!matchingCommand) throw new ViewherdError('invalid_response', 'The Viewherd response does not match its command.', { status: response.status, response: data });
    return data;
  }
  async function snapshot() {
    alive();
    const response = await wdFetch(endpoint('snapshot'), { headers: await requestHeaders({ accept: 'application/json' }) });
    const state = await jsonResponse(response);
    alive();
    accept(state, { type: 'snapshot', source: 'http' });
    // A racing, older response must never leak back to a renderer as current state.
    return latest;
  }
  async function schema() {
    alive();
    const response = await wdFetch(endpoint('schema'), { headers: await requestHeaders({ accept: 'application/json' }) });
    const result = await jsonResponse(response);
    alive();
    return result;
  }
  async function call(method, params = {}, options = {}) {
    alive();
    if (typeof method !== 'string' || !method.trim()) throw new TypeError('method must be a nonempty string.');
    const requestId = options.requestId === undefined ? wdClientRequestId() : options.requestId;
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128 || /[\u0000-\u001f\u007f]/.test(requestId)) throw new TypeError('requestId must be a nonempty string of at most 128 characters without control characters.');
    const command = { version: 1, requestId, sessionId, method, params };
    if (options.expectedRevision !== undefined) command.expectedRevision = options.expectedRevision;
    const response = await wdFetch(`${base}/rpc`, {
      method: 'POST', headers: await requestHeaders({ accept: 'application/json', 'content-type': 'application/json' }),
      body: JSON.stringify(command), ...(options.signal ? { signal: options.signal } : {}),
    });
    const result = await jsonResponse(response, requestId);
    alive();
    if (!result.state || result.revision !== result.state.revision) throw new ViewherdError('invalid_response', 'The Viewherd response revision does not match its snapshot.', { status: response.status, response: result });
    accept(result.state, { type: 'state.changed', source: 'rpc', requestId });
    return result;
  }
  function delay(ms, signal) {
    return new Promise(resolve => {
      if (signal.aborted) return resolve();
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  async function readEvents(response, signal) {
    if (!response.body?.getReader) throw new ViewherdError('stream_unavailable', 'This fetch implementation does not support streaming response bodies.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', frame = { type: 'message', data: [], id: undefined, size: 0 };
    function dispatch() {
      const current = frame;
      frame = { type: 'message', data: [], id: undefined, size: 0 };
      if (!current.data.length) return;
      let data;
      try { data = JSON.parse(current.data.join('\n')); }
      catch (cause) { throw new ViewherdError('invalid_event', 'The Viewherd event stream returned invalid JSON.', { cause }); }
      if (data?.sessionId !== sessionId) throw new ViewherdError('session_mismatch', 'The event stream belongs to another session.');
      if (current.type === 'resync_required') {
        lastEventId = null;
        if (latest) emit(latest, { type: 'resync_required', source: 'stream', sessionId, revision: latest.revision });
        return;
      }
      if (!['snapshot', 'state.changed'].includes(current.type)) return;
      if (!data.state || data.revision !== data.state.revision) throw new ViewherdError('invalid_event', 'The Viewherd event revision does not match its snapshot.');
      accept(data.state, { type: current.type, source: 'stream', requestId: data.requestId });
      // Do not let a stale event move the resume cursor backwards after a newer RPC.
      if (current.id !== undefined && /^\d+$/.test(current.id) && Number(current.id) === data.revision && data.revision >= latest.revision) lastEventId = current.id;
    }
    function line(value) {
      if (value === '') { dispatch(); return; }
      if (value.startsWith(':')) return;
      frame.size += value.length + 1;
      if (frame.size > 1100000) throw new ViewherdError('event_too_large', 'The Viewherd event stream exceeded the event size limit.');
      const separator = value.indexOf(':');
      const field = separator < 0 ? value : value.slice(0, separator);
      let content = separator < 0 ? '' : value.slice(separator + 1);
      if (content.startsWith(' ')) content = content.slice(1);
      if (field === 'event') frame.type = content;
      else if (field === 'data') frame.data.push(content);
      else if (field === 'id' && !content.includes('\0')) frame.id = content;
    }
    function consume(final = false) {
      let start = 0;
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] !== '\r' && buffer[index] !== '\n') continue;
        if (buffer[index] === '\r' && index === buffer.length - 1 && !final) break;
        line(buffer.slice(start, index));
        if (buffer[index] === '\r' && buffer[index + 1] === '\n') index++;
        start = index + 1;
      }
      buffer = buffer.slice(start);
      if (buffer.length > 1100000) throw new ViewherdError('event_too_large', 'The Viewherd event stream exceeded the event size limit.');
      if (final && buffer) { line(buffer); buffer = ''; }
    }
    const cancel = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) { buffer += decoder.decode(); consume(true); break; }
        buffer += decoder.decode(value, { stream: true });
        consume();
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function stream(signal) {
    let attempt = 0;
    while (!signal.aborted && !destroyed && listeners.size) {
      connection(attempt ? 'reconnecting' : 'connecting', attempt);
      let error;
      const started = Date.now();
      try {
        const eventHeaders = await requestHeaders({ accept: 'text/event-stream' });
        if (lastEventId !== null) eventHeaders.set('last-event-id', lastEventId);
        const response = await wdFetch(endpoint('events'), { headers: eventHeaders, signal, cache: 'no-store' });
        if (signal.aborted || destroyed || !listeners.size) { await response.body?.cancel().catch(() => {}); break; }
        if (!response.ok) await jsonResponse(response);
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          await response.body?.cancel().catch(() => {});
          throw new ViewherdError('invalid_stream', 'The Viewherd event endpoint did not return an event stream.', { status: response.status });
        }
        connection('connected', attempt);
        await readEvents(response, signal);
      } catch (cause) {
        if (signal.aborted || wdClientAbort(cause)) break;
        error = cause;
        connection('error', attempt, cause);
      }
      if (signal.aborted || destroyed || !listeners.size) break;
      // A normal bounded stream reconnects quickly. Fast failures back off to 10s.
      attempt = Date.now() - started > 5000 ? 0 : attempt + 1;
      const wait = error ? Math.min(10000, 250 * (2 ** Math.min(attempt - 1, 6))) : 100;
      await delay(wait, signal);
    }
  }
  function startStream() {
    if (streamTask || destroyed || !listeners.size) return;
    const controller = new AbortController();
    streamController = controller;
    streamTask = stream(controller.signal).finally(() => {
      streamTask = null;
      if (streamController === controller) streamController = null;
      if (!destroyed && listeners.size) startStream();
    });
  }
  function subscribe(listener) {
    alive();
    if (typeof listener !== 'function') throw new TypeError('subscribe requires a listener function.');
    listeners.add(listener);
    if (latest) {
      try { listener(latest, { type: 'snapshot', source: 'cache', sessionId, revision: latest.revision }); }
      catch (callbackError) { listeners.delete(listener); console.error('Viewherd subscriber failed.', callbackError); }
    }
    startStream();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (!listeners.size) { streamController?.abort(); connection('disconnected'); }
    };
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    listeners.clear();
    streamController?.abort();
    connection('disconnected');
  }
  return { snapshot, schema, call, subscribe, destroy, get state() { return latest; }, get connection() { return connectionStatus; }, sessionId };
}

/** Compatibility alias for clients written before the Viewherd name. */
export { ViewherdError as WebdrError };
