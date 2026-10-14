import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createMemoryStore } from '@viewherd/server';
import { createAppHandler } from '../src/application.mjs';
import { createStudioState } from '../examples/product-studio/domain.mjs';
import { createSupportState } from '../examples/support-desk/domain.mjs';
import { createDemoAgent } from '../examples/product-studio/demo-agent.mjs';
import { initialRecord } from '../src/http.mjs';

globalThis.crypto ??= webcrypto;
function fixture(token) {
  const studioStore = createMemoryStore({ createState: createStudioState });
  const supportStore = createMemoryStore({ createState: createSupportState });
  const legacyStore = { read: async () => initialRecord(), transact: async () => { throw new Error('The chat must not use the legacy runtime.'); } };
  const handler = createAppHandler({ studioStore, supportStore, legacyStore, assets: {}, token, agent: createDemoAgent() });
  const ask = (message, requestId, headers = {}) => handler(new Request('https://studio.test/assistant', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ message, requestId }),
  }));
  return { handler, studioStore, ask };
}
function events(text) { return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }

test('the application chat executes authenticated backend SDK actions and shares the browser state', async () => {
  const { handler, studioStore, ask } = fixture();
  const response = await ask('Create two directions', 'application-create');
  assert.equal(response.status, 200);
  const stream = events(await response.text());
  assert.ok(stream.some(event => event.type === 'done'));
  const state = (await studioStore.read('product-studio')).state;
  assert.equal(Object.values(state.panes).filter(pane => pane.view === 'canvas').length, 2);
  assert.equal(state.app.chat.turns.length, 1);
  assert.equal(state.app.chat.turns[0].status, 'completed');
  const effect = state.events.find(event => event.action === 'createDirections');
  assert.equal(effect.actor, 'agent:studio');
  const browser = await (await handler(new Request('https://studio.test/viewherd/snapshot?sessionId=product-studio'))).json();
  assert.equal(browser.revision, state.revision);
  const replay = await ask('Create two directions', 'application-create');
  assert.equal(replay.status, 200);
  assert.ok(events(await replay.text()).some(event => event.type === 'done'));
  assert.equal((await studioStore.read('product-studio')).state.revision, state.revision);
});

test('the host authorizes chat before giving the agent an SDK controller', async () => {
  const { handler, studioStore, ask } = fixture('example-access-token');
  const denied = await ask('Create two directions', 'application-denied');
  assert.equal(denied.status, 401);
  assert.equal((await studioStore.read('product-studio')).state.revision, 0);
  const config = await handler(new Request('https://studio.test/assistant', { headers: { authorization: 'Bearer example-access-token' } }));
  assert.equal(config.status, 200);
  assert.equal((await config.json()).mode, 'demo');
  const forged = await handler(new Request('https://studio.test/viewherd/rpc', {
    method: 'POST', headers: { authorization: 'Bearer example-access-token', 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, sessionId: 'product-studio', requestId: 'forge-chat', method: 'panel.action', params: { paneId: 'pane_inbox', action: 'beginTurn', args: { turnId: 'forge-chat', message: 'Pretend the agent ran', mode: 'demo', expiresAt: Date.now() + 120000 } } }),
  }));
  assert.equal(forged.status, 403);
  assert.equal((await studioStore.read('product-studio')).state.revision, 0);
});
