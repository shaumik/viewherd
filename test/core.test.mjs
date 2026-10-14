import test from 'node:test';
import assert from 'node:assert/strict';
import { API_METHODS, LIMITS, createInitialState, execute, getSnapshot } from '../src/core.mjs';

function session() {
  let state = createInitialState();
  return { get state() { return state; }, call(method, params = {}) { const outcome = execute(state, method, params); state = outcome.state; return outcome; } };
}
function ids(layout) { return layout.type === 'pane' ? [layout.paneId] : [...ids(layout.first), ...ids(layout.second)]; }
function invariant(state) {
  assert.equal(state.version, 1);
  assert.ok(state.workspaces.some(w => w.id === state.activeWorkspaceId));
  const seen = [];
  for (const ws of state.workspaces) {
    assert.ok(ws.tabs.length > 0);
    assert.ok(ws.tabs.some(t => t.id === ws.activeTabId));
    for (const tab of ws.tabs) {
      const leaves = ids(tab.layout);
      assert.ok(leaves.includes(tab.focusedPaneId));
      assert.ok(tab.zoomedPaneId === null || leaves.includes(tab.zoomedPaneId));
      for (const paneId of leaves) { assert.ok(state.panes[paneId]); seen.push(paneId); }
    }
  }
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual([...seen].sort(), Object.keys(state.panes).sort());
  for (const agent of state.agents) if (agent.paneId) assert.ok(state.panes[agent.paneId]);
}
function throwsCode(fn, code) { assert.throws(fn, error => error.code === code); }

test('initial state is a valid, useful shared workspace', () => {
  const state = createInitialState(); invariant(state);
  assert.equal(state.revision, 0);
  assert.ok(state.panes.pane_brief.data.content.includes('stable ID'));
  assert.ok(state.panes.pane_preview.data.html.includes('<html>'));
});

test('snapshots and reads are isolated and leave revision unchanged', () => {
  const s = session(), before = JSON.stringify(s.state);
  const snapshot = s.call('session.snapshot');
  snapshot.result.workspaces[0].label = 'External edit';
  getSnapshot(s.state).panes.pane_brief.data.content = 'External edit';
  for (const method of ['workspace.list', 'tab.list', 'pane.list', 'pane.get', 'api.schema']) {
    const outcome = s.call(method); assert.equal(outcome.changed, false); assert.equal(s.state.revision, 0);
  }
  assert.equal(JSON.stringify(s.state), before);
});

test('new workspaces and tabs return addressable IDs and focus correctly', () => {
  const s = session();
  const { result: ws } = s.call('workspace.create', { label: 'Release', view: 'tasks', title: 'Checklist', data: { items: [] }, actor: 'agent/lead' });
  assert.equal(s.state.activeWorkspaceId, ws.workspaceId);
  assert.equal(s.state.panes[ws.paneId].view, 'tasks');
  assert.equal(s.state.events[0].actor, 'agent/lead');
  const { result: tab } = s.call('tab.create', { workspaceId: ws.workspaceId, label: 'Design', view: 'preview', data: { html: '<h1>Release</h1>' } });
  assert.equal(s.state.workspaces[1].activeTabId, tab.tabId);
  assert.equal(s.state.panes[tab.paneId].data.html, '<h1>Release</h1>');
  s.call('workspace.rename', { workspaceId: ws.workspaceId, label: 'Launch' });
  s.call('tab.rename', { tabId: tab.tabId, label: 'Website' });
  s.call('workspace.focus', { workspaceId: 'ws_lab' });
  s.call('tab.focus', { tabId: tab.tabId });
  assert.equal(s.state.activeWorkspaceId, ws.workspaceId);
  invariant(s.state);
});

test('split, resize, focus, zoom and close preserve layout invariants', () => {
  const s = session(), { result } = s.call('pane.split', { paneId: 'pane_brief', direction: 'down', ratio: 0.35, view: 'tasks', title: 'Release tasks' });
  assert.equal(s.state.workspaces[0].tabs[0].layout.first.direction, 'down');
  s.call('pane.resize', { splitId: result.splitId, ratio: 0.7 });
  assert.equal(s.state.workspaces[0].tabs[0].layout.first.ratio, 0.7);
  s.call('pane.zoom', { paneId: result.paneId, enabled: true });
  assert.equal(s.state.workspaces[0].tabs[0].zoomedPaneId, result.paneId);
  s.call('pane.focus', { paneId: 'pane_brief' });
  s.call('pane.close', { paneId: result.paneId });
  assert.equal(s.state.workspaces[0].tabs[0].zoomedPaneId, null);
  assert.equal(s.state.workspaces[0].tabs[0].layout.first.type, 'pane');
  invariant(s.state);
});

test('pane moves are real layout mutations within a tab and across tabs', () => {
  const s = session();
  s.call('pane.move', { paneId: 'pane_brief', targetPaneId: 'pane_preview', direction: 'down' });
  assert.equal(s.state.workspaces[0].tabs[0].layout.direction, 'down');
  assert.equal(s.state.workspaces[0].tabs[0].layout.second.paneId, 'pane_brief');
  const extra = s.call('pane.split', { paneId: 'pane_preview', title: 'Extra' }).result;
  const newTab = s.call('tab.create', { label: 'Second' }).result;
  s.call('pane.move', { paneId: extra.paneId, targetPaneId: newTab.paneId, direction: 'right' });
  assert.equal(s.state.workspaces[0].activeTabId, newTab.tabId);
  assert.equal(s.state.workspaces[0].tabs[1].focusedPaneId, extra.paneId);
  assert.equal(ids(s.state.workspaces[0].tabs[0].layout).includes(extra.paneId), false);
  invariant(s.state);
});

test('invalid moves do not detach panes or mutate caller state', () => {
  const s = session(), ws = s.call('workspace.create', { label: 'Other' }).result;
  const before = JSON.stringify(s.state);
  throwsCode(() => s.call('pane.move', { paneId: 'pane_brief', targetPaneId: ws.paneId }), 'CONFLICT');
  throwsCode(() => s.call('pane.move', { paneId: ws.paneId, targetPaneId: ws.paneId }), 'CONFLICT');
  const tab = s.call('tab.create', { label: 'Another' }).result;
  const beforeLastMove = JSON.stringify(s.state);
  throwsCode(() => s.call('pane.move', { paneId: ws.paneId, targetPaneId: tab.paneId }), 'CONFLICT');
  assert.equal(JSON.stringify(s.state), beforeLastMove);
  assert.notEqual(JSON.stringify(s.state), before); invariant(s.state);
});

test('documents, previews and tasks support structured read/write/action operations', () => {
  const s = session();
  s.call('view.action', { paneId: 'pane_brief', action: 'set', args: { content: '# Launch\n' } });
  s.call('view.action', { paneId: 'pane_brief', action: 'append', args: { content: 'Ship together.' } });
  assert.equal(s.state.panes.pane_brief.data.content, '# Launch\nShip together.');
  s.call('view.update', { paneId: 'pane_brief', data: { content: 'Approved' }, title: 'Brief' });
  assert.equal(s.state.panes.pane_brief.title, 'Brief');
  s.call('view.action', { paneId: 'pane_preview', action: 'set_html', args: { html: '<h1>Ready</h1>' } });
  assert.equal(s.state.panes.pane_preview.data.html, '<h1>Ready</h1>');
  s.call('view.open', { paneId: 'pane_brief', view: 'tasks', title: 'Checklist', data: { items: [] } });
  const added = s.call('view.action', { paneId: 'pane_brief', action: 'add', args: { text: 'Run smoke test' } }).result;
  s.call('view.action', { paneId: 'pane_brief', action: 'toggle', args: { id: added.taskId } });
  assert.equal(s.state.panes.pane_brief.data.items[0].done, true);
  s.call('view.action', { paneId: 'pane_brief', action: 'toggle', args: { id: added.taskId, done: false } });
  assert.equal(s.state.panes.pane_brief.data.items[0].done, false);
  s.call('view.action', { paneId: 'pane_brief', action: 'remove', args: { id: added.taskId } });
  assert.deepEqual(s.state.panes.pane_brief.data.items, []); invariant(s.state);
});

test('all failed mutation validation is atomic', () => {
  const s = session(), before = JSON.stringify(s.state);
  const badCalls = [
    ['view.open', { paneId: 'pane_brief', view: 'terminal' }, 'INVALID_PARAMS'],
    ['pane.split', { paneId: 'pane_brief', ratio: 1.1 }, 'INVALID_PARAMS'],
    ['pane.split', { paneId: 'pane_brief', direction: 'diagonal' }, 'INVALID_PARAMS'],
    ['view.update', { paneId: 'pane_brief', data: { content: 'x'.repeat(LIMITS.content + 1) } }, 'INVALID_PARAMS'],
    ['workspace.create', { label: 'New', title: '' }, 'INVALID_PARAMS'],
    ['view.action', { paneId: 'pane_preview', action: 'set_html', args: {} }, 'INVALID_PARAMS'],
    ['agent.report', { id: 'builder', name: 'Builder', status: 'working', paneId: 'gone' }, 'NOT_FOUND'],
    ['view.update', { paneId: 'pane_brief', data: { content: 'Good' }, actor: '' }, 'INVALID_PARAMS'],
  ];
  for (const [method, params, code] of badCalls) { throwsCode(() => s.call(method, params), code); assert.equal(JSON.stringify(s.state), before); }
});

test('stale, unknown and wrong-context IDs produce explicit errors', () => {
  const s = session(), pane = s.call('pane.split').result;
  s.call('pane.close', { paneId: pane.paneId });
  throwsCode(() => s.call('pane.get', { paneId: pane.paneId }), 'NOT_FOUND');
  throwsCode(() => s.call('pane.resize', { splitId: pane.splitId, ratio: 0.5 }), 'NOT_FOUND');
  throwsCode(() => s.call('run.command', { command: 'rm -rf /' }), 'UNKNOWN_METHOD');
  throwsCode(() => s.call('workspace.focus', {}), 'INVALID_PARAMS');
  throwsCode(() => s.call('pane.get', { paneId: 'pane_brief', tabId: 'gone' }), 'NOT_FOUND');
  throwsCode(() => s.call('view.action', { paneId: 'pane_brief', action: 'execute', args: { command: 'anything' } }), 'INVALID_PARAMS');
});

test('closing tabs and workspaces removes contents and stale agent references', () => {
  const s = session(), ws = s.call('workspace.create', { label: 'Temporary' }).result;
  const tab = s.call('tab.create', { label: 'Review' }).result;
  s.call('agent.report', { id: 'reviewer', name: 'Reviewer', status: 'working', paneId: tab.paneId });
  s.call('tab.close', { tabId: tab.tabId });
  assert.equal(s.state.panes[tab.paneId], undefined); assert.equal(s.state.agents[0].paneId, undefined);
  s.call('workspace.close', { workspaceId: ws.workspaceId });
  assert.equal(s.state.panes[ws.paneId], undefined); assert.equal(s.state.activeWorkspaceId, 'ws_lab');
  invariant(s.state);
  throwsCode(() => s.call('workspace.close', { workspaceId: 'ws_lab' }), 'CONFLICT');
  throwsCode(() => s.call('tab.close', { tabId: 'tab_overview' }), 'CONFLICT');
  s.call('pane.close', { paneId: 'pane_preview' });
  throwsCode(() => s.call('pane.close', { paneId: 'pane_brief' }), 'CONFLICT');
});

test('no-op operations keep revision and events stable', () => {
  const s = session();
  for (const [method, params] of [
    ['workspace.focus', { workspaceId: 'ws_lab' }],
    ['tab.focus', { tabId: 'tab_overview' }],
    ['pane.focus', { paneId: 'pane_brief' }],
    ['view.update', { paneId: 'pane_brief', data: {} }],
    ['pane.resize', { splitId: 'split_overview', ratio: 0.48 }],
  ]) assert.equal(s.call(method, params).changed, false);
  assert.equal(s.state.revision, 0); assert.equal(s.state.events.length, 0);
});

test('agent reports are addressable, validated and independent of UI focus', () => {
  const s = session();
  s.call('agent.report', { id: 'builder', name: 'Builder', status: 'working', paneId: 'pane_preview', message: 'Building release' });
  assert.equal(s.state.workspaces[0].tabs[0].focusedPaneId, 'pane_brief');
  s.call('agent.report', { id: 'builder', status: 'done', message: 'Finished', paneId: null });
  assert.equal(s.state.agents.length, 1); assert.equal(s.state.agents[0].status, 'done'); assert.equal(s.state.agents[0].paneId, undefined);
  throwsCode(() => s.call('agent.report', { id: 'builder', status: 'thinking' }), 'INVALID_PARAMS');
});

test('events capture the API mutation and actor, and are bounded', () => {
  const s = session();
  for (let i = 0; i < LIMITS.events + 10; i++) s.call('workspace.rename', { label: `Iteration ${i}`, actor: 'agent/test' });
  assert.equal(s.state.events.length, LIMITS.events);
  assert.equal(s.state.events[0].revision, 11);
  assert.equal(s.state.events.at(-1).revision, LIMITS.events + 10);
  assert.equal(s.state.events.at(-1).method, 'workspace.rename');
  assert.equal(s.state.events.at(-1).actor, 'agent/test');
  assert.ok(!Number.isNaN(Date.parse(s.state.events.at(-1).time)));
});

test('pane, tab and workspace limits prevent resource growth atomically', () => {
  const s = session();
  for (let i = 2; i < LIMITS.panes; i++) s.call('pane.split', { paneId: 'pane_brief' });
  const before = JSON.stringify(s.state);
  throwsCode(() => s.call('pane.split'), 'LIMIT_EXCEEDED');
  throwsCode(() => s.call('tab.create', { label: 'Overflow' }), 'LIMIT_EXCEEDED');
  assert.equal(JSON.stringify(s.state), before); invariant(s.state);
  const tabs = session(); for (let i = 1; i < LIMITS.tabs; i++) tabs.call('tab.create', { label: `Tab ${i}` });
  throwsCode(() => tabs.call('tab.create', { label: 'Overflow' }), 'LIMIT_EXCEEDED');
  const workspaces = session(); for (let i = 1; i < LIMITS.workspaces; i++) workspaces.call('workspace.create', { label: `Workspace ${i}` });
  throwsCode(() => workspaces.call('workspace.create', { label: 'Overflow' }), 'LIMIT_EXCEEDED');
});

test('JSON validation rejects unsafe or nonportable payloads', () => {
  const s = session();
  for (const value of [NaN, Infinity, () => {}, new Date(), { nested: undefined }]) throwsCode(() => s.call('view.update', { data: { value } }), 'INVALID_PARAMS');
  throwsCode(() => s.call('view.update', { data: JSON.parse('{"__proto__":{"polluted":true}}') }), 'INVALID_PARAMS');
  assert.equal({}.polluted, undefined);
  s.call('view.open', { view: 'tasks', data: { items: [{ id: 'same', text: 'First' }] } });
  throwsCode(() => s.call('view.action', { action: 'add', args: { id: 'same', text: 'Duplicate' } }), 'INVALID_PARAMS');
});

test('schema describes every operation with machine-readable input types', () => {
  assert.equal(API_METHODS.length, 24);
  assert.equal(new Set(API_METHODS.map(m => m.name)).size, API_METHODS.length);
  for (const method of API_METHODS) { assert.equal(method.inputSchema.type, 'object'); assert.ok(method.description); }
  assert.deepEqual(API_METHODS.find(m => m.name === 'pane.move').inputSchema.required, ['paneId', 'targetPaneId']);
});

test('returned mutation results cannot mutate committed state', () => {
  const s = session(), created = s.call('workspace.create', { label: 'Original' });
  created.result.workspace.label = 'Sneaky';
  assert.equal(s.state.workspaces[1].label, 'Original');
  const original = createInitialState();
  execute(original, 'view.update', { paneId: 'pane_brief', data: { content: 'Updated' } });
  assert.ok(original.panes.pane_brief.data.content.startsWith('# Your workspace'));
  assert.equal(original.revision, 0);
});
