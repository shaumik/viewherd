import { API_METHODS, VIEW_SCHEMAS, LIMITS, execute } from './runtime.mjs';

const sdkBuiltins = Object.freeze(['document', 'tasks', 'preview', 'activity', 'api']);
const sdkUnsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const sdkSchemaKeys = new Set(['type', 'title', 'description', 'default', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'minProperties', 'maxProperties']);
const sdkSchemaTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const sdkFail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const sdkRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function sdkPlainObject(value, path) {
  if (!sdkRecord(value)) sdkFail('invalid_params', `${path} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || sdkUnsafeKeys.has(key)) sdkFail('invalid_params', `${path} has an unsafe key.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !('value' in descriptor)) sdkFail('invalid_params', `${path} must contain enumerable data properties only.`);
  }
}

function sdkJSON(value, path = 'value', ancestors = new Set(), depth = 0) {
  if (depth > 30) sdkFail('invalid_params', `${path} is nested too deeply.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') sdkFail('invalid_params', `${path} must contain only JSON values.`);
  if (ancestors.has(value)) sdkFail('invalid_params', `${path} cannot contain cycles.`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= value.length))) sdkFail('invalid_params', `${path} must be a plain JSON array.`);
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) sdkFail('invalid_params', `${path} cannot contain sparse entries, hidden entries or accessors.`);
      sdkJSON(descriptor.value, `${path}[${index}]`, ancestors, depth + 1);
    }
  } else {
    sdkPlainObject(value, path);
    for (const [key, item] of Object.entries(value)) sdkJSON(item, `${path}.${key}`, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

function sdkString(value, path, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) sdkFail('invalid_params', `${path} must be a nonempty string of at most ${max} characters.`);
  return value;
}

function sdkName(value, path) {
  sdkString(value, path, 80);
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value) || sdkUnsafeKeys.has(value)) sdkFail('invalid_definition', `${path} must be a safe lowercase identifier.`);
  return value;
}

function sdkSchema(schema, path, depth = 0) {
  if (depth > 30) sdkFail('invalid_definition', `${path} is nested too deeply.`);
  sdkPlainObject(schema, path);
  sdkJSON(schema, path);
  for (const keyword of Object.keys(schema)) if (!sdkSchemaKeys.has(keyword)) sdkFail('unsupported_schema', `${path}.${keyword} is not supported.`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || new Set(types).size !== types.length || types.some(type => !sdkSchemaTypes.has(type))) sdkFail('invalid_definition', `${path}.type is invalid.`);
  }
  for (const key of ['title', 'description']) if (schema[key] !== undefined && typeof schema[key] !== 'string') sdkFail('invalid_definition', `${path}.${key} must be a string.`);
  if (schema.properties !== undefined) {
    sdkPlainObject(schema.properties, `${path}.properties`);
    for (const [key, value] of Object.entries(schema.properties)) sdkSchema(value, `${path}.properties.${key}`, depth + 1);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || sdkUnsafeKeys.has(key)) || new Set(schema.required).size !== schema.required.length)) sdkFail('invalid_definition', `${path}.required must contain distinct safe property names.`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') sdkSchema(schema.additionalProperties, `${path}.additionalProperties`, depth + 1);
  if (schema.items !== undefined) sdkSchema(schema.items, `${path}.items`, depth + 1);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) sdkFail('invalid_definition', `${path}.enum must be a nonempty array.`);
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) sdkFail('invalid_definition', `${path}.${key} must be a finite number.`);
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) sdkFail('invalid_definition', `${path}.${key} must be a nonnegative integer.`);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string' || schema.pattern.length > 512) sdkFail('invalid_definition', `${path}.pattern must be a string of at most 512 characters.`);
    try { new RegExp(schema.pattern, 'u'); } catch { sdkFail('invalid_definition', `${path}.pattern is not a valid regular expression.`); }
  }
  for (const [minimum, maximum] of [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems'], ['minProperties', 'maxProperties']]) if (schema[minimum] !== undefined && schema[maximum] !== undefined && schema[minimum] > schema[maximum]) sdkFail('invalid_definition', `${path}.${minimum} exceeds ${maximum}.`);
}

function sdkEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sdkEqual(item, b[index]));
  if (sdkRecord(a) && sdkRecord(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && sdkEqual(a[key], b[key]));
  return false;
}

function sdkValidate(value, schema, path) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? sdkRecord(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
    if (!types.some(matches)) sdkFail('schema_validation', `${path} must match type ${types.join(' or ')}.`);
  }
  if (Object.hasOwn(schema, 'const') && !sdkEqual(value, schema.const)) sdkFail('schema_validation', `${path} does not match const.`);
  if (schema.enum && !schema.enum.some(option => sdkEqual(value, option))) sdkFail('schema_validation', `${path} is not an allowed value.`);
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) sdkFail('schema_validation', `${path} has an invalid string length.`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) sdkFail('schema_validation', `${path} does not match the required pattern.`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum || schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum || schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) sdkFail('schema_validation', `${path} is outside the permitted range.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) sdkFail('schema_validation', `${path} has an invalid number of items.`);
    if (schema.items) value.forEach((item, index) => sdkValidate(item, schema.items, `${path}[${index}]`));
  }
  if (sdkRecord(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties || schema.maxProperties !== undefined && keys.length > schema.maxProperties) sdkFail('schema_validation', `${path} has an invalid number of properties.`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) sdkFail('schema_validation', `${path}.${key} is required.`);
    for (const key of keys) {
      if (Object.hasOwn(schema.properties || {}, key)) sdkValidate(value[key], schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) sdkFail('schema_validation', `${path}.${key} is not allowed.`);
      else if (sdkRecord(schema.additionalProperties)) sdkValidate(value[key], schema.additionalProperties, `${path}.${key}`);
    }
  }
}

function sdkFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(sdkFreeze); Object.freeze(value); }
  return value;
}

/** Define a discoverable application panel. Handlers run against a private transaction draft. */
export function definePanel(definition) {
  sdkPlainObject(definition, 'panel definition');
  const type = sdkName(definition.type, 'panel.type');
  if (sdkBuiltins.includes(type)) sdkFail('invalid_definition', `${type} is a reserved built-in panel type.`);
  const title = sdkString(definition.title ?? type, 'panel.title', 80);
  const description = definition.description ?? '';
  if (typeof description !== 'string') sdkFail('invalid_definition', 'panel.description must be a string.');
  const dataSchema = definition.dataSchema ?? { type: 'object' };
  sdkSchema(dataSchema, `${type}.dataSchema`);
  const actionDefinitions = definition.actions ?? {};
  sdkPlainObject(actionDefinitions, `${type}.actions`);
  const actions = {};
  for (const [name, action] of Object.entries(actionDefinitions)) {
    sdkString(name, `${type}.action`, 80);
    if (!/^[a-zA-Z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/.test(name) || sdkUnsafeKeys.has(name)) sdkFail('invalid_definition', `${type}.${name} must be a safe action identifier.`);
    sdkPlainObject(action, `${type}.${name}`);
    if (typeof action.run !== 'function') sdkFail('invalid_definition', `${type}.${name}.run must be a function.`);
    if (action.description !== undefined && typeof action.description !== 'string') sdkFail('invalid_definition', `${type}.${name}.description must be a string.`);
    const inputSchema = action.inputSchema ?? { type: 'object', additionalProperties: false };
    sdkSchema(inputSchema, `${type}.${name}.inputSchema`);
    if (action.outputSchema !== undefined) sdkSchema(action.outputSchema, `${type}.${name}.outputSchema`);
    actions[name] = { description: action.description ?? '', inputSchema: structuredClone(inputSchema), ...(action.outputSchema === undefined ? {} : { outputSchema: structuredClone(action.outputSchema) }), run: action.run };
  }
  return sdkFreeze({ type, title, description, dataSchema: structuredClone(dataSchema), actions });
}

/** Immutable application registry. Wire discovery never includes handler functions. */
export function createRegistry(definitions = []) {
  if (!Array.isArray(definitions)) sdkFail('invalid_definition', 'definitions must be an array.');
  const panels = new Map();
  for (const raw of definitions) {
    const definition = definePanel(raw);
    if (panels.has(definition.type)) sdkFail('duplicate_panel', `Panel type ${definition.type} is registered twice.`);
    panels.set(definition.type, definition);
  }
  return Object.freeze({
    get: type => panels.get(type),
    has: type => panels.has(type),
    schema: () => [...panels.values()].map(panel => ({ type: panel.type, title: panel.title, description: panel.description, dataSchema: structuredClone(panel.dataSchema), actions: Object.entries(panel.actions).map(([name, action]) => ({ name, description: action.description, inputSchema: structuredClone(action.inputSchema), ...(action.outputSchema === undefined ? {} : { outputSchema: structuredClone(action.outputSchema) }) })) })),
    validateData(type, data) {
      const panel = panels.get(type);
      if (!panel) sdkFail('unknown_panel', `Panel type ${type} is not registered.`);
      sdkJSON(data, `${type}.data`);
      sdkValidate(data, panel.dataSchema, `${type}.data`);
    },
  });
}

/** Create a one-pane embeddable workspace with isolated serializable application state. */
export function createSession({ id, label = 'Workspace', view = 'document', title, data = {}, app = {}, registry } = {}) {
  sdkString(id, 'session.id', 120);
  sdkName(view, 'session.view');
  sdkString(label, 'session.label', 80);
  sdkPlainObject(data, 'session.data'); sdkJSON(data, 'session.data');
  sdkPlainObject(app, 'session.app'); sdkJSON(app, 'session.app');
  const paneTitle = sdkString(title ?? registry?.get?.(view)?.title ?? 'Inbox', 'session.title', 80);
  const state = { version: 1, sessionId: id, revision: 0, activeWorkspaceId: 'ws_main', workspaces: [{ id: 'ws_main', label, activeTabId: 'tab_main', tabs: [{ id: 'tab_main', label: 'Workspace', focusedPaneId: 'pane_inbox', zoomedPaneId: null, layout: { type: 'pane', paneId: 'pane_inbox' } }] }], panes: { pane_inbox: { id: 'pane_inbox', title: paneTitle, view, data: structuredClone(data) } }, app: structuredClone(app), agents: [], events: [] };
  if (sdkBuiltins.includes(view)) {
    const validated = execute(state, 'view.open', { paneId: 'pane_inbox', view, title: paneTitle, data }, { registry });
    state.panes.pane_inbox = validated.state.panes.pane_inbox;
  } else if (registry) registry.validateData(view, state.panes.pane_inbox.data);
  sdkSize(state);
  return state;
}

function sdkSize(state) {
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 900000) sdkFail('state_limit', 'Workspace storage limit exceeds 900 KB.');
}

function sdkState(state, registry) {
  sdkJSON(state, 'state');
  sdkString(state.sessionId, 'state.sessionId', 120);
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.workspaces) || !state.workspaces.length || state.workspaces.length > LIMITS.workspaces || !sdkRecord(state.panes) || !sdkRecord(state.app) || !Array.isArray(state.events) || state.events.length > LIMITS.events || !Array.isArray(state.agents) || state.agents.length > 32) sdkFail('invalid_state', 'The session graph is invalid.');
  const paneIds = new Set(), workspaceIds = new Set(), tabIds = new Set(), splitIds = new Set();
  const visit = (layout, depth = 0) => {
    if (!sdkRecord(layout) || depth > LIMITS.panes) sdkFail('invalid_state', 'The pane layout is invalid.');
    if (layout.type === 'pane') {
      const pane = state.panes[layout.paneId];
      if (!pane || pane.id !== layout.paneId || paneIds.has(pane.id)) sdkFail('invalid_state', 'Layout pane IDs must exist and be unique.');
      sdkString(pane.id, 'pane.id', 120); sdkString(pane.title, 'pane.title', 80); sdkPlainObject(pane.data, 'pane.data');
      if (!sdkBuiltins.includes(pane.view)) {
        if (!registry?.has?.(pane.view)) sdkFail('unknown_panel', `Panel type ${pane.view} is not registered.`);
        registry.validateData(pane.view, pane.data);
      } else {
        sdkValidate(pane.data, VIEW_SCHEMAS[pane.view].dataSchema, `pane.${pane.id}.data`);
        if (pane.view === 'document' && typeof pane.data.content !== 'string' || pane.view === 'preview' && typeof pane.data.html !== 'string' || pane.view === 'tasks' && (!Array.isArray(pane.data.items) || new Set(pane.data.items.map(item => item.id)).size !== pane.data.items.length)) sdkFail('invalid_state', 'Built-in pane data is invalid.');
      }
      paneIds.add(pane.id); return [pane.id];
    }
    if (layout.type !== 'split' || splitIds.has(layout.id) || !['right', 'down'].includes(layout.direction) || typeof layout.ratio !== 'number' || layout.ratio < 0.1 || layout.ratio > 0.9) sdkFail('invalid_state', 'The split layout is invalid.');
    sdkString(layout.id, 'split.id', 120); splitIds.add(layout.id);
    return [...visit(layout.first, depth + 1), ...visit(layout.second, depth + 1)];
  };
  for (const workspace of state.workspaces) {
    sdkString(workspace.id, 'workspace.id', 120); sdkString(workspace.label, 'workspace.label', 80);
    if (workspaceIds.has(workspace.id) || !Array.isArray(workspace.tabs) || !workspace.tabs.length || workspace.tabs.length > LIMITS.tabs) sdkFail('invalid_state', 'Workspace IDs must be unique and tabs valid.');
    workspaceIds.add(workspace.id);
    if (!workspace.tabs.some(tab => tab.id === workspace.activeTabId)) sdkFail('invalid_state', 'An active tab is missing.');
    for (const tab of workspace.tabs) {
      sdkString(tab.id, 'tab.id', 120); sdkString(tab.label, 'tab.label', 80);
      if (tabIds.has(tab.id)) sdkFail('invalid_state', 'Tab IDs must be unique.');
      tabIds.add(tab.id);
      const ids = visit(tab.layout);
      if (!ids.includes(tab.focusedPaneId) || tab.zoomedPaneId !== null && !ids.includes(tab.zoomedPaneId)) sdkFail('invalid_state', 'Focused or zoomed pane is missing.');
    }
  }
  if (!workspaceIds.has(state.activeWorkspaceId) || paneIds.size !== Object.keys(state.panes).length || paneIds.size > LIMITS.panes || state.agents.some(agent => agent.paneId !== undefined && !paneIds.has(agent.paneId))) sdkFail('invalid_state', 'The session contains detached or invalid panes.');
  sdkSize(state);
}

// Retain live ctx.app and ctx.pane references when the immutable layout engine returns a new draft.
function sdkReconcile(target, source) {
  if (Array.isArray(target) && Array.isArray(source)) {
    for (let index = 0; index < source.length; index++) target[index] = sdkRecord(target[index]) && sdkRecord(source[index]) || Array.isArray(target[index]) && Array.isArray(source[index]) ? sdkReconcile(target[index], source[index]) : structuredClone(source[index]);
    target.length = source.length; return target;
  }
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
  for (const [key, value] of Object.entries(source)) target[key] = sdkRecord(target[key]) && sdkRecord(value) || Array.isArray(target[key]) && Array.isArray(value) ? sdkReconcile(target[key], value) : structuredClone(value);
  return target;
}

function sdkWireSchema(registry) {
  const methods = structuredClone(API_METHODS);
  const panels = registry?.schema?.() ?? [];
  const views = [...sdkBuiltins, ...panels.map(panel => panel.type)];
  for (const method of methods) if (method.inputSchema.properties.view) method.inputSchema.properties.view.enum = views;
  methods.push({ name: 'panel.action', description: 'Run an application-defined transactional panel action.', inputSchema: { type: 'object', properties: { paneId: { type: 'string' }, action: { type: 'string' }, args: { type: 'object' } }, required: ['paneId', 'action'], additionalProperties: false } });
  return { version: 1, methods, views, viewSchemas: structuredClone(VIEW_SCHEMAS), panels, limits: { ...LIMITS, stateBytes: 900000 } };
}

function sdkMethodParams(method, params, registry) {
  const descriptor = sdkWireSchema(registry).methods.find(item => item.name === method);
  if (!descriptor) sdkFail('unknown_method', `Unknown method: ${method}.`);
  const clean = { ...params };
  // Legacy actor fields are tolerated for compatibility, but host identity always wins.
  delete clean.actor;
  sdkValidate(clean, descriptor.inputSchema, 'params');
}

/** Dispatch the shared API contract. A panel action and every ctx.call commit atomically. */
export async function executeCommand(state, command, { registry = createRegistry(), principal } = {}) {
  sdkPlainObject(command, 'command'); sdkJSON(command, 'command');
  if (command.version !== 1) sdkFail('unsupported_version', 'Command version must be 1.');
  sdkString(command.requestId, 'requestId', 128); sdkString(command.sessionId, 'sessionId', 120);
  if (command.sessionId !== state.sessionId) sdkFail('session_mismatch', 'The command targets a different session.');
  if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) sdkFail('invalid_params', 'expectedRevision must be a nonnegative integer.');
  if (command.expectedRevision !== undefined && command.expectedRevision !== state.revision) sdkFail('revision_conflict', 'Workspace changed. Refresh state and retry with a new request ID.');
  sdkString(command.method, 'method', 80);
  const params = command.params ?? {};
  sdkPlainObject(params, 'params'); sdkJSON(params, 'params');
  if (principal !== undefined) { sdkPlainObject(principal, 'principal'); sdkJSON(principal, 'principal'); }
  const actor = sdkString(principal?.actor ?? principal?.id ?? 'host', 'principal actor', 120);
  sdkState(state, registry);
  sdkMethodParams(command.method, params, registry);
  if (command.method === 'api.schema') return { state, result: sdkWireSchema(registry), changed: false };
  if (command.method !== 'panel.action') {
    const outcome = execute(state, command.method, { ...params, actor }, { registry });
    sdkState(outcome.state, registry);
    return outcome;
  }
  sdkString(params.paneId, 'params.paneId', 120); sdkString(params.action, 'params.action', 80);
  for (const key of Object.keys(params)) if (!['paneId', 'action', 'args', 'actor'].includes(key)) sdkFail('invalid_params', `params.${key} is not allowed.`);
  const pane = Object.hasOwn(state.panes, params.paneId) ? state.panes[params.paneId] : undefined;
  if (!pane) sdkFail('not_found', `Pane ${params.paneId} does not exist.`);
  const definition = registry.get(pane.view);
  if (!definition) sdkFail('unknown_panel', `Panel ${pane.view} has no registered application actions.`);
  const action = Object.hasOwn(definition.actions, params.action) ? definition.actions[params.action] : undefined;
  if (!action) sdkFail('unknown_action', `Action ${params.action} is not registered on ${pane.view}.`);
  const args = params.args ?? {};
  sdkPlainObject(args, 'args'); sdkJSON(args, 'args'); sdkValidate(args, action.inputSchema, 'args');
  const draft = structuredClone(state);
  const context = Object.freeze({
    get app() { return draft.app; },
    get pane() { return draft.panes[params.paneId]; },
    get state() { return draft; },
    principal: principal === undefined ? null : sdkFreeze(structuredClone(principal)),
    requestId: command.requestId,
    call(method, nestedParams = {}) {
      if (method === 'panel.action') sdkFail('nested_action', 'ctx.call supports layout/data operations; nested application actions are not supported.');
      sdkString(method, 'ctx.call method', 80); sdkPlainObject(nestedParams, 'ctx.call params'); sdkJSON(nestedParams, 'ctx.call params');
      sdkMethodParams(method, nestedParams, registry);
      if (method === 'api.schema') return sdkWireSchema(registry);
      sdkJSON(draft, 'transaction draft');
      const outcome = execute(draft, method, { ...nestedParams, actor }, { registry });
      if (outcome.changed) {
        outcome.state.revision = state.revision; outcome.state.events = structuredClone(state.events);
        sdkReconcile(draft, outcome.state);
      }
      return outcome.result;
    },
  });
  const result = await action.run(context, structuredClone(args));
  sdkJSON(result, 'action result');
  if (action.outputSchema) sdkValidate(result, action.outputSchema, 'action result');
  if (draft.sessionId !== state.sessionId || draft.revision !== state.revision || !sdkEqual(draft.events, state.events)) sdkFail('invalid_state', 'Actions cannot change session identity, revision, or audit history.');
  sdkState(draft, registry);
  const changed = !sdkEqual(draft, state);
  if (!changed) return { state, result: structuredClone(result), changed: false };
  draft.revision = state.revision + 1;
  draft.events.push({ id: `event_${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`, revision: draft.revision, time: new Date().toISOString(), method: 'panel.action', actor, summary: `${params.action} in ${pane.title}`, requestId: command.requestId, paneId: params.paneId, action: params.action });
  draft.events = draft.events.slice(-LIMITS.events);
  sdkState(draft, registry);
  return { state: structuredClone(draft), result: structuredClone(result), changed: true };
}
