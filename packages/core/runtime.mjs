/** Viewherd's authoritative, transport-independent workspace runtime. */
export const LIMITS = Object.freeze({ workspaces: 16, tabs: 16, panes: 32, content: 100000, events: 150 });
const VIEWS = ['document', 'tasks', 'preview', 'activity', 'api'];
const STATUSES = ['idle', 'working', 'blocked', 'done'];
const textSchema = (maxLength, empty = false) => ({ type: 'string', maxLength, ...(empty ? {} : { minLength: 1, pattern: '\\S' }) });
const actionSchema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
/** Discoverable view contracts. Pass an action's argsSchema fields as view.action.params.args. */
export const VIEW_SCHEMAS = Object.freeze({
  document: {
    description: 'A shared text/Markdown document. view.update shallow-merges data; omitted content is preserved. view.open replaces data and defaults content to an empty string.',
    dataSchema: { type: 'object', properties: { content: { ...textSchema(LIMITS.content, true), default: '' } }, additionalProperties: true },
    actions: [
      { name: 'set', description: 'Replace the entire document content.', argsSchema: actionSchema({ content: textSchema(LIMITS.content, true) }, ['content']) },
      { name: 'append', description: `Append exact text without inserting a newline. Combined content must remain at most ${LIMITS.content} characters.`, argsSchema: actionSchema({ content: textSchema(LIMITS.content, true) }, ['content']) },
    ],
  },
  tasks: {
    description: 'An ordered shared checklist. view.update with items replaces the entire list; use actions for individual changes. Task IDs must be unique within a pane.',
    dataSchema: { type: 'object', properties: { items: { type: 'array', maxItems: 1000, default: [], items: { type: 'object', properties: { id: textSchema(120), text: textSchema(2000), done: { type: 'boolean', default: false } }, required: ['id', 'text'], additionalProperties: false } } }, additionalProperties: true },
    actions: [
      { name: 'add', description: 'Append one task. Omit id to generate one; the result contains taskId. done defaults to false.', argsSchema: actionSchema({ id: textSchema(120), text: textSchema(2000), done: { type: 'boolean', default: false } }, ['text']) },
      { name: 'toggle', description: 'Change an existing task. Omit done to invert it; provide done for an explicit value.', argsSchema: actionSchema({ id: textSchema(120), done: { type: 'boolean' } }, ['id']) },
      { name: 'remove', description: 'Remove the task with this exact ID.', argsSchema: actionSchema({ id: textSchema(120) }, ['id']) },
    ],
  },
  preview: {
    description: 'HTML displayed in a sandboxed preview. Scripts may run inside the frame, but the frame has no same-origin access to Viewherd or its API.',
    dataSchema: { type: 'object', properties: { html: { ...textSchema(LIMITS.content, true), default: '' } }, additionalProperties: true },
    actions: [{ name: 'set_html', description: 'Replace the complete preview HTML.', argsSchema: actionSchema({ html: textSchema(LIMITS.content, true) }, ['html']) }],
  },
  activity: { description: 'A read-only view of the shared agent/event state. No view.action operations.', dataSchema: { type: 'object', properties: {}, additionalProperties: true }, actions: [] },
  api: { description: 'A live panel controller for the same Viewherd API. It can create and operate other panes using their IDs. No view.action operations on the controller itself; use its selected targetPaneId for target actions.', dataSchema: { type: 'object', properties: { targetPaneId: { type: ['string', 'null'], description: 'Selected target pane ID. Change with view.update; the UI validates that it exists and is not the controller itself.' } }, additionalProperties: true }, actions: [] },
});
let sequence = 0;
const id = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${(++sequence).toString(36)}_${Math.random().toString(36).slice(2, 9)}`}`;
const clone = value => structuredClone(value);
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function string(value, name, { max = 80, empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) fail('INVALID_PARAMS', `${name} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters.`);
  return value;
}
function json(value, name = 'data', depth = 0) {
  if (depth > 30) fail('INVALID_PARAMS', `${name} is nested too deeply.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(v => json(v, name, depth + 1)); return; }
  if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('INVALID_PARAMS', `Invalid ${name} key.`);
      json(item, name, depth + 1);
    }
    return;
  }
  fail('INVALID_PARAMS', `${name} must contain only JSON values.`);
}
function ratio(value = 0.5) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.1 || value > 0.9) fail('INVALID_PARAMS', 'ratio must be between 0.1 and 0.9.');
  return value;
}
function direction(value = 'right') {
  if (!['right', 'down'].includes(value)) fail('INVALID_PARAMS', 'direction must be right or down.');
  return value;
}
function dataFor(view, data = {}, registry) {
  const custom = !VIEWS.includes(view);
  if (custom && (!registry?.has?.(view) || typeof registry.validateData !== 'function')) fail('INVALID_PARAMS', `view must be built in or registered: ${VIEWS.join(', ')}.`);
  if (!record(data)) fail('INVALID_PARAMS', 'data must be an object.');
  json(data);
  if (JSON.stringify(data).length > LIMITS.content + 10000) fail('LIMIT_EXCEEDED', 'View data is too large.');
  const next = clone(data);
  if (custom) { registry.validateData(view, next); return next; }
  if (view === 'document') next.content = string(data.content ?? '', 'content', { max: LIMITS.content, empty: true });
  if (view === 'preview') next.html = string(data.html ?? '', 'html', { max: LIMITS.content, empty: true });
  if (view === 'tasks') {
    if (data.items !== undefined && !Array.isArray(data.items)) fail('INVALID_PARAMS', 'items must be an array.');
    next.items = (data.items || []).map(item => {
      if (!record(item)) fail('INVALID_PARAMS', 'Each task must be an object.');
      return { id: string(item.id, 'task.id', { max: 120 }), text: string(item.text, 'task.text', { max: 2000 }), done: boolean(item.done ?? false, 'task.done') };
    });
    if (next.items.length > 1000) fail('LIMIT_EXCEEDED', 'A task list can contain at most 1000 tasks.');
    if (new Set(next.items.map(item => item.id)).size !== next.items.length) fail('INVALID_PARAMS', 'Task IDs must be unique.');
  }
  return next;
}
function boolean(value, name) { if (typeof value !== 'boolean') fail('INVALID_PARAMS', `${name} must be a boolean.`); return value; }
function createPane(params = {}, registry) {
  const view = params.view ?? 'document';
  return { id: id('pane'), title: string(params.title ?? ({ document: 'Untitled document', tasks: 'Tasks', preview: 'Live preview', activity: 'Activity', api: 'API explorer' }[view] || registry?.get?.(view)?.title || 'View'), 'title'), view, data: dataFor(view, params.data, registry) };
}
const leaf = paneId => ({ type: 'pane', paneId });
function paneIds(layout) { return layout.type === 'pane' ? [layout.paneId] : [...paneIds(layout.first), ...paneIds(layout.second)]; }
function replaceLeaf(layout, paneId, replacement) {
  if (layout.type === 'pane') return layout.paneId === paneId ? replacement : layout;
  return { ...layout, first: replaceLeaf(layout.first, paneId, replacement), second: replaceLeaf(layout.second, paneId, replacement) };
}
function removeLeaf(layout, paneId) {
  if (layout.type === 'pane') return layout.paneId === paneId ? null : layout;
  const first = removeLeaf(layout.first, paneId), second = removeLeaf(layout.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}
function findSplit(layout, splitId) {
  if (layout.type === 'pane') return null;
  return layout.id === splitId ? layout : findSplit(layout.first, splitId) || findSplit(layout.second, splitId);
}
function workspace(state, workspaceId = state.activeWorkspaceId) {
  const found = state.workspaces.find(ws => ws.id === workspaceId);
  if (!found) fail('NOT_FOUND', `Workspace ${workspaceId} does not exist.`);
  return found;
}
function tabLocation(state, params = {}) {
  if (params.tabId !== undefined) {
    for (const ws of state.workspaces) {
      const tab = ws.tabs.find(t => t.id === params.tabId);
      if (tab && (params.workspaceId === undefined || params.workspaceId === ws.id)) return { ws, tab };
    }
    fail('NOT_FOUND', `Tab ${params.tabId} does not exist in the requested workspace.`);
  }
  const ws = workspace(state, params.workspaceId), tab = ws.tabs.find(t => t.id === ws.activeTabId);
  return { ws, tab };
}
function paneLocation(state, params = {}) {
  const paneId = params.paneId ?? tabLocation(state, params).tab.focusedPaneId;
  if (typeof paneId !== 'string' || !Object.hasOwn(state.panes, paneId)) fail('NOT_FOUND', `Pane ${paneId} does not exist.`);
  for (const ws of state.workspaces) for (const tab of ws.tabs) {
    if (paneIds(tab.layout).includes(paneId)) {
      if ((params.workspaceId !== undefined && params.workspaceId !== ws.id) || (params.tabId !== undefined && params.tabId !== tab.id)) fail('NOT_FOUND', 'Pane does not belong to the requested tab or workspace.');
      return { ws, tab, pane: state.panes[paneId] };
    }
  }
  fail('NOT_FOUND', `Pane ${paneId} is detached.`);
}
function activate(state, ws, tab, paneId) { state.activeWorkspaceId = ws.id; ws.activeTabId = tab.id; if (paneId) tab.focusedPaneId = paneId; }
function dropPanes(state, ids) {
  for (const paneId of ids) delete state.panes[paneId];
  for (const agent of state.agents) if (ids.includes(agent.paneId)) delete agent.paneId;
}
function createTab(state, params, registry) {
  if (Object.keys(state.panes).length >= LIMITS.panes) fail('LIMIT_EXCEEDED', `A session supports at most ${LIMITS.panes} panes.`);
  const pane = createPane(params, registry);
  state.panes[pane.id] = pane;
  const tab = { id: id('tab'), label: string(params.label ?? 'Untitled', 'label'), focusedPaneId: pane.id, zoomedPaneId: null, layout: leaf(pane.id) };
  return { tab, pane };
}

export function createInitialState() {
  return {
    version: 1, revision: 0, activeWorkspaceId: 'ws_lab',
    workspaces: [{ id: 'ws_lab', label: 'Viewherd lab', activeTabId: 'tab_overview', tabs: [{
      id: 'tab_overview', label: 'Overview', focusedPaneId: 'pane_brief', zoomedPaneId: null,
      layout: { type: 'split', id: 'split_overview', direction: 'right', ratio: 0.48, first: leaf('pane_brief'), second: leaf('pane_preview') },
    }] }],
    panes: {
      pane_brief: { id: 'pane_brief', title: 'Start here', view: 'document', data: { content: '# Your workspace. Agent addressable.\n\nViewherd is a web app where you and your agents share the same interface. Every workspace, tab, pane, and view has a stable ID.\n\n## Try a real operation\n\nSplit this pane, open a task list, or run the guided demo. The UI and API mutate the same authoritative state.\n\n## Built for collaboration\n\n- Create and arrange tabs and split views\n- Edit documents and task lists\n- Preview HTML in an isolated frame\n- Inspect state and follow agent activity\n\nOpen the API explorer to use these operations from your own agent.' } },
      pane_preview: { id: 'pane_preview', title: 'Live preview', view: 'preview', data: { html: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#10151d;color:#f0f5ff;font:16px system-ui;padding:36px}small{color:#5eead4;letter-spacing:.16em}h1{font-size:44px;letter-spacing:-.05em;margin:24px 0 12px}p{color:#99a8bf;line-height:1.6}button{background:#5eead4;color:#10151d;padding:12px 20px;border:0;border-radius:10px;font-weight:700}</style></head><body><small>VIEWHERD / SHARED WORKSPACE</small><h1>Make room for your agents.</h1><p>This is a real HTML preview. Ask an agent to update it through the same API that powers the interface.</p><button>Ready to build</button></body></html>' } },
    }, agents: [], events: [],
  };
}

const requiredParams = {
  'workspace.focus': ['workspaceId'], 'workspace.rename': ['label'], 'workspace.close': ['workspaceId'],
  'tab.focus': ['tabId'], 'tab.rename': ['label'], 'tab.close': ['tabId'],
  'pane.resize': ['splitId', 'ratio'], 'pane.focus': ['paneId'], 'pane.move': ['paneId', 'targetPaneId'], 'pane.close': ['paneId'],
  'view.open': ['view'], 'view.update': ['data'], 'view.action': ['action'], 'agent.report': ['id', 'status'],
};
function schemaProperty(key, format) {
  const base = { description: format };
  if (key === 'view') return { ...base, type: 'string', enum: VIEWS };
  if (key === 'status') return { ...base, type: 'string', enum: STATUSES };
  if (key === 'direction') return { ...base, type: 'string', enum: ['right', 'down'] };
  if (key === 'ratio') return { ...base, type: 'number', minimum: 0.1, maximum: 0.9 };
  if (key === 'enabled') return { ...base, type: 'boolean' };
  if (key === 'action') return { ...base, type: 'string', enum: ['append', 'set', 'add', 'toggle', 'remove', 'set_html'], description: 'Action supported by the pane\'s current view. See viewSchemas[view].actions for the exact args schema.' };
  if (['data', 'args'].includes(key)) return { ...base, type: 'object' };
  return { ...base, type: 'string' };
}
function contextProperties(name, params) {
  const properties = Object.fromEntries(Object.entries(params).map(([key, format]) => [key, schemaProperty(key, format)]));
  if (/^(tab|pane|view)\./.test(name)) properties.workspaceId ??= { type: 'string', description: 'Workspace context; defaults to the active workspace.' };
  if (/^(pane|view)\./.test(name)) properties.tabId ??= { type: 'string', description: 'Optional tab context for validating pane ownership.' };
  if (name === 'pane.move') properties.ratio = schemaProperty('ratio', 'number?');
  if (name === 'agent.report') properties.paneId = { type: ['string', 'null'], description: 'Existing pane ID, or null to release pane ownership.' };
  properties.actor = { type: 'string', description: 'Identity written to the event log; defaults to human/ui.' };
  return properties;
}
export const API_METHODS = Object.freeze([
  ['session.snapshot', 'Read the full current workspace state.', {}],
  ['api.schema', 'Discover every supported operation.', {}],
  ['workspace.list', 'List workspaces.', {}],
  ['workspace.create', 'Create a workspace, tab, and initial pane.', { label: 'string', view: 'view?', title: 'string?', data: 'object?' }],
  ['workspace.focus', 'Activate a workspace.', { workspaceId: 'string' }],
  ['workspace.rename', 'Rename a workspace.', { workspaceId: 'string?', label: 'string' }],
  ['workspace.close', 'Close a workspace and its contents.', { workspaceId: 'string' }],
  ['tab.list', 'List tabs in a workspace.', { workspaceId: 'string?' }],
  ['tab.create', 'Create and activate a tab.', { workspaceId: 'string?', label: 'string', view: 'view?', title: 'string?', data: 'object?' }],
  ['tab.focus', 'Activate a tab.', { tabId: 'string' }],
  ['tab.rename', 'Rename a tab.', { tabId: 'string?', label: 'string' }],
  ['tab.close', 'Close a tab and its panes.', { tabId: 'string' }],
  ['pane.list', 'List panes in a tab.', { tabId: 'string?' }],
  ['pane.get', 'Read a pane and its location.', { paneId: 'string?' }],
  ['pane.split', 'Split a pane and open a new view.', { paneId: 'string?', direction: 'right|down?', ratio: 'number?', view: 'view?', title: 'string?', data: 'object?' }],
  ['pane.resize', 'Set a split proportion from 0.1 to 0.9.', { splitId: 'string', ratio: 'number' }],
  ['pane.focus', 'Focus a pane and its tab.', { paneId: 'string' }],
  ['pane.move', 'Move a pane beside another in the same workspace.', { paneId: 'string', targetPaneId: 'string', direction: 'right|down?' }],
  ['pane.zoom', 'Toggle a pane to fill its tab.', { paneId: 'string?', enabled: 'boolean?' }],
  ['pane.close', 'Close a pane, preserving at least one per tab.', { paneId: 'string' }],
  ['view.open', 'Replace the view in an existing pane.', { paneId: 'string?', view: 'view', title: 'string?', data: 'object?' }],
  ['view.update', 'Merge data into the current view.', { paneId: 'string?', title: 'string?', data: 'object' }],
  ['view.action', 'Perform a structured document, task, or preview action.', { paneId: 'string?', action: 'append|set|add|toggle|remove|set_html', args: 'object?' }],
  ['agent.report', 'Publish agent status and optional pane ownership.', { id: 'string', name: 'string?', status: 'idle|working|blocked|done', paneId: 'string?', message: 'string?' }],
].map(([name, description, params]) => Object.freeze({ name, description, params, inputSchema: {
  type: 'object', properties: contextProperties(name, params), required: requiredParams[name] || [], additionalProperties: false,
} })));

export function getSnapshot(state) { return clone(state); }

export function execute(state, method, params = {}, { registry } = {}) {
  if (!API_METHODS.some(item => item.name === method)) fail('UNKNOWN_METHOD', `Unknown method: ${method}.`);
  if (!record(params)) fail('INVALID_PARAMS', 'params must be an object.');
  json(params, 'params');
  for (const key of requiredParams[method] || []) if (params[key] === undefined) fail('INVALID_PARAMS', `${key} is required for ${method}.`);
  const next = clone(state);
  let result, summary = method;
  switch (method) {
    case 'session.snapshot': return { state, result: getSnapshot(state), changed: false };
    case 'api.schema': return { state, result: { methods: clone(API_METHODS), views: [...VIEWS], viewSchemas: clone(VIEW_SCHEMAS), limits: { ...LIMITS } }, changed: false };
    case 'workspace.list': result = { workspaces: clone(next.workspaces) }; break;
    case 'workspace.create': {
      if (next.workspaces.length >= LIMITS.workspaces) fail('LIMIT_EXCEEDED', `A session supports at most ${LIMITS.workspaces} workspaces.`);
      const { tab, pane } = createTab(next, { ...params, label: 'Overview' }, registry);
      const ws = { id: id('ws'), label: string(params.label ?? 'Untitled workspace', 'label'), activeTabId: tab.id, tabs: [tab] };
      next.workspaces.push(ws); next.activeWorkspaceId = ws.id;
      result = { workspaceId: ws.id, tabId: tab.id, paneId: pane.id, workspace: ws }; summary = `Created workspace ${ws.label}`; break;
    }
    case 'workspace.focus': { const ws = workspace(next, params.workspaceId); next.activeWorkspaceId = ws.id; result = { workspaceId: ws.id }; summary = `Focused workspace ${ws.label}`; break; }
    case 'workspace.rename': { const ws = workspace(next, params.workspaceId); ws.label = string(params.label, 'label'); result = { workspaceId: ws.id, workspace: ws }; summary = `Renamed workspace to ${ws.label}`; break; }
    case 'workspace.close': {
      const ws = workspace(next, params.workspaceId);
      if (next.workspaces.length === 1) fail('CONFLICT', 'The final workspace cannot be closed.');
      dropPanes(next, ws.tabs.flatMap(t => paneIds(t.layout))); next.workspaces = next.workspaces.filter(w => w.id !== ws.id);
      if (next.activeWorkspaceId === ws.id) next.activeWorkspaceId = next.workspaces[0].id;
      result = { workspaceId: ws.id }; summary = `Closed workspace ${ws.label}`; break;
    }
    case 'tab.list': { const ws = workspace(next, params.workspaceId); result = { workspaceId: ws.id, tabs: ws.tabs }; break; }
    case 'tab.create': {
      const ws = workspace(next, params.workspaceId);
      if (ws.tabs.length >= LIMITS.tabs) fail('LIMIT_EXCEEDED', `A workspace supports at most ${LIMITS.tabs} tabs.`);
      const { tab, pane } = createTab(next, params, registry); ws.tabs.push(tab); activate(next, ws, tab, pane.id);
      result = { workspaceId: ws.id, tabId: tab.id, paneId: pane.id, tab }; summary = `Created tab ${tab.label}`; break;
    }
    case 'tab.focus': { const { ws, tab } = tabLocation(next, params); activate(next, ws, tab); result = { workspaceId: ws.id, tabId: tab.id }; summary = `Focused tab ${tab.label}`; break; }
    case 'tab.rename': { const { ws, tab } = tabLocation(next, params); tab.label = string(params.label, 'label'); result = { workspaceId: ws.id, tabId: tab.id, tab }; summary = `Renamed tab to ${tab.label}`; break; }
    case 'tab.close': {
      const { ws, tab } = tabLocation(next, params);
      if (ws.tabs.length === 1) fail('CONFLICT', 'The final tab in a workspace cannot be closed.');
      dropPanes(next, paneIds(tab.layout)); ws.tabs = ws.tabs.filter(t => t.id !== tab.id);
      if (ws.activeTabId === tab.id) ws.activeTabId = ws.tabs[0].id;
      result = { workspaceId: ws.id, tabId: tab.id }; summary = `Closed tab ${tab.label}`; break;
    }
    case 'pane.list': { const { ws, tab } = tabLocation(next, params); result = { workspaceId: ws.id, tabId: tab.id, panes: paneIds(tab.layout).map(paneId => next.panes[paneId]) }; break; }
    case 'pane.get': { const { ws, tab, pane } = paneLocation(next, params); result = { workspaceId: ws.id, tabId: tab.id, pane }; break; }
    case 'pane.split': {
      const { ws, tab, pane: target } = paneLocation(next, params);
      if (Object.keys(next.panes).length >= LIMITS.panes) fail('LIMIT_EXCEEDED', `A session supports at most ${LIMITS.panes} panes.`);
      const pane = createPane(params, registry), split = { type: 'split', id: id('split'), direction: direction(params.direction), ratio: ratio(params.ratio), first: leaf(target.id), second: leaf(pane.id) };
      next.panes[pane.id] = pane; tab.layout = replaceLeaf(tab.layout, target.id, split); tab.zoomedPaneId = null; activate(next, ws, tab, pane.id);
      result = { workspaceId: ws.id, tabId: tab.id, paneId: pane.id, splitId: split.id, pane }; summary = `Split ${target.title} ${split.direction}; opened ${pane.title}`; break;
    }
    case 'pane.resize': {
      string(params.splitId, 'splitId', { max: 120 });
      let split, ws, tab;
      for (const w of next.workspaces) for (const t of w.tabs) { const found = findSplit(t.layout, params.splitId); if (found) { split = found; ws = w; tab = t; } }
      if (!split) fail('NOT_FOUND', `Split ${params.splitId} does not exist.`);
      if ((params.workspaceId !== undefined && ws.id !== params.workspaceId) || (params.tabId !== undefined && tab.id !== params.tabId)) fail('NOT_FOUND', 'Split does not belong to the requested tab or workspace.');
      split.ratio = ratio(params.ratio); result = { workspaceId: ws.id, tabId: tab.id, splitId: split.id, ratio: split.ratio }; summary = `Resized split to ${Math.round(split.ratio * 100)}%`; break;
    }
    case 'pane.focus': { const { ws, tab, pane } = paneLocation(next, params); activate(next, ws, tab, pane.id); result = { workspaceId: ws.id, tabId: tab.id, paneId: pane.id }; summary = `Focused ${pane.title}`; break; }
    case 'pane.move': {
      const source = paneLocation(next, params), target = paneLocation(next, { paneId: params.targetPaneId });
      if (source.pane.id === target.pane.id) fail('CONFLICT', 'A pane cannot be moved beside itself.');
      if (source.ws.id !== target.ws.id) fail('CONFLICT', 'Panes can only move between tabs in the same workspace.');
      if (source.tab !== target.tab && paneIds(source.tab.layout).length === 1) fail('CONFLICT', 'Moving the final pane would leave an empty tab.');
      source.tab.layout = removeLeaf(source.tab.layout, source.pane.id);
      if (source.tab.focusedPaneId === source.pane.id) source.tab.focusedPaneId = paneIds(source.tab.layout)[0];
      if (source.tab.zoomedPaneId === source.pane.id) source.tab.zoomedPaneId = null;
      const split = { type: 'split', id: id('split'), direction: direction(params.direction), ratio: ratio(params.ratio), first: leaf(target.pane.id), second: leaf(source.pane.id) };
      target.tab.layout = replaceLeaf(target.tab.layout, target.pane.id, split); target.tab.zoomedPaneId = null; activate(next, target.ws, target.tab, source.pane.id);
      result = { workspaceId: source.ws.id, tabId: target.tab.id, paneId: source.pane.id, splitId: split.id }; summary = `Moved ${source.pane.title} beside ${target.pane.title}`; break;
    }
    case 'pane.zoom': { const { ws, tab, pane } = paneLocation(next, params); const enabled = params.enabled === undefined ? tab.zoomedPaneId !== pane.id : boolean(params.enabled, 'enabled'); tab.zoomedPaneId = enabled ? pane.id : null; activate(next, ws, tab, pane.id); result = { paneId: pane.id, enabled }; summary = `${enabled ? 'Zoomed' : 'Restored'} ${pane.title}`; break; }
    case 'pane.close': {
      const { ws, tab, pane } = paneLocation(next, params);
      if (paneIds(tab.layout).length === 1) fail('CONFLICT', 'The final pane in a tab cannot be closed.');
      tab.layout = removeLeaf(tab.layout, pane.id); if (tab.focusedPaneId === pane.id) tab.focusedPaneId = paneIds(tab.layout)[0]; if (tab.zoomedPaneId === pane.id) tab.zoomedPaneId = null;
      dropPanes(next, [pane.id]); result = { workspaceId: ws.id, tabId: tab.id, paneId: pane.id }; summary = `Closed ${pane.title}`; break;
    }
    case 'view.open': { const { pane } = paneLocation(next, params); pane.view = params.view; pane.data = dataFor(pane.view, params.data, registry); if (params.title !== undefined) pane.title = string(params.title, 'title'); result = { paneId: pane.id, pane }; summary = `Opened ${pane.view} in ${pane.title}`; break; }
    case 'view.update': { const { pane } = paneLocation(next, params); if (!record(params.data)) fail('INVALID_PARAMS', 'data must be an object.'); pane.data = dataFor(pane.view, { ...pane.data, ...params.data }, registry); if (params.title !== undefined) pane.title = string(params.title, 'title'); result = { paneId: pane.id, pane }; summary = `Updated ${pane.title}`; break; }
    case 'view.action': {
      const { pane } = paneLocation(next, params), args = params.args ?? {};
      if (!record(args)) fail('INVALID_PARAMS', 'args must be an object.');
      result = { paneId: pane.id };
      if (pane.view === 'document' && ['append', 'set'].includes(params.action)) {
        const content = string(args.content, 'args.content', { max: LIMITS.content, empty: true });
        pane.data = dataFor(pane.view, { ...pane.data, content: params.action === 'append' ? pane.data.content + content : content });
      } else if (pane.view === 'preview' && params.action === 'set_html') pane.data = dataFor(pane.view, { ...pane.data, html: string(args.html, 'args.html', { max: LIMITS.content, empty: true }) });
      else if (pane.view === 'tasks' && ['add', 'toggle', 'remove'].includes(params.action)) {
        if (params.action === 'add') {
          const task = { id: args.id === undefined ? id('task') : string(args.id, 'args.id', { max: 120 }), text: string(args.text, 'args.text', { max: 2000 }), done: boolean(args.done ?? false, 'args.done') };
          pane.data = dataFor(pane.view, { ...pane.data, items: [...pane.data.items, task] }); result.taskId = task.id;
        } else {
          const task = pane.data.items.find(t => t.id === args.id);
          if (!task) fail('NOT_FOUND', `Task ${args.id} does not exist.`);
          if (params.action === 'toggle') task.done = args.done === undefined ? !task.done : boolean(args.done, 'args.done');
          else pane.data.items = pane.data.items.filter(t => t.id !== args.id);
          result.taskId = task.id;
        }
      } else fail('INVALID_PARAMS', `Action ${params.action} is not supported by a ${pane.view} view.`);
      result.pane = pane; summary = `${params.action} in ${pane.title}`; break;
    }
    case 'agent.report': {
      const agentId = string(params.id, 'id', { max: 120 });
      if (!STATUSES.includes(params.status)) fail('INVALID_PARAMS', `status must be one of: ${STATUSES.join(', ')}.`);
      let agent = next.agents.find(a => a.id === agentId);
      if (!agent) { if (next.agents.length >= 32) fail('LIMIT_EXCEEDED', 'A session supports at most 32 agents.'); agent = { id: agentId, name: params.name ?? agentId, status: params.status }; next.agents.push(agent); }
      if (params.name !== undefined) agent.name = string(params.name, 'name');
      agent.status = params.status;
      if (params.paneId === null) delete agent.paneId;
      else if (params.paneId !== undefined) agent.paneId = paneLocation(next, { paneId: params.paneId }).pane.id;
      if (params.message !== undefined) agent.message = string(params.message, 'message', { max: 2000, empty: true });
      result = { agentId: agent.id, agent }; summary = `${agent.name}: ${agent.message || agent.status}`; break;
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  if (!changed) return { state, result: clone(result), changed: false };
  const actor = string(params.actor ?? 'human/ui', 'actor', { max: 120 });
  next.revision = state.revision + 1;
  next.events.push({ id: id('event'), revision: next.revision, time: new Date().toISOString(), method, actor, summary });
  next.events = next.events.slice(-LIMITS.events);
  return { state: next, result: clone(result), changed: true };
}
