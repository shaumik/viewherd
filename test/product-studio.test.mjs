import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRegistry, executeCommand } from '../packages/core/index.mjs';
import { createMemoryStore, createViewherdHandler } from '../packages/server/index.mjs';
import { studioPanels, createStudioState } from '../examples/product-studio/domain.mjs';

globalThis.crypto ??= webcrypto;
const studioRegistry = createRegistry(studioPanels);
function studioSession() {
  let state = createStudioState(), sequence = 0;
  return {
    get state() { return state; },
    panes(type) { return Object.values(state.panes).filter(pane => pane.view === type); },
    async call(method, params, options = {}) {
      const { principal = { id: 'designer', actor: 'human:designer' }, ...envelope } = options;
      const outcome = await executeCommand(state, { version: 1, sessionId: state.sessionId, requestId: `studio-test-${++sequence}`, method, params, ...envelope }, { registry: studioRegistry, principal });
      state = outcome.state; return outcome;
    },
    async action(paneId, action, args = {}, options = {}) { return this.call('panel.action', { paneId, action, args }, options); },
  };
}

test('studio starts with a real control/artboard split and isolated product data', async () => {
  const session = studioSession(), other = createStudioState('other-studio');
  assert.equal(session.state.panes.pane_inbox.view, 'studio');
  assert.equal(session.state.panes.pane_design_seed.data.designId, 'design_sand');
  assert.equal(session.state.workspaces[0].tabs[0].layout.ratio, 0.30);
  assert.equal(session.state.panes.pane_inbox.title, 'Studio chat');
  assert.equal(session.state.workspaces[0].tabs[0].focusedPaneId, 'pane_inbox', 'compact screens start in chat');
  assert.deepEqual(session.state.app.chat, { turns: [], activeTurnId: null });
  assert.equal(session.state.app.asset.name, 'FORMA One headphones');
  assert.match(session.state.app.asset.src, /^data:image\/webp;base64,/);
  assert.deepEqual(studioRegistry.schema().map(panel => panel.type), ['studio', 'canvas', 'inspector', 'deliverables']);
  session.state.app.designs.design_sand.headline = 'Personal draft';
  assert.notEqual(other.app.designs.design_sand.headline, 'Personal draft');
  // The manually seeded split still passes the SDK's complete state validation.
  assert.equal((await session.call('api.schema', {})).changed, false);
});

test('creating directions atomically adds a real comparison pane and preserves edits on reopening', async () => {
  const session = studioSession(), original = structuredClone(session.state);
  const first = await session.action('pane_inbox', 'createDirections');
  assert.equal(first.state.revision, 1);
  assert.equal(first.state.events.length, 1);
  assert.equal(session.panes('canvas').length, 2);
  assert.equal(session.panes('studio').length, 1);
  assert.deepEqual(first.result.created, ['design_midnight']);
  assert.equal(first.result.paneIds[0], 'pane_design_seed');
  assert.equal(original.app.designs.design_midnight, undefined);
  assert.equal(session.state.app.selectedDesignId, 'design_midnight');
  await session.action('pane_inbox', 'refine', { headline: 'Your music.\nYour moment.', theme: 'cobalt', cta: 'Listen closer' });
  const paneIds = session.panes('canvas').map(pane => pane.id);
  const repeated = await session.action('pane_inbox', 'createDirections');
  assert.equal(repeated.changed, false);
  assert.deepEqual(session.panes('canvas').map(pane => pane.id), paneIds);
  assert.equal(session.state.app.designs.design_midnight.headline, 'Your music.\nYour moment.');
  assert.equal(session.state.app.designs.design_midnight.theme, 'cobalt');
});

test('editing controls and winner selection close other panels without losing saved directions', async () => {
  const session = studioSession();
  await session.action('pane_inbox', 'createDirections');
  const inspected = await session.action('pane_inbox', 'inspect');
  assert.equal(session.panes('canvas').length, 1);
  assert.equal(session.panes('inspector').length, 1);
  await session.action(inspected.result.paneId, 'update', { format: 'story', subhead: 'Made for the moments that matter.' }, { expectedRevision: session.state.revision });
  await session.action('pane_inbox', 'compare');
  assert.equal(session.panes('inspector').length, 0);
  assert.equal(session.panes('canvas').length, 2);
  const midnight = session.panes('canvas').find(pane => pane.data.designId === 'design_midnight');
  const selected = await session.action(midnight.id, 'select');
  assert.equal(session.panes('canvas').length, 1);
  assert.equal(session.panes('canvas')[0].id, selected.result.paneId);
  assert.equal(session.state.app.designs.design_midnight.format, 'story');
  assert.equal(Object.keys(session.state.app.designs).length, 2);
  await session.action('pane_inbox', 'compare');
  assert.equal(session.panes('canvas').length, 2);
  assert.equal(session.state.app.designs.design_midnight.subhead, 'Made for the moments that matter.');
});

test('stale human edits fail without changing copy or layout', async () => {
  const session = studioSession();
  const inspect = await session.action('pane_inbox', 'inspect');
  const revision = session.state.revision;
  await session.action('pane_inbox', 'refine', { headline: 'A newer edit' });
  const before = structuredClone(session.state);
  await assert.rejects(session.action(inspect.result.paneId, 'update', { headline: 'Outdated edit' }, { expectedRevision: revision }), error => error.code === 'revision_conflict');
  assert.deepEqual(session.state, before);
});

test('standalone export embeds the photo, escapes copy, and reflects the latest live edits', async () => {
  const session = studioSession();
  await session.action('pane_inbox', 'refine', { headline: '<script> & sound', subhead: '"Listen" <closer>', format: 'story', theme: 'midnight' });
  const exported = await session.action('pane_inbox', 'export');
  const result = exported.result;
  assert.equal(result.width, 1080); assert.equal(result.height, 1920);
  assert.equal(result.filename, 'forma-one-midnight-story.svg');
  assert.match(result.svg, /&lt;script&gt; &amp; sound/);
  assert.doesNotMatch(result.svg, /<script>/);
  assert.ok(result.svg.includes(session.state.app.asset.src));
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength < 160000);
  assert.equal(session.panes('deliverables').length, 1);
  assert.equal(session.state.app.lastExport.filename, result.filename);
  await session.action('pane_inbox', 'refine', { cta: 'Get yours today' });
  assert.equal(session.state.app.lastExport, null);
  const download = await session.action(result.paneId, 'export');
  assert.equal(download.changed, false);
  assert.match(download.result.svg, /Get yours today/);
});

test('invalid copy, unsupported fields, and unsafe photo URLs roll back completely', async () => {
  const session = studioSession(), before = structuredClone(session.state);
  for (const [action, args, code] of [
    ['refine', { headline: '   ' }, 'empty_copy'],
    ['refine', { theme: 'javascript:alert(1)' }, 'schema_validation'],
    ['refine', { unknown: 'field' }, 'schema_validation'],
    ['upload', { name: 'Bad asset', src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }, 'invalid_image'],
    ['upload', { name: 'Bad asset', src: 'data:image/png;base64,YmFkLWltYWdlLXBhZGRpbmc=' }, 'invalid_image'],
    ['upload', { name: 'Large asset', src: `data:image/webp;base64,${'A'.repeat(120000)}` }, 'schema_validation'],
  ]) {
    await assert.rejects(session.action('pane_inbox', action, args), error => error.code === code);
    assert.deepEqual(session.state, before);
  }
  const uploaded = await session.action('pane_inbox', 'upload', { name: 'My product', src: session.state.app.asset.src });
  assert.equal(uploaded.result.changed, true);
  assert.equal(session.state.app.designs.design_sand.headline, before.app.designs.design_sand.headline);
});

test('removing a direction closes its panels, keeps a survivor, and refuses deleting the last design', async () => {
  const session = studioSession();
  await session.action('pane_inbox', 'createDirections');
  const midnight = session.panes('canvas').find(pane => pane.data.designId === 'design_midnight');
  const result = await session.action(midnight.id, 'remove');
  assert.equal(result.result.removed, true);
  assert.equal(session.state.app.designs.design_midnight, undefined);
  assert.equal(session.state.app.selectedDesignId, 'design_sand');
  assert.equal(session.panes('canvas').length, 1);
  const before = structuredClone(session.state);
  await assert.rejects(session.action(session.panes('canvas')[0].id, 'remove'), error => error.code === 'last_design');
  assert.deepEqual(session.state, before);
});

test('explicit reset restores the original photo and split while discarding only studio data', async () => {
  const session = studioSession(), original = createStudioState().app;
  await session.action('pane_inbox', 'createDirections');
  await session.action('pane_inbox', 'refine', { headline: 'A custom campaign' });
  await session.action('pane_inbox', 'export');
  const reset = await session.action('pane_inbox', 'reset');
  assert.equal(reset.result.reset, true);
  assert.deepEqual(session.state.app, original);
  assert.equal(session.panes('studio').length, 1);
  assert.equal(session.panes('canvas').length, 1);
  assert.equal(Object.keys(session.state.panes).length, 2);
  assert.equal(session.state.workspaces[0].tabs[0].layout.ratio, 0.30);
});

test('an exact HTTP retry reuses the created pane IDs and the export receipt', async () => {
  const store = createMemoryStore({ createState: createStudioState });
  const handler = createViewherdHandler({ registry: studioRegistry, store, authorize: () => ({ id: 'designer' }), sessionId: 'product-studio' });
  const rpc = async (requestId, action) => {
    const body = { version: 1, sessionId: 'product-studio', requestId, method: 'panel.action', params: { paneId: 'pane_inbox', action, args: {} } };
    const response = await handler(new Request('https://studio.example/viewherd/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    assert.equal(response.status, 200);
    return response.json();
  };
  const opened = await rpc('create-once', 'createDirections');
  const retry = await rpc('create-once', 'createDirections');
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.result, opened.result);
  assert.equal(retry.revision, 1);
  const exported = await rpc('export-once', 'export');
  const exportedRetry = await rpc('export-once', 'export');
  assert.equal(exportedRetry.replayed, true);
  assert.deepEqual(exportedRetry.result, exported.result);
  assert.equal(exportedRetry.state.app.history.filter(event => event.action === 'export').length, 1);
});

const agentPrincipal = (turnId, serverTime = 1000, id = 'designer') => ({ id, actor: 'agent:studio', roles: ['studio-agent'], turnId, serverTime });
const beginArgs = (turnId, message = 'Create two directions', expiresAt = 120000) => ({ turnId, message, mode: 'demo', expiresAt });

test('only a trusted turn owner can write the persistent conversation', async () => {
  const session = studioSession(), before = structuredClone(session.state);
  for (const principal of [
    { id: 'designer' },
    { id: 'designer', roles: ['studio-agent'], serverTime: 1000 },
    { ...agentPrincipal('turn_one'), turnId: 'turn_other' },
    { ...agentPrincipal('turn_one'), serverTime: undefined },
  ]) {
    // Undefined is excluded because the SDK requires a JSON principal.
    const clean = Object.fromEntries(Object.entries(principal).filter(([, value]) => value !== undefined));
    await assert.rejects(session.action('pane_inbox', 'beginTurn', beginArgs('turn_one'), { principal: clean }), error => error.code === 'agent_forbidden');
    assert.deepEqual(session.state, before);
  }
  await session.action('pane_inbox', 'beginTurn', beginArgs('turn_one'), { principal: agentPrincipal('turn_one') });
  const started = structuredClone(session.state);
  await assert.rejects(session.action('pane_inbox', 'updateTurn', { turnId: 'turn_one', reply: 'Spoofed text' }, { principal: agentPrincipal('turn_one', 1100, 'another-user') }), error => error.code === 'agent_cancelled');
  assert.deepEqual(session.state, started);
  assert.equal(session.state.app.chat.activeTurnId, 'turn_one');
  assert.equal(session.state.app.chat.turns[0].ownerId, 'designer');
});

test('turn retries preserve the original message and lease while an expired turn yields to a new one', async () => {
  const session = studioSession();
  // Existing stored workspaces can start a chat without resetting their designs.
  delete session.state.app.chat;
  session.state.panes.pane_inbox.title = 'Creative brief';
  session.state.workspaces[0].tabs[0].layout.ratio = 0.38;
  session.state.app.designs.design_sand.headline = 'A saved human edit';
  const first = await session.action('pane_inbox', 'beginTurn', beginArgs('turn_one'), { principal: agentPrincipal('turn_one') });
  assert.equal(session.state.panes.pane_inbox.title, 'Studio chat');
  assert.equal(session.state.workspaces[0].tabs[0].layout.ratio, 0.38);
  const retry = await session.action('pane_inbox', 'beginTurn', beginArgs('turn_one', 'Create two directions', 130000), { principal: agentPrincipal('turn_one', 1100) });
  assert.equal(retry.changed, false);
  assert.equal(retry.result.replayed, true);
  assert.deepEqual(retry.result.turn, first.result.turn);
  await assert.rejects(session.action('pane_inbox', 'beginTurn', beginArgs('turn_one', 'Different message'), { principal: agentPrincipal('turn_one') }), error => error.code === 'turn_conflict');
  await assert.rejects(session.action('pane_inbox', 'beginTurn', beginArgs('turn_two'), { principal: agentPrincipal('turn_two', 1100) }), error => error.code === 'turn_in_progress');
  await session.action('pane_inbox', 'updateTurn', { turnId: 'turn_one', step: { id: 'step_one', label: 'Creating the directions', status: 'running', action: 'createDirections' } }, { principal: agentPrincipal('turn_one') });
  await session.action('pane_inbox', 'beginTurn', beginArgs('turn_two', 'Try again', 240000), { principal: agentPrincipal('turn_two', 120001) });
  assert.equal(session.state.app.chat.turns[0].status, 'failed');
  assert.equal(session.state.app.chat.turns[0].steps[0].status, 'failed');
  assert.equal(session.state.app.chat.activeTurnId, 'turn_two');
  assert.equal(session.state.app.designs.design_sand.headline, 'A saved human edit');
  const before = structuredClone(session.state);
  await assert.rejects(session.action('pane_inbox', 'createDirections', {}, { principal: agentPrincipal('turn_one', 120001) }), error => error.code === 'agent_cancelled');
  assert.deepEqual(session.state, before);
});

test('agent tool actions commit visible panels and stable steps before the turn completes', async () => {
  const session = studioSession(), principal = agentPrincipal('turn_one');
  await session.action('pane_inbox', 'beginTurn', beginArgs('turn_one'), { principal });
  const step = { id: 'step_one', label: 'Creating two directions', status: 'running', action: 'createDirections' };
  await session.action('pane_inbox', 'updateTurn', { turnId: 'turn_one', step }, { principal });
  const created = await session.action('pane_inbox', 'createDirections', {}, { principal });
  assert.equal(session.panes('canvas').length, 2);
  await session.action('pane_inbox', 'updateTurn', { turnId: 'turn_one', reply: 'Here are two directions.', step: { ...step, status: 'done', revision: created.state.revision } }, { principal });
  const repeatedStart = await session.action('pane_inbox', 'updateTurn', { turnId: 'turn_one', step }, { principal });
  assert.equal(repeatedStart.changed, false);
  assert.equal(session.state.app.chat.turns[0].steps.length, 1);
  assert.equal(session.state.app.chat.turns[0].steps[0].status, 'done');
  await session.action('pane_inbox', 'finishTurn', { turnId: 'turn_one', status: 'completed', reply: 'Here are two directions. Which one do you prefer?' }, { principal });
  assert.equal(session.state.app.chat.activeTurnId, null);
  const complete = structuredClone(session.state);
  const finishRetry = await session.action('pane_inbox', 'finishTurn', { turnId: 'turn_one', status: 'failed', reply: 'An old retry' }, { principal });
  assert.equal(finishRetry.result.replayed, true);
  assert.equal(finishRetry.changed, false);
  await assert.rejects(session.action('pane_inbox', 'refine', { theme: 'cobalt' }, { principal }), error => error.code === 'agent_cancelled');
  assert.deepEqual(session.state, complete);
});

test('finishing reconciles verified action results when its earlier progress write was lost', async () => {
  const session = studioSession(), principal = agentPrincipal('turn_one');
  await session.action('pane_inbox', 'beginTurn', beginArgs('turn_one'), { principal });
  const step = { id: 'step_one', label: 'Creating two directions', status: 'running', action: 'createDirections' };
  await session.action('pane_inbox', 'updateTurn', { turnId: 'turn_one', step }, { principal });
  const created = await session.action('pane_inbox', 'createDirections', {}, { principal });
  // The SDK action committed, but its done metadata did not reach persistence.
  await session.action('pane_inbox', 'updateTurn', { turnId: 'turn_one', step: { id: 'step_two', label: 'Editing the palette', status: 'running', action: 'refine' } }, { principal });
  await session.action('pane_inbox', 'finishTurn', { turnId: 'turn_one', status: 'failed', reply: 'The directions were created, but I could not finish.', steps: [{ ...step, status: 'done', revision: created.state.revision }] }, { principal });
  const turn = session.state.app.chat.turns[0];
  assert.equal(turn.status, 'failed');
  assert.equal(turn.steps[0].status, 'done');
  assert.equal(turn.steps[0].revision, created.state.revision);
  assert.equal(turn.steps[1].status, 'failed');
  assert.equal(session.panes('canvas').length, 2);
});

test('explicit design targets protect against a changed selection and controller removal deletes the target', async () => {
  const session = studioSession();
  await session.action('pane_inbox', 'createDirections');
  await session.action('pane_inbox', 'select', { designId: 'design_sand' });
  await session.action('pane_inbox', 'refine', { designId: 'design_midnight', headline: 'A precise edit', theme: 'cobalt' });
  assert.equal(session.state.app.designs.design_midnight.headline, 'A precise edit');
  assert.notEqual(session.state.app.designs.design_sand.headline, 'A precise edit');
  assert.equal(session.state.app.designs.design_midnight.designId, undefined);
  const removed = await session.action('pane_inbox', 'remove', { designId: 'design_midnight' });
  assert.equal(removed.result.removed, true);
  assert.equal(session.state.app.designs.design_midnight, undefined);
  assert.equal(session.panes('canvas')[0].data.designId, 'design_sand');
});

test('human reset cancels running agent work while an agent reset keeps its transcript', async () => {
  const session = studioSession(), principal = agentPrincipal('turn_one');
  await session.action('pane_inbox', 'beginTurn', beginArgs('turn_one'), { principal });
  await session.action('pane_inbox', 'createDirections', {}, { principal });
  await session.action('pane_inbox', 'reset', {}, { principal });
  assert.equal(session.state.app.chat.activeTurnId, 'turn_one');
  assert.equal(session.state.app.chat.turns.length, 1);
  assert.equal(Object.keys(session.state.app.designs).length, 1);
  await session.action('pane_inbox', 'createDirections', {}, { principal });
  await session.action('pane_inbox', 'reset');
  assert.deepEqual(session.state.app.chat, { turns: [], activeTurnId: null });
  const before = structuredClone(session.state);
  for (const [action, args] of [
    ['createDirections', {}], ['upload', { name: 'Obsolete upload', src: session.state.app.asset.src }],
    ['finishTurn', { turnId: 'turn_one', status: 'completed', reply: 'Late completion' }],
  ]) {
    await assert.rejects(session.action('pane_inbox', action, args, { principal }), error => error.code === 'agent_cancelled');
    assert.deepEqual(session.state, before);
  }
});

test('expired agents cannot edit or stream but can release their own turn as failed', async () => {
  const session = studioSession();
  await session.action('pane_inbox', 'beginTurn', beginArgs('turn_one', 'Change the palette', 2000), { principal: agentPrincipal('turn_one') });
  const expired = agentPrincipal('turn_one', 2000), before = structuredClone(session.state);
  await assert.rejects(session.action('pane_inbox', 'refine', { theme: 'cobalt' }, { principal: expired }), error => error.code === 'agent_cancelled');
  await assert.rejects(session.action('pane_inbox', 'updateTurn', { turnId: 'turn_one', reply: 'Too late' }, { principal: expired }), error => error.code === 'agent_cancelled');
  assert.deepEqual(session.state, before);
  await session.action('pane_inbox', 'finishTurn', { turnId: 'turn_one', status: 'failed', reply: 'The request timed out. Please try again.' }, { principal: expired });
  assert.equal(session.state.app.chat.activeTurnId, null);
  assert.equal(session.state.app.chat.turns[0].status, 'failed');
});

test('conversation and tool histories are bounded without discarding current progress', async () => {
  const session = studioSession();
  for (let index = 0; index < 13; index += 1) {
    const turnId = `turn_${index}`, principal = agentPrincipal(turnId);
    await session.action('pane_inbox', 'beginTurn', beginArgs(turnId, `Message ${index}`), { principal });
    await session.action('pane_inbox', 'finishTurn', { turnId, status: 'completed', reply: `Reply ${index}` }, { principal });
  }
  assert.equal(session.state.app.chat.turns.length, 12);
  assert.equal(session.state.app.chat.turns[0].id, 'turn_1');
  const principal = agentPrincipal('turn_new');
  await session.action('pane_inbox', 'beginTurn', beginArgs('turn_new'), { principal });
  for (let index = 0; index < 12; index += 1) await session.action('pane_inbox', 'updateTurn', { turnId: 'turn_new', step: { id: `step_${index}`, label: 'Work completed', status: 'done', action: 'refine' } }, { principal });
  const before = structuredClone(session.state);
  await assert.rejects(session.action('pane_inbox', 'updateTurn', { turnId: 'turn_new', step: { id: 'step_extra', label: 'One more', status: 'running', action: 'refine' } }, { principal }), error => error.code === 'step_limit');
  await assert.rejects(session.action('pane_inbox', 'updateTurn', { turnId: 'turn_new', reply: 'x'.repeat(4001) }, { principal }), error => error.code === 'schema_validation');
  assert.deepEqual(session.state, before);
});
