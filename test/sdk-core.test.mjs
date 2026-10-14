import test from 'node:test';
import assert from 'node:assert/strict';
import { definePanel, createRegistry, createSession, executeCommand } from '../packages/core/index.mjs';
import { execute } from '../src/core.mjs';

const empty = { type: 'object', additionalProperties: false };
function fixture(extraActions = {}) {
  const registry = createRegistry([definePanel({
    type: 'counter', title: 'Shared counter',
    dataSchema: { type: 'object', properties: { filter: { type: 'string' } }, required: ['filter'], additionalProperties: false },
    actions: {
      increment: { inputSchema: empty, outputSchema: { type: 'integer' }, run(ctx) { ctx.app.count += 1; return ctx.app.count; } },
      noop: { inputSchema: empty, run() { return { unchanged: true }; } },
      ...extraActions,
    },
  })]);
  const state = createSession({ id: 'test-session', label: 'Test workspace', view: 'counter', title: 'Counter', data: { filter: 'all' }, app: { count: 0, nested: { label: 'before' } }, registry });
  const command = (method, params, additions = {}) => ({ version: 1, requestId: 'request-1', sessionId: state.sessionId, method, params, ...additions });
  const action = (name, args = {}, additions = {}) => command('panel.action', { paneId: 'pane_inbox', action: name, args }, additions);
  return { registry, state, command, action };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('panel registration is immutable, serializable and rejects duplicate, unsafe, or unsupported schemas', () => {
  const { registry } = fixture();
  const schema = registry.schema();
  assert.equal(schema[0].type, 'counter');
  assert.equal(schema[0].actions[0].name, 'increment');
  assert.ok(!JSON.stringify(schema).includes('run'));
  schema[0].dataSchema.required.push('mutated');
  assert.deepEqual(registry.schema()[0].dataSchema.required, ['filter']);
  assert.ok(Object.isFrozen(registry.get('counter').actions));
  assert.throws(() => createRegistry([registry.get('counter'), registry.get('counter')]), error => error.code === 'duplicate_panel');
  assert.throws(() => definePanel({ type: 'document' }), error => error.code === 'invalid_definition');
  assert.throws(() => definePanel({ type: '__proto__' }), error => error.code === 'invalid_definition');
  assert.throws(() => definePanel({ type: 'bad', dataSchema: { type: 'object', anyOf: [] } }), error => error.code === 'unsupported_schema');
  assert.throws(() => definePanel({ type: 'bad', dataSchema: { type: 'string', pattern: '[' } }), error => error.code === 'invalid_definition');
  assert.doesNotThrow(() => definePanel({ type: 'ticket', actions: { openCustomer: { run: () => null } } }));
});

test('custom initial panes are eagerly validated when a registry is supplied', () => {
  const { registry } = fixture();
  assert.throws(() => createSession({ id: 'x', view: 'counter', data: { filter: 42 }, registry }), error => error.code === 'schema_validation');
  const state = createSession({ id: 'x', view: 'counter', data: { filter: 'all' } });
  assert.equal(state.panes.pane_inbox.view, 'counter');
  const defaults = createSession({ id: 'document-session' });
  assert.equal(defaults.panes.pane_inbox.data.content, '');
  assert.equal(defaults.revision, 0);
});

test('registered types reuse legacy create, split, open and update operations without changing standalone defaults', async () => {
  const { registry, state, command } = fixture();
  let outcome = await executeCommand(state, command('pane.split', { paneId: 'pane_inbox', view: 'counter', data: { filter: 'pending' } }), { registry });
  const secondId = outcome.result.paneId;
  assert.equal(outcome.state.panes[secondId].title, 'Shared counter');
  outcome = await executeCommand(outcome.state, command('view.update', { paneId: secondId, data: { filter: 'open' } }), { registry });
  assert.equal(outcome.state.panes[secondId].data.filter, 'open');
  await rejectsCode(executeCommand(outcome.state, command('view.update', { paneId: secondId, data: { filter: 8 } }), { registry }), 'schema_validation');
  outcome = await executeCommand(outcome.state, command('view.open', { paneId: secondId, view: 'document', data: { content: 'kept' } }), { registry });
  outcome = await executeCommand(outcome.state, command('view.open', { paneId: secondId, view: 'counter', data: { filter: 'all' } }), { registry });
  outcome = await executeCommand(outcome.state, command('tab.create', { label: 'Second', view: 'counter', data: { filter: 'all' } }), { registry });
  outcome = await executeCommand(outcome.state, command('workspace.create', { label: 'Another', view: 'counter', data: { filter: 'all' } }), { registry });
  assert.equal(outcome.state.workspaces.length, 2);
  assert.throws(() => execute(state, 'pane.split', { paneId: 'pane_inbox', view: 'counter', data: { filter: 'all' } }), error => error.code === 'INVALID_PARAMS');
});

test('application actions and nested layout operations commit one event and preserve live references', async () => {
  const { registry, state, action } = fixture({
    complex: {
      inputSchema: empty,
      run(ctx) {
        const nested = ctx.app.nested, pane = ctx.pane;
        ctx.app.count += 1;
        const split = ctx.call('pane.split', { paneId: pane.id, view: 'counter', data: { filter: 'other' } });
        ctx.call('view.update', { paneId: pane.id, title: 'Updated', data: { filter: 'selected' } });
        nested.label = 'after';
        assert.equal(pane.title, 'Updated');
        return { paneId: split.paneId, principal: ctx.principal.id, requestId: ctx.requestId };
      },
    },
  });
  const outcome = await executeCommand(state, action('complex'), { registry, principal: { id: 'alice', actor: 'host:alice' } });
  assert.equal(outcome.state.revision, 1);
  assert.equal(outcome.state.events.length, 1);
  assert.equal(outcome.state.events[0].method, 'panel.action');
  assert.equal(outcome.state.events[0].actor, 'host:alice');
  assert.equal(outcome.state.app.nested.label, 'after');
  assert.equal(outcome.state.panes.pane_inbox.title, 'Updated');
  assert.equal(outcome.result.principal, 'alice');
  assert.equal(outcome.state.app.count, 1);
  assert.equal(state.app.count, 0);
  assert.equal(Object.keys(state.panes).length, 1);
});

test('async handlers resolve transactionally and retained contexts cannot mutate committed results later', async () => {
  let retained;
  const { registry, state, action } = fixture({ later: { inputSchema: empty, async run(ctx) { retained = ctx; await Promise.resolve(); ctx.app.count = 5; return { ok: true }; } } });
  const outcome = await executeCommand(state, action('later'), { registry });
  retained.app.count = 999;
  assert.equal(outcome.state.app.count, 5);
  assert.equal(state.app.count, 0);
});

test('handler failures, invalid return types, schemas and invalid drafts roll back every nested mutation', async () => {
  const { registry, state, action } = fixture({
    throwAfterSplit: { run(ctx) { ctx.app.count = 9; ctx.call('pane.split', { paneId: ctx.pane.id, view: 'document' }); throw new Error('host failed'); } },
    undefinedResult: { run(ctx) { ctx.app.count = 9; return undefined; } },
    outputMismatch: { outputSchema: { type: 'boolean' }, run(ctx) { ctx.app.count = 9; return 'wrong'; } },
    invalidData: { run(ctx) { ctx.pane.data.filter = 42; return null; } },
    invalidApp: { run(ctx) { ctx.app.nan = Infinity; return null; } },
    detached: { run(ctx) { delete ctx.state.panes.pane_inbox; return null; } },
    tooLarge: { run(ctx) { ctx.app.large = 'x'.repeat(900000); return null; } },
  });
  const before = JSON.stringify(state);
  await assert.rejects(executeCommand(state, action('throwAfterSplit'), { registry }), /host failed/);
  for (const [name, code] of [['undefinedResult', 'invalid_params'], ['outputMismatch', 'schema_validation'], ['invalidData', 'schema_validation'], ['invalidApp', 'invalid_params'], ['detached', 'invalid_state'], ['tooLarge', 'state_limit']]) await rejectsCode(executeCommand(state, action(name), { registry }), code);
  assert.equal(JSON.stringify(state), before);
});

test('request IDs, sessions and revision preconditions are checked before the handler runs', async () => {
  let called = 0;
  const { registry, state, action } = fixture({ counted: { run() { called++; return null; } } });
  await rejectsCode(executeCommand(state, { ...action('counted'), requestId: '' }, { registry }), 'invalid_params');
  await rejectsCode(executeCommand(state, { ...action('counted'), sessionId: 'other' }, { registry }), 'session_mismatch');
  await rejectsCode(executeCommand(state, action('counted', {}, { expectedRevision: 4 }), { registry }), 'revision_conflict');
  await rejectsCode(executeCommand(state, { ...action('counted'), version: 2 }, { registry }), 'unsupported_version');
  await rejectsCode(executeCommand(state, action('constructor'), { registry }), 'unknown_action');
  assert.equal(called, 0);
});

test('no-op actions preserve the original state and revisions; reads are isolated', async () => {
  const { registry, state, action, command } = fixture();
  const noop = await executeCommand(state, action('noop'), { registry });
  assert.equal(noop.state, state);
  assert.equal(noop.changed, false);
  assert.equal(noop.state.revision, 0);
  const read = await executeCommand(state, command('session.snapshot', {}), { registry });
  read.result.app.count = 99;
  assert.equal(state.app.count, 0);
  const schema = await executeCommand(state, command('api.schema', {}), { registry });
  assert.ok(schema.result.methods.find(item => item.name === 'pane.split').inputSchema.properties.view.enum.includes('counter'));
  assert.ok(schema.result.methods.some(item => item.name === 'panel.action'));
});

test('schema validation rejects wrong arguments, extra keys and accepts supported numeric and Unicode constraints', async () => {
  const { registry, state, action } = fixture({ check: {
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 1, pattern: '^.$' }, value: { type: ['integer', 'null'], minimum: 1, maximum: 3 }, items: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'boolean' } }, mode: { const: { first: true, second: false } } }, required: ['name', 'value', 'items', 'mode'], additionalProperties: false },
    run(_ctx, args) { return args; },
  } });
  const args = { name: '😀', value: 2, items: [true], mode: { second: false, first: true } };
  const outcome = await executeCommand(state, action('check', args), { registry });
  assert.deepEqual(outcome.result, args);
  await rejectsCode(executeCommand(state, action('check', { ...args, value: 4 }), { registry }), 'schema_validation');
  await rejectsCode(executeCommand(state, action('check', { ...args, extra: true }), { registry }), 'schema_validation');
  await rejectsCode(executeCommand(state, action('check', { ...args, items: ['true'] }), { registry }), 'schema_validation');
  await rejectsCode(executeCommand(state, action('increment', { ignored: true }), { registry }), 'schema_validation');
});

test('hostile prototypes, accessors, sparse arrays and unsafe JSON never execute', async () => {
  const { registry, state, action } = fixture();
  const accessor = Object.defineProperty({}, 'bad', { enumerable: true, get() { throw new Error('getter ran'); } });
  for (const unsafe of [accessor, { date: new Date() }, { missing: undefined }, { list: [, 1] }, JSON.parse('{"__proto__":{}}')]) await rejectsCode(executeCommand(state, action('increment', unsafe), { registry }), 'invalid_params');
  const cyclic = {}; cyclic.self = cyclic;
  await rejectsCode(executeCommand(state, action('increment', cyclic), { registry }), 'invalid_params');
  const decoratedArray = [1]; decoratedArray['4294967295'] = () => 1;
  await rejectsCode(executeCommand(state, action('increment', { decoratedArray }), { registry }), 'invalid_params');
});

test('authenticated attribution overrides caller actor for both layout and application mutations', async () => {
  const { registry, state, action, command } = fixture();
  const app = await executeCommand(state, { ...action('increment'), params: { ...action('increment').params, actor: 'admin' } }, { registry, principal: { id: 'alice' } });
  assert.equal(app.state.events[0].actor, 'alice');
  const layout = await executeCommand(state, command('pane.split', { paneId: 'pane_inbox', view: 'document', actor: 'admin' }), { registry, principal: { id: 'bob' } });
  assert.equal(layout.state.events[0].actor, 'bob');
});

test('nested application actions and audit rewriting are rejected without committing partial changes', async () => {
  const { registry, state, action } = fixture({ nested: { run(ctx) { ctx.app.count = 6; ctx.call('panel.action', { paneId: ctx.pane.id, action: 'increment' }); return null; } }, forge: { run(ctx) { ctx.state.revision = 999; return null; } } });
  await rejectsCode(executeCommand(state, action('nested'), { registry }), 'nested_action');
  await rejectsCode(executeCommand(state, action('forge'), { registry }), 'invalid_state');
  assert.equal(state.app.count, 0);
  assert.equal(state.revision, 0);
});
