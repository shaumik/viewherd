import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, ViewherdError } from '../packages/client/index.mjs';
import { mountWorkspace } from '../packages/dom/index.mjs';

const wdTestState = revision => ({ version: 1, sessionId: 'desk', revision, activeWorkspaceId: 'ws_main', workspaces: [], panes: {}, app: {}, agents: [], events: [] });
const wdTestJson = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const wdTestWait = async predicate => {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for client state.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
function wdTestStream() {
  let controller, canceled = false;
  const body = new ReadableStream({ start(value) { controller = value; }, cancel() { canceled = true; } });
  const encoder = new TextEncoder();
  return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }), send(value) { controller.enqueue(encoder.encode(value)); }, close() { controller.close(); }, get canceled() { return canceled; } };
}
const wdTestEvent = (revision, event = 'state.changed') => `id: ${revision}\nevent: ${event}\ndata: ${JSON.stringify({ sessionId: 'desk', revision, state: wdTestState(revision) })}\n\n`;

test('client sends authenticated versioned commands and accepts state before resolving', async () => {
  const requests = [];
  const client = createClient({ sessionId: 'desk', baseUrl: '/viewherd/', headers: () => ({ authorization: 'Bearer example' }), fetch: async (url, init) => {
    requests.push({ url, init });
    if (url.includes('/snapshot')) return wdTestJson(wdTestState(1));
    if (url.includes('/schema')) return wdTestJson({ version: 1, panels: [{ type: 'ticket' }] });
    const command = JSON.parse(init.body);
    return wdTestJson({ version: 1, requestId: command.requestId, sessionId: command.sessionId, result: { paneId: 'pane_ticket' }, revision: 2, state: wdTestState(2) });
  } });
  assert.equal((await client.snapshot()).revision, 1);
  assert.equal((await client.schema()).panels[0].type, 'ticket');
  const result = await client.call('panel.action', { paneId: 'pane_inbox', action: 'open', args: { ticketId: 'SUP-1042' } }, { requestId: 'request-one', expectedRevision: 1 });
  assert.equal(result.result.paneId, 'pane_ticket');
  assert.equal(client.state.revision, 2);
  assert.deepEqual(JSON.parse(requests[2].init.body), { version: 1, requestId: 'request-one', sessionId: 'desk', method: 'panel.action', params: { paneId: 'pane_inbox', action: 'open', args: { ticketId: 'SUP-1042' } }, expectedRevision: 1 });
  assert.equal(requests[2].init.headers.get('authorization'), 'Bearer example');
  assert.equal(requests[2].init.headers.get('content-type'), 'application/json');
  client.destroy();
});

test('late snapshots cannot roll authoritative client state back', async () => {
  let resolveOlder;
  let count = 0;
  const client = createClient({ sessionId: 'desk', fetch: async () => ++count === 1 ? new Promise(resolve => { resolveOlder = resolve; }) : wdTestJson(wdTestState(5)) });
  const older = client.snapshot();
  await wdTestWait(() => resolveOlder);
  assert.equal((await client.snapshot()).revision, 5);
  resolveOlder(wdTestJson(wdTestState(2)));
  assert.equal((await older).revision, 5);
  assert.equal(client.state.revision, 5);
  client.destroy();
});

test('structured conflicts update current state and preserve code for callers', async () => {
  const client = createClient({ sessionId: 'desk', fetch: async () => wdTestJson({ version: 1, sessionId: 'desk', requestId: 'edit', error: { code: 'revision_conflict', message: 'Another collaborator edited this ticket.' }, state: wdTestState(8) }, 409) });
  await assert.rejects(client.call('panel.action', {}, { requestId: 'edit', expectedRevision: 3 }), error => error instanceof ViewherdError && error.code === 'revision_conflict' && error.status === 409 && error.state.revision === 8);
  assert.equal(client.state.revision, 8);
  client.destroy();
});

test('subscribers share one SSE connection, parse fragmented CRLF, resume, and abort on cleanup', async () => {
  const streams = [wdTestStream(), wdTestStream()];
  const requests = [];
  const seenOne = [], seenTwo = [];
  const client = createClient({ sessionId: 'desk', headers: { authorization: 'Bearer stream' }, fetch: async (url, init) => {
    requests.push({ url, init });
    return streams[requests.length - 1].response;
  } });
  const stopOne = client.subscribe(state => seenOne.push(state.revision));
  const stopTwo = client.subscribe(state => seenTwo.push(state.revision));
  await wdTestWait(() => requests.length === 1);
  const event = wdTestEvent(4, 'snapshot').replaceAll('\n', '\r\n');
  // Deliberately split between CR and LF, and in the middle of JSON.
  const first = event.indexOf('\r') + 1;
  streams[0].send(event.slice(0, first)); streams[0].send(event.slice(first, first + 26)); streams[0].send(event.slice(first + 26));
  await wdTestWait(() => seenTwo.length === 1);
  assert.deepEqual(seenOne, [4]); assert.deepEqual(seenTwo, [4]);
  assert.equal(requests[0].init.headers.get('authorization'), 'Bearer stream');
  streams[0].close();
  await wdTestWait(() => requests.length === 2);
  assert.equal(requests[1].init.headers.get('last-event-id'), '4');
  streams[1].send(wdTestEvent(3)); streams[1].send(wdTestEvent(4)); streams[1].send(wdTestEvent(6));
  await wdTestWait(() => seenTwo.length === 2);
  assert.deepEqual(seenTwo, [4, 6]);
  stopOne();
  assert.equal(requests[1].init.signal.aborted, false);
  stopTwo();
  await wdTestWait(() => streams[1].canceled);
  assert.equal(requests[1].init.signal.aborted, true);
  assert.equal(client.connection, 'disconnected');
  client.destroy();
});

test('resync notifications are followed by a coherent snapshot', async () => {
  const stream = wdTestStream();
  const observed = [];
  const client = createClient({ sessionId: 'desk', fetch: async () => stream.response });
  const stop = client.subscribe((state, event) => observed.push([state.revision, event.type]));
  stream.send(wdTestEvent(1, 'snapshot'));
  stream.send('event: resync_required\ndata: {"sessionId":"desk","revision":10}\n\n');
  stream.send(wdTestEvent(10, 'snapshot'));
  await wdTestWait(() => observed.length === 3);
  assert.deepEqual(observed, [[1, 'snapshot'], [1, 'resync_required'], [10, 'snapshot']]);
  stop(); client.destroy();
});

test('failed streams reconnect with backoff and destroy cancels the pending retry', async () => {
  const attempts = [], statuses = [];
  const client = createClient({ sessionId: 'desk', onConnection: event => statuses.push(event.status), fetch: async () => { attempts.push(Date.now()); throw new TypeError('Network unavailable'); } });
  client.subscribe(() => {});
  await wdTestWait(() => attempts.length === 2);
  assert.ok(attempts[1] - attempts[0] >= 220);
  assert.ok(statuses.includes('error')); assert.ok(statuses.includes('reconnecting'));
  client.destroy();
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(attempts.length, 2);
  await assert.rejects(client.snapshot(), error => error.code === 'client_destroyed');
});

test('responses from another session are rejected without replacing state', async () => {
  const client = createClient({ sessionId: 'desk', fetch: async () => wdTestJson({ ...wdTestState(1), sessionId: 'other-room' }) });
  await assert.rejects(client.snapshot(), error => error.code === 'session_mismatch');
  assert.equal(client.state, null);
  client.destroy();
});

test('incorrect command correlation is rejected before its snapshot is accepted', async () => {
  const client = createClient({ sessionId: 'desk', fetch: async () => wdTestJson({ version: 1, sessionId: 'desk', requestId: 'another-request', result: {}, state: wdTestState(12), revision: 12 }) });
  await assert.rejects(client.call('pane.focus', { paneId: 'pane_one' }, { requestId: 'mine' }), error => error.code === 'invalid_response');
  assert.equal(client.state, null);
  client.destroy();
});

test('stream validation failures cancel their response body before reconnecting', async () => {
  for (const mode of ['invalid_json', 'oversized_multiline', 'invalid_content_type']) {
    const stream = wdTestStream();
    const errors = [];
    let requested = 0;
    const client = createClient({ sessionId: 'desk', onConnection: event => { if (event.error) errors.push(event.error.code); }, fetch: async () => {
      requested++;
      if (mode === 'invalid_content_type') return new Response(stream.response.body, { headers: { 'content-type': 'text/plain' } });
      return stream.response;
    } });
    client.subscribe(() => {});
    if (mode === 'invalid_json') stream.send('event: snapshot\ndata: {broken}\n\n');
    if (mode === 'oversized_multiline') stream.send(`data: ${'a'.repeat(10000)}\n`.repeat(111));
    await wdTestWait(() => stream.canceled && errors.length);
    assert.equal(requested, 1);
    assert.deepEqual(errors, [mode === 'invalid_json' ? 'invalid_event' : mode === 'oversized_multiline' ? 'event_too_large' : 'invalid_stream']);
    client.destroy();
  }
});

test('snapshots must identify their session and use the supported version', async () => {
  for (const [state, code] of [[{ ...wdTestState(1), sessionId: undefined }, 'session_mismatch'], [{ ...wdTestState(1), version: 2 }, 'invalid_response']]) {
    const client = createClient({ sessionId: 'desk', fetch: async () => wdTestJson(state) });
    await assert.rejects(client.snapshot(), error => error.code === code);
    assert.equal(client.state, null);
    client.destroy();
  }
});

test('a throwing cached subscriber is removed and does not open an orphan stream', async context => {
  context.mock.method(console, 'error', () => {});
  let streamRequests = 0;
  const stream = wdTestStream();
  const client = createClient({ sessionId: 'desk', fetch: async url => {
    if (url.includes('/snapshot')) return wdTestJson(wdTestState(1));
    streamRequests++;
    return stream.response;
  } });
  await client.snapshot();
  const stopBroken = client.subscribe(() => { throw new Error('Renderer bug'); });
  assert.equal(streamRequests, 0);
  const stopGood = client.subscribe(() => {});
  await wdTestWait(() => streamRequests === 1);
  stopGood(); stopBroken();
  await wdTestWait(() => stream.canceled);
  client.destroy();
});

// A minimal DOM harness makes host identity and disposal observable without a
// browser dependency. Actual positioning and focus are also checked in the demo.
function wdTestDom() {
  const document = { defaultView: { ResizeObserver: class { observe() {} disconnect() {} }, getComputedStyle() { return { getPropertyValue() { return '8'; } }; }, addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {} };
  class Element {
    constructor(tag) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.attributes = {}; this.style = {}; this.dataset = {}; this.listeners = {}; this._hidden = false; this.hiddenChanges = []; this.parentNode = null; this.className = ''; this.clientWidth = 1200; this.clientHeight = 600; this.classList = { toggle: (name, enabled) => { const current = new Set(this.className.split(' ').filter(Boolean)); if (enabled ?? !current.has(name)) current.add(name); else current.delete(name); this.className = [...current].join(' '); }, add: name => this.classList.toggle(name, true), remove: name => this.classList.toggle(name, false) }; }
    get hidden() { return this._hidden; }
    set hidden(value) { if (value !== this._hidden) this.hiddenChanges.push(value); this._hidden = value; }
    append(...children) { for (const child of children) { if (child.parentNode) throw new Error('A connected host was reparented.'); child.parentNode = this; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
  }
  document.createElement = tag => new Element(tag);
  document.createElementNS = (namespace, tag) => new Element(tag);
  return document.createElement('main');
}
const wdTestLeaf = paneId => ({ type: 'pane', paneId });
function wdTestWorkspaceState(revision = 0) {
  return { ...wdTestState(revision), activeWorkspaceId: 'ws_main', workspaces: [{ id: 'ws_main', activeTabId: 'tab_main', tabs: [{ id: 'tab_main', label: 'Inbox', focusedPaneId: 'pane_inbox', zoomedPaneId: null, layout: wdTestLeaf('pane_inbox') }, { id: 'tab_other', label: 'Other', focusedPaneId: 'pane_other', zoomedPaneId: null, layout: wdTestLeaf('pane_other') }] }], panes: { pane_inbox: { id: 'pane_inbox', view: 'inbox', title: 'Inbox', data: {} }, pane_other: { id: 'pane_other', view: 'inbox', title: 'Other', data: {} } } };
}
function wdTestDomClient(initial) {
  let current = initial, listener, unsubscribed = false;
  return { get state() { return current; }, async snapshot() { return current; }, async call() { return { state: current }; }, subscribe(value) { listener = value; listener(current); return () => { unsubscribed = true; listener = null; }; }, update(value) { current = value; listener?.(value); }, get unsubscribed() { return unsubscribed; } };
}

test('DOM renderer hosts stay connected across splits, zoom and tab switches; lifecycle cleanup is exact', () => {
  const root = wdTestDom(), initial = wdTestWorkspaceState();
  const client = wdTestDomClient(initial);
  const mounts = [], destroys = [], updates = [], hosts = new Map();
  const renderer = { mount(host, ctx) { mounts.push(`${ctx.pane.id}:${ctx.pane.view}`); hosts.set(ctx.pane.id, host); return { update(value) { updates.push(value.pane.id); }, destroy() { destroys.push(`${ctx.pane.id}:${ctx.pane.view}`); } }; } };
  const mounted = mountWorkspace(root, { client, panels: { inbox: renderer, composer: renderer } });
  const inboxHost = hosts.get('pane_inbox');
  assert.deepEqual(mounts, ['pane_inbox:inbox']);
  let next = structuredClone(initial);
  next.revision = 1;
  next.panes.pane_side = { id: 'pane_side', view: 'inbox', title: 'Customer', data: {} };
  next.workspaces[0].tabs[0].layout = { type: 'split', id: 'split_main', direction: 'right', ratio: 0.4, first: wdTestLeaf('pane_inbox'), second: wdTestLeaf('pane_side') };
  client.update(next);
  assert.equal(hosts.get('pane_inbox'), inboxHost);
  assert.equal(inboxHost.parentNode.parentNode.parentNode, root.children[0]);
  // Existing visible inputs must not be transiently hidden while measuring layout.
  assert.deepEqual(inboxHost.parentNode.hiddenChanges, []);
  next = structuredClone(next); next.revision = 2; next.workspaces[0].tabs[0].zoomedPaneId = 'pane_side'; client.update(next);
  next = structuredClone(next); next.revision = 3; next.workspaces[0].activeTabId = 'tab_other'; client.update(next);
  next = structuredClone(next); next.revision = 4; next.workspaces[0].activeTabId = 'tab_main'; next.workspaces[0].tabs[0].zoomedPaneId = null; client.update(next);
  assert.equal(hosts.get('pane_inbox'), inboxHost);
  assert.deepEqual(destroys, []);
  next = structuredClone(next); next.revision = 5; next.panes.pane_inbox.view = 'composer'; client.update(next);
  assert.equal(hosts.get('pane_inbox'), inboxHost);
  assert.deepEqual(destroys, ['pane_inbox:inbox']);
  next = structuredClone(next); next.revision = 6; delete next.panes.pane_side; next.workspaces[0].tabs[0].layout = wdTestLeaf('pane_inbox'); client.update(next);
  assert.deepEqual(destroys, ['pane_inbox:inbox', 'pane_side:inbox']);
  assert.ok(updates.includes('pane_inbox'));
  mounted.destroy(); mounted.destroy();
  assert.equal(client.unsubscribed, true);
  assert.deepEqual(destroys.sort(), ['pane_inbox:inbox', 'pane_side:inbox', 'pane_inbox:composer', 'pane_other:inbox'].sort());
  assert.equal(root.children.length, 0);
});

test('two SDK mounts with the same pane IDs use distinct accessible title references', () => {
  const one = wdTestDom(), two = wdTestDom();
  const renderer = { mount() {} };
  const mountOne = mountWorkspace(one, { client: wdTestDomClient(wdTestWorkspaceState()), panels: { inbox: renderer } });
  const mountTwo = mountWorkspace(two, { client: wdTestDomClient(wdTestWorkspaceState()), panels: { inbox: renderer } });
  const firstPane = one.children[0].children[2].children[0];
  const secondPane = two.children[0].children[2].children[0];
  assert.notEqual(firstPane.attributes['aria-labelledby'], secondPane.attributes['aria-labelledby']);
  mountOne.destroy(); mountTwo.destroy();
});

test('pane focus commands coalesce so the last human choice wins while a prior call is pending', async () => {
  const root = wdTestDom();
  const initial = wdTestWorkspaceState();
  initial.panes.pane_side = { id: 'pane_side', view: 'inbox', title: 'Customer', data: {} };
  initial.workspaces[0].tabs[0].layout = { type: 'split', id: 'split_main', direction: 'right', ratio: 0.4, first: wdTestLeaf('pane_inbox'), second: wdTestLeaf('pane_side') };
  const client = wdTestDomClient(initial), calls = [], completions = [];
  client.call = (method, params) => new Promise(resolve => { calls.push({ method, params }); completions.push(resolve); });
  const mounted = mountWorkspace(root, { client, panels: { inbox: { mount() {} } } });
  const canvas = root.children[0].children[2];
  const inbox = canvas.children.find(node => node.dataset.paneId === 'pane_inbox');
  const side = canvas.children.find(node => node.dataset.paneId === 'pane_side');
  side.listeners.pointerdown[0]();
  inbox.listeners.pointerdown[0]();
  assert.deepEqual(calls.map(call => call.params.paneId), ['pane_side']);
  let next = structuredClone(initial); next.revision = 1; next.workspaces[0].tabs[0].focusedPaneId = 'pane_side'; client.update(next); completions[0]({ state: next });
  await wdTestWait(() => calls.length === 2);
  assert.deepEqual(calls.map(call => call.params.paneId), ['pane_side', 'pane_inbox']);
  next = structuredClone(next); next.revision = 2; next.workspaces[0].tabs[0].focusedPaneId = 'pane_inbox'; client.update(next); completions[1]({ state: next });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 2);
  mounted.destroy();
});
