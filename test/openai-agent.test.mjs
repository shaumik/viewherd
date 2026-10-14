import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIAgent } from '../examples/product-studio/openai-agent.mjs';

const key = 'test-secret-server-key';
const studio = {
  sessionId: 'product-studio', revision: 4, selectedDesignId: 'design_sand',
  designs: [{ id: 'design_sand', name: 'Warm minimal', theme: 'sand', format: 'square', headline: 'Sound.', subhead: 'Wireless sound', eyebrow: 'FORMA', cta: 'Discover' }],
  panels: [{ id: 'pane_inbox', type: 'studio', title: 'Chat' }, { id: 'pane_art', type: 'canvas', title: 'Warm minimal', designId: 'design_sand' }],
  asset: { name: 'Headphones', src: 'data:image/png;base64,private-photo-bytes' }, lastExport: null,
  authorization: 'host-private-authorization', ownerId: 'private-owner',
};
const text = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] });
const tool = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
const response = output => new Response(JSON.stringify({ status: 'completed', output }), { headers: { 'Content-Type': 'application/json' } });

function harness(outputs, callbacks = {}) {
  const requests = [], calls = [], events = [];
  const agent = createOpenAIAgent({ apiKey: key, fetch: async (url, options) => {
    requests.push({ url, ...options, parsed: JSON.parse(options.body) });
    const output = outputs.shift();
    return typeof output === 'function' ? output(url, options) : response(output);
  } });
  return {
    agent, requests, calls, events,
    run: extras => agent.run({ message: 'Open two directions.', snapshot: async () => studio,
      call: async args => { calls.push(args); return callbacks.call ? callbacks.call(args) : { paneIds: ['pane_a', 'pane_b'], revision: 5 }; },
      emit: async event => { events.push(event); if (callbacks.emit) await callbacks.emit(event); }, ...extras }),
  };
}

test('a real Responses tool loop executes a backend action before emitting completion', async () => {
  let completed = false;
  const h = harness([
    [text('I opened two directions.'), tool('call_a', 'workspace_action', { action: 'createDirections', args: {}, label: 'Open two directions' })],
    [text('Choose a direction or ask me to refine it.')],
  ], { call: async () => { completed = true; return { created: ['design_sand', 'design_midnight'], revision: 5 }; }, emit: () => assert.equal(completed, true) });
  assert.equal(h.agent.mode, 'openai');
  const reply = await h.run();
  assert.match(reply, /opened two directions/);
  assert.match(reply, /refine it/);
  assert.deepEqual(h.calls, [{ action: 'createDirections', args: {}, label: 'Open two directions' }]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(h.requests[0].headers.Authorization, `Bearer ${key}`);
  assert.equal(h.requests[0].redirect, 'error');
  assert.equal(h.requests[0].parsed.stream, false);
  assert.equal(h.requests[0].parsed.store, false);
  assert.equal(h.requests[0].parsed.parallel_tool_calls, false);
  assert.equal(h.requests[0].parsed.tools.every(item => item.strict === false), true);
  const output = h.requests[1].parsed.input.find(item => item.type === 'function_call_output');
  assert.equal(output.call_id, 'call_a');
  assert.deepEqual(JSON.parse(output.output), { created: ['design_sand', 'design_midnight'], revision: 5 });
  assert.deepEqual(h.events.map(event => event.type), ['text', 'text']);
});

test('model context and tool outputs exclude private bytes and credentials', async () => {
  const h = harness([
    [tool('call_s', 'workspace_snapshot', {})],
    [tool('call_e', 'workspace_action', { action: 'export', args: {} })],
    [text(`Ready. ${key}`)],
  ], { call: async () => ({ filename: 'design.svg', svg: '<svg>photo bytes</svg>', src: 'private-photo-bytes', state: studio, authorization: 'host-private-authorization', token: key, revision: 6 }) });
  const reply = await h.run({ history: [{ message: 'Make it darker', reply: 'Changed it.', ownerId: 'private-owner', steps: [{ error: key }] }] });
  const bodies = h.requests.map(item => item.body).join('\n');
  for (const privateValue of ['private-photo-bytes', 'host-private-authorization', 'private-owner', key, '<svg>']) assert.equal(bodies.includes(privateValue), false, privateValue);
  assert.match(bodies, /Headphones/);
  assert.match(bodies, /design.svg/);
  assert.equal(reply.includes(key), false);
  assert.match(reply, /credential omitted/);
});

test('bad JSON, reserved fields, arbitrary actions, and unknown tools get corrective outputs without writes', async () => {
  const h = harness([
    [tool('call_1', 'workspace_action', '{broken')],
    [tool('call_2', 'workspace_action', '{"action":"refine","args":{"__proto__":{"bad":true}}}')],
    [tool('call_3', 'workspace_action', { action: 'fetch', args: { url: 'https://outside.example' } })],
    [tool('call_4', 'browser_execute', { code: 'alert(1)' })],
    [text('I can open, edit, compare, or export studio panels. Which would you like?')],
  ]);
  await h.run();
  assert.deepEqual(h.calls, []);
  const errors = h.requests.at(-1).parsed.input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output).error.code);
  assert.deepEqual(errors, Array(4).fill('invalid_arguments'));
  assert.equal({}.bad, undefined);
});

test('action-specific validation prevents unsupported or invalid design changes', async () => {
  const h = harness([
    [tool('call_1', 'workspace_action', { action: 'refine', args: { theme: 'outside' } })],
    [tool('call_2', 'workspace_action', { action: 'select', args: {} })],
    [tool('call_3', 'workspace_action', { action: 'inspect', args: { designId: 'design_sand' } })],
    [tool('call_4', 'workspace_action', { action: 'refine', args: { headline: ' ' } })],
    [tool('call_5', 'workspace_action', { action: 'refine', args: { designId: 'design_sand', theme: 'cobalt', format: 'story', headline: 'New sound' } })],
    [text('I changed the selected design.')],
  ]);
  await h.run();
  assert.deepEqual(h.calls, [{ action: 'refine', args: { designId: 'design_sand', theme: 'cobalt', format: 'story', headline: 'New sound' } }]);
});

test('failed actions never emit their premature success text and raw host errors are sanitized', async () => {
  const h = harness([
    [text('Done!'), tool('call_1', 'workspace_action', { action: 'refine', args: { theme: 'midnight' } })],
    [text('Your workspace changed. I left your latest edits in place.')],
  ], { call: async () => { throw Object.assign(new Error(`Raw prompt ${key}`), { code: 'revision_conflict' }); } });
  const reply = await h.run();
  assert.equal(reply.includes('Done!'), false);
  assert.equal(h.events.some(event => event.text.includes('Done!')), false);
  const output = h.requests[1].parsed.input.find(item => item.type === 'function_call_output');
  assert.equal(JSON.parse(output.output).error.code, 'revision_conflict');
  assert.equal(output.output.includes(key), false);
  assert.match(output.output, /workspace_snapshot/);
});

test('a conflicted write must reread the workspace before another write is allowed', async () => {
  let attempts = 0;
  const h = harness([
    [tool('call_1', 'workspace_action', { action: 'refine', args: { theme: 'midnight' } })],
    [tool('call_2', 'workspace_action', { action: 'refine', args: { theme: 'midnight' } })],
    [tool('call_3', 'workspace_snapshot', {})],
    [tool('call_4', 'workspace_action', { action: 'refine', args: { theme: 'midnight' } })],
    [text('Updated after checking your latest changes.')],
  ], { call: async () => { if (++attempts === 1) throw Object.assign(new Error('changed'), { code: 'revision_conflict' }); return { revision: 7 }; } });
  await h.run();
  assert.equal(attempts, 2);
  const outputs = h.requests.at(-1).parsed.input.filter(item => item.type === 'function_call_output');
  assert.equal(JSON.parse(outputs[1].output).error.code, 'revision_conflict');
});

test('reply text and emitted deltas remain within the backend total character limit', async () => {
  const h = harness([[text('a'.repeat(3999)), tool('call_1', 'workspace_snapshot', {})], [text('b'.repeat(500))]]);
  const reply = await h.run();
  assert.equal(reply.length, 3999);
  assert.equal(h.events.map(item => item.text).join(''), reply);
});

test('API and network failures do not expose upstream prompts, keys, or error bodies', async () => {
  const h = harness([() => new Response(`private prompt ${key}`, { status: 401 })]);
  await assert.rejects(h.run(), error => error.code === 'agent_credentials' && !error.message.includes(key) && !error.message.includes('prompt'));
  const network = createOpenAIAgent({ apiKey: key, fetch: async () => { throw new Error(`private prompt ${key}`); } });
  await assert.rejects(network.run({ message: 'Hello', snapshot: async () => studio, call: async () => {} }), error => error.code === 'agent_unavailable' && !error.message.includes(key));
});

test('the adapter bounds tool steps and refuses duplicate call IDs', async () => {
  const h = harness(Array.from({ length: 8 }, (_, i) => [tool(`call_${i}`, 'workspace_snapshot', {})]));
  await assert.rejects(h.run(), error => error.code === 'agent_limit');
  assert.equal(h.requests.length, 8);
  const duplicate = harness([[tool('call_a', 'workspace_snapshot', {})], [tool('call_a', 'workspace_action', { action: 'reset', args: {} })]]);
  await assert.rejects(duplicate.run(), error => error.code === 'agent_response');
  assert.deepEqual(duplicate.calls, []);
  const tooMany = harness([Array.from({ length: 11 }, (_, i) => tool(`call_${i}`, 'workspace_action', { action: 'createDirections', args: {} }))]);
  await assert.rejects(tooMany.run(), error => error.code === 'agent_limit');
  assert.deepEqual(tooMany.calls, []);
});

test('oversized and incomplete model responses are rejected before workspace actions', async () => {
  const large = harness([() => new Response('x'.repeat(256001))]);
  await assert.rejects(large.run(), error => error.code === 'agent_response');
  assert.deepEqual(large.calls, []);
  const incomplete = harness([() => new Response(JSON.stringify({ status: 'incomplete', output: [tool('call_a', 'workspace_action', { action: 'reset', args: {} })] }))]);
  await assert.rejects(incomplete.run(), error => error.code === 'agent_response');
  assert.deepEqual(incomplete.calls, []);
});

test('cancellation prevents model requests and subsequent backend writes', async () => {
  const controller = new AbortController();
  controller.abort(new Error(`private reason ${key}`));
  const h = harness([]);
  await assert.rejects(h.run({ signal: controller.signal }), error => error.name === 'AbortError' && !error.message.includes(key));
  assert.equal(h.requests.length, 0);
  const during = new AbortController();
  const later = harness([[tool('call_a', 'workspace_action', { action: 'createDirections', args: {} }), tool('call_b', 'workspace_action', { action: 'reset', args: {} })]], { call: async () => { during.abort(); return { revision: 5 }; } });
  await assert.rejects(later.run({ signal: during.signal }), error => error.name === 'AbortError');
  assert.equal(later.calls.length, 1);
});

test('custom reasoning models retain encrypted reasoning in stateless tool continuation', async () => {
  const h = harness([
    [{ type: 'reasoning', id: 'rs_a', summary: [], encrypted_content: 'opaque-encrypted-reasoning' }, tool('call_a', 'workspace_snapshot', {})],
    [text('The warm design is selected.')],
  ]);
  await h.run();
  assert.deepEqual(h.requests[1].parsed.input.find(item => item.type === 'reasoning'), { type: 'reasoning', id: 'rs_a', summary: [], encrypted_content: 'opaque-encrypted-reasoning' });
  assert.deepEqual(h.requests[0].parsed.include, ['reasoning.encrypted_content']);
});
