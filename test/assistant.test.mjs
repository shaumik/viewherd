import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRegistry } from '@viewherd/core';
import { createClient } from '@viewherd/client';
import { createMemoryStore, createViewherdHandler } from '@viewherd/server';
import { studioPanels, createStudioState } from '../examples/product-studio/domain.mjs';
import { createStudioAssistantHandler, projectStudioSnapshot } from '../examples/product-studio/assistant.mjs';
import { createDemoAgent } from '../examples/product-studio/demo-agent.mjs';

globalThis.crypto ??= webcrypto;
const registry = createRegistry(studioPanels);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function chatRequest(requestId, message, { user = 'designer', signal, headers = {}, body } = {}) {
  return new Request('https://studio.test/assistant', { method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}), ...headers }, body: body ?? JSON.stringify({ requestId, message }), ...(signal ? { signal } : {}) });
}
const events = async response => (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function until(read, predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await delay(5); }
  throw new Error('Expected state did not arrive.');
}

function harness({ agent = createDemoAgent(), createState = createStudioState } = {}) {
  const store = createMemoryStore({ createState });
  let factories = 0, destroyed = 0;
  const publicSdk = createViewherdHandler({ registry, store, sessionId: 'product-studio', authorize: () => ({ id: 'designer', actor: 'human:designer', roles: ['owner'] }), stream: { pollIntervalMs: 10, lifetimeMs: 3000, heartbeatMs: 500 } });
  const clientFor = async (request, { turnId }) => {
    factories++;
    const id = request.headers.get('x-user');
    if (!id) throw Object.assign(new Error('Sign in to use the studio.'), { code: 'unauthorized', status: 401 });
    const principal = { id, actor: 'agent:studio', roles: ['owner', 'studio-agent'], ...(turnId ? { turnId } : {}) };
    const privateSdk = createViewherdHandler({ registry, store, sessionId: 'product-studio', authorize: () => ({ ...principal, serverTime: Date.now() }) });
    const client = createClient({ baseUrl: 'https://studio.test/viewherd', sessionId: 'product-studio', fetch: (url, init) => privateSdk(new Request(url, init)) });
    const destroy = client.destroy;
    client.destroy = () => { destroyed++; destroy(); };
    return { client, principal };
  };
  const handler = createStudioAssistantHandler({ clientFor, agent });
  const humanAction = async (action, args, requestId = `human-${crypto.randomUUID()}`) => {
    const response = await publicSdk(new Request('https://studio.test/viewherd/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, sessionId: 'product-studio', requestId, method: 'panel.action', params: { paneId: 'pane_inbox', action, args } }) }));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  return { handler, store, publicSdk, clientFor, humanAction, state: async () => (await store.read('product-studio')).state, get factories() { return factories; }, get destroyed() { return destroyed; } };
}

test('chat runs on the backend and SDK tool calls persist real panels, edits and export files', async () => {
  const app = harness();
  const response = await app.handler(chatRequest('launch-create', 'Create two directions for this launch'));
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  const first = await events(response);
  assert.equal(first[0].type, 'start');
  assert.equal(first[0].mode, 'demo');
  assert.equal(first.at(-1).turn.status, 'completed');
  let state = await app.state();
  assert.equal(Object.values(state.panes).filter(pane => pane.view === 'canvas').length, 2);
  assert.equal(state.app.chat.turns[0].steps[0].action, 'createDirections');
  assert.equal(state.app.chat.turns[0].steps[0].status, 'done');
  assert.ok(state.events.some(event => event.actor === 'agent:studio'));
  const follow = await events(await app.handler(chatRequest('launch-refine', 'Keep the dark one and make it cobalt and change the headline to "Your world. Your volume." and export it')));
  assert.equal(follow.at(-1).turn.status, 'completed');
  state = await app.state();
  assert.equal(state.app.designs.design_midnight.theme, 'cobalt');
  assert.equal(state.app.designs.design_midnight.headline, 'Your world. Your volume.');
  assert.equal(state.app.selectedDesignId, 'design_midnight');
  assert.equal(Object.values(state.panes).filter(pane => pane.view === 'canvas').length, 1);
  assert.equal(Object.values(state.panes).filter(pane => pane.view === 'deliverables').length, 1);
  assert.equal(state.app.lastExport.filename, 'forma-one-cobalt-square.svg');
  assert.equal(state.app.chat.turns[1].steps.length, 4);
  assert.ok(state.app.chat.turns[1].steps.every(step => step.status === 'done'));
  assert.doesNotMatch(JSON.stringify(follow), /data:image|<svg|ownerId/);
  assert.equal(app.destroyed, 2);
});

test('the SDK event stream independently delivers panel changes made by a chat turn', async () => {
  const app = harness(), controller = new AbortController();
  const stream = await app.publicSdk(new Request('https://studio.test/viewherd/events?sessionId=product-studio', { signal: controller.signal }));
  const reader = stream.body.getReader(), decoder = new TextDecoder();
  try {
    assert.match(decoder.decode((await reader.read()).value), /event: snapshot/);
    await events(await app.handler(chatRequest('stream-create', 'Create two directions')));
    let received = '', snapshot;
    while (!snapshot) {
      const chunk = await reader.read(); assert.equal(chunk.done, false); received += decoder.decode(chunk.value);
      const candidates = received.split('\n').filter(line => line.startsWith('data: ')).map(line => { try { return JSON.parse(line.slice(6)).state; } catch { return null; } });
      snapshot = candidates.find(value => value?.app.chat.turns[0]?.status === 'completed');
    }
    assert.match(received, /event: state.changed/);
    assert.equal(Object.values(snapshot.panes).filter(pane => pane.view === 'canvas').length, 2);
    assert.equal(snapshot.app.chat.turns[0].status, 'completed');
  } finally { controller.abort(); await reader.cancel(); reader.releaseLock(); }
});

test('completed retries replay the saved transcript without repeating model calls or UI tools', async () => {
  let runs = 0;
  const demo = createDemoAgent();
  const app = harness({ agent: { mode: 'demo', async run(context) { runs++; return demo.run(context); } } });
  await events(await app.handler(chatRequest('retry-turn', 'Create two directions')));
  const before = await app.state();
  const retry = await events(await app.handler(chatRequest('retry-turn', 'Create two directions')));
  assert.equal(retry[0].replayed, true);
  assert.equal(retry.at(-1).turn.status, 'completed');
  assert.equal(runs, 1);
  assert.deepEqual(await app.state(), before);
  assert.equal((await app.handler(chatRequest('retry-turn', 'Export it'))).status, 409);
  assert.equal((await app.handler(chatRequest('retry-turn', 'Create two directions', { user: 'another-user' }))).status, 409);
  const changedMode = createStudioAssistantHandler({ clientFor: app.clientFor, agent: { mode: 'openai', model: 'new-model', async run() { throw new Error('A replay must not run the new adapter.'); } } });
  const originalMode = await events(await changedMode(chatRequest('retry-turn', 'Create two directions')));
  assert.equal(originalMode[0].mode, 'demo');
  assert.equal(originalMode.at(-1).turn.mode, 'demo');
  assert.deepEqual(await app.state(), before);
});

test('a concurrent chat turn is rejected before a second agent can execute', async () => {
  const started = deferred(), finish = deferred(); let runs = 0;
  const app = harness({ agent: { mode: 'demo', async run() { runs++; started.resolve(); await finish.promise; return 'Ready.'; } } });
  const first = await app.handler(chatRequest('active-one', 'Create two directions'));
  await started.promise;
  try {
    const second = await app.handler(chatRequest('active-two', 'Export it'));
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, 'turn_in_progress');
    assert.equal(runs, 1);
  } finally { finish.resolve(); await events(first); }
  assert.equal((await app.state()).app.chat.activeTurnId, null);
});

test('human changes after the agent snapshot conflict rather than overwriting newer copy', async () => {
  let app;
  app = harness({ agent: { mode: 'demo', async run({ snapshot, call }) {
    await snapshot();
    await app.humanAction('refine', { headline: 'A human wrote this.' });
    await call({ action: 'refine', args: { headline: 'Stale agent copy' }, label: 'Update headline' });
    return 'Changed it.';
  } } });
  const transcript = await events(await app.handler(chatRequest('conflict-turn', 'Change the headline')));
  const state = await app.state();
  assert.equal(state.app.designs.design_sand.headline, 'A human wrote this.');
  assert.equal(state.app.chat.turns[0].status, 'failed');
  assert.equal(state.app.chat.turns[0].steps[0].status, 'failed');
  assert.match(transcript.find(event => event.type === 'error').message, /newer edit is safe/);
  assert.equal(transcript.at(-1).turn.status, 'failed');
  assert.ok(!transcript.some(event => event.type === 'text' && event.text.includes('Changed it')));
});

test('partial tool failure keeps completed panels and reports failed work honestly', async () => {
  const app = harness({ agent: { mode: 'demo', async run({ snapshot, call }) {
    await snapshot();
    await call({ action: 'createDirections', args: {}, label: 'Create directions' });
    await call({ action: 'refine', args: { theme: 'red' }, label: 'Unsupported palette' });
    return 'All done.';
  } } });
  const transcript = await events(await app.handler(chatRequest('partial-turn', 'Create then edit')));
  const state = await app.state();
  assert.equal(Object.values(state.panes).filter(pane => pane.view === 'canvas').length, 2);
  assert.deepEqual(state.app.chat.turns[0].steps.map(step => step.status), ['done', 'failed']);
  assert.equal(state.app.chat.turns[0].status, 'failed');
  assert.equal(transcript.at(-1).turn.status, 'failed');
  assert.ok(!transcript.some(event => event.type === 'text' && event.text === 'All done.'));
});

test('a metadata failure after a verified SDK action preserves its completed status in the final transcript', async () => {
  const app = harness();
  let failedOnce = false;
  const handler = createStudioAssistantHandler({ agent: createDemoAgent(), clientFor: async (request, context) => {
    const result = await app.clientFor(request, context);
    const originalCall = result.client.call;
    result.client.call = async (method, params, options) => {
      if (!failedOnce && params.action === 'updateTurn' && params.args.step?.status === 'done') { failedOnce = true; throw new Error('A transient transcript write failed.'); }
      return originalCall(method, params, options);
    };
    return result;
  } });
  const transcript = await events(await handler(chatRequest('metadata-turn', 'Create two directions')));
  const state = await app.state();
  assert.equal(Object.values(state.panes).filter(pane => pane.view === 'canvas').length, 2);
  assert.equal(transcript.at(-1).turn.status, 'failed');
  assert.equal(transcript.at(-1).turn.steps[0].status, 'done');
  assert.equal(state.app.chat.turns[0].steps[0].status, 'done');
  assert.equal(transcript.filter(event => event.type === 'tool' && event.step.status === 'failed').length, 0);
});

test('disconnect releases the turn, aborts the agent and rejects late tool calls', async () => {
  const started = deferred(), release = deferred(), late = deferred();
  const app = harness({ agent: { mode: 'demo', async run({ call, signal }) {
    started.resolve(); await release.promise;
    assert.equal(signal.aborted, true);
    try { await call({ action: 'createDirections', args: {} }); } catch (error) { late.resolve(error); }
    return 'Too late.';
  } } });
  const response = await app.handler(chatRequest('abort-turn', 'Create two directions'));
  const reader = response.body.getReader();
  await reader.read(); await started.promise; await reader.cancel();
  const state = await until(app.state, value => value.app.chat.activeTurnId === null);
  assert.equal(state.app.chat.turns[0].status, 'failed');
  assert.equal(Object.values(state.panes).filter(pane => pane.view === 'canvas').length, 1);
  release.resolve(); assert.equal((await late.promise).code, 'assistant_cancelled');
  await until(async () => app.destroyed, value => value === 1);
});

test('an expired exact retry closes the stale lease and replays failure without agent execution', async () => {
  let runs = 0;
  const app = harness({ createState(id) {
    const state = createStudioState(id);
    state.app.chat = { activeTurnId: 'expired-turn', turns: [{ id: 'expired-turn', ownerId: 'designer', message: 'Create two directions', mode: 'demo', status: 'running', reply: '', steps: [], expiresAt: Date.now() - 1000 }] };
    return state;
  }, agent: { mode: 'demo', async run() { runs++; return 'Unexpected.'; } } });
  const replay = await events(await app.handler(chatRequest('expired-turn', 'Create two directions')));
  assert.equal(replay[0].replayed, true);
  assert.equal(replay.at(-1).turn.status, 'failed');
  assert.equal((await app.state()).app.chat.activeTurnId, null);
  assert.equal(runs, 0);
});

test('authentication, origin, malformed and oversized input are checked before starting an agent', async () => {
  const app = harness();
  assert.equal((await app.handler(chatRequest('denied', 'Create two directions', { user: null }))).status, 401);
  const before = app.factories;
  const cases = [
    [chatRequest('foreign', 'Create two directions', { headers: { origin: 'https://evil.test' } }), 403],
    [chatRequest('cross-site', 'Create two directions', { headers: { 'sec-fetch-site': 'cross-site' } }), 403],
    [chatRequest('bad-json', 'unused', { body: '{broken' }), 400],
    [chatRequest('empty', '   '), 400],
    [chatRequest('too-long', 'a'.repeat(2001)), 400],
    [chatRequest('huge', 'unused', { body: 'x'.repeat(12001) }), 413],
    [chatRequest('fields', 'unused', { body: JSON.stringify({ requestId: 'fields', message: 'Export it', role: 'studio-agent' }) }), 400],
    [chatRequest('type', 'Export it', { headers: { 'content-type': 'text/plain' } }), 415],
  ];
  for (const [request, status] of cases) assert.equal((await app.handler(request)).status, status);
  assert.equal(app.factories, before);
  assert.equal((await app.state()).app.chat.turns.length, 0);
  const get = await app.handler(new Request('https://studio.test/assistant', { headers: { 'x-user': 'designer' } }));
  assert.deepEqual(await get.json(), { mode: 'demo', streaming: true });
});

test('model context and outputs omit image data, identity and internal errors', async () => {
  const state = createStudioState();
  state.app.chat.turns.push({ ownerId: 'private-owner' });
  const projection = projectStudioSnapshot(state);
  assert.doesNotMatch(JSON.stringify(projection), /base64|ownerId|private-owner/);
  assert.equal(projection.asset.name, 'FORMA One headphones');
  const denied = createStudioAssistantHandler({ clientFor: () => { throw new Error('secret-token internal-db-password'); }, agent: createDemoAgent() });
  const response = await denied(chatRequest('secret-test', 'Export it'));
  assert.doesNotMatch(await response.text(), /secret-token|internal-db-password/);
  const app = harness({ agent: { mode: 'openai', model: 'example-model', async run({ snapshot, call }) {
    await snapshot();
    const result = await call({ action: 'export', args: {} });
    assert.doesNotMatch(JSON.stringify(result), /base64|<svg|"svg":/);
    return 'The export is ready.';
  } } });
  const mode = await app.handler(new Request('https://studio.test/assistant', { headers: { 'x-user': 'designer' } }));
  assert.deepEqual(await mode.json(), { mode: 'openai', model: 'example-model', streaming: true });
  assert.equal((await events(await app.handler(chatRequest('model-export', 'Export it')))).at(-1).turn.status, 'completed');
});

test('demo understands the visible starters, edit controls, comparison and deletion', async () => {
  const app = harness();
  for (const [id, message] of [
    ['starter-create', 'Create two launch directions for this product.'],
    ['starter-palette', 'Make it midnight with the headline "Less noise. More you."'],
    ['starter-editor', 'Open editing controls'],
    ['starter-compare', 'Compare them'],
    ['starter-remove', 'Delete the warm one'],
  ]) {
    const transcript = await events(await app.handler(chatRequest(id, message)));
    assert.equal(transcript.at(-1).turn.status, 'completed');
    assert.ok(transcript.some(event => event.type === 'tool' && event.step.status === 'done'), message);
  }
  const state = await app.state();
  assert.equal(state.app.designs.design_midnight.headline, 'Less noise. More you.');
  assert.equal(state.app.designs.design_sand, undefined);
  assert.equal(Object.values(state.panes).filter(pane => pane.view === 'canvas').length, 1);
});

test('unsupported compound requests perform no design mutations and never pretend to be a model', async () => {
  const app = harness();
  const original = projectStudioSnapshot(await app.state());
  const transcript = await events(await app.handler(chatRequest('unsupported-turn', 'Create two directions and send an email to my customers')));
  const after = projectStudioSnapshot(await app.state());
  assert.deepEqual(after.designs, original.designs);
  assert.deepEqual(after.panels, original.panels);
  assert.equal(transcript[0].mode, 'demo');
  assert.equal(transcript.filter(event => event.type === 'tool').length, 0);
  assert.match(transcript.at(-1).turn.reply, /I can create two directions/);
});

test('agent tools cannot invoke internal conversation actions and stop at ten studio actions', async () => {
  const internal = harness({ agent: { mode: 'demo', async run({ call }) { await call({ action: 'beginTurn', args: {} }); return 'Unexpected.'; } } });
  const denied = await events(await internal.handler(chatRequest('internal-tool', 'Bypass the conversation')));
  assert.equal(denied.at(-1).turn.status, 'failed');
  assert.equal((await internal.state()).app.chat.turns.length, 1);
  assert.equal((await internal.state()).app.chat.turns[0].steps.length, 0);
  const bounded = harness({ agent: { mode: 'demo', async run({ snapshot, call }) {
    await snapshot();
    for (let index = 0; index < 11; index++) await call({ action: 'inspect', args: {} });
    return 'Unexpected.';
  } } });
  const limited = await events(await bounded.handler(chatRequest('bounded-tools', 'Open eleven controls')));
  const state = await bounded.state();
  assert.equal(limited.at(-1).turn.status, 'failed');
  assert.equal(state.app.chat.turns[0].steps.length, 10);
  assert.ok(state.app.chat.turns[0].steps.every(step => step.status === 'done'));
  assert.equal(Object.values(state.panes).filter(pane => pane.view === 'inspector').length, 1);
  assert.match(limited.find(event => event.type === 'error').message, /ten actions/);
});
