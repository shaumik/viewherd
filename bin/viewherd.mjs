#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const HELP = `viewherd — operate the legacy Viewherd workspace lab

Usage:
  viewherd snapshot
  viewherd schema
  viewherd <method> [JSON params]
  viewherd <method> --stdin
  viewherd watch [--after REVISION]
  viewherd demo
  viewherd --mcp-stdio

Options:
  --url BASE       Server URL (VIEWHERD_URL or http://localhost:4317)
  --token TOKEN    Optional server bearer token (prefer VIEWHERD_TOKEN)
  --actor NAME     Event actor (default agent:cli)
  --id ID          Stable request ID for a safe retry
  --revision REV   Require this revision before a mutation
  --full           Include the full RPC response, including state
  --after REV      Start watch after this revision (default current revision)
  --interval MS    Poll interval for watch (default 500)
  --stdin          Read JSON params from standard input
  --mcp-stdio      Serve MCP tools over standard input/output
  --help          Show this help

Examples:
  viewherd workspace.create '{"label":"Release review"}'
  viewherd pane.split '{"paneId":"pane_…","direction":"right","view":"document"}'

Set VIEWHERD_SITES_TOKEN only when a private hosted deployment requires its
platform service credential. It is sent privately in OAI-Sites-Authorization.
This CLI operates the legacy workspace lab at /lab through /api/* routes.
Application integrations use the SDK and /viewherd API; see docs/SDK.md.
The CLI does not bundle an AI model. Every command calls the real HTTP API.
`;

function parse(args) {
  const config = {
    url: process.env.VIEWHERD_URL || process.env.WEBDR_URL || 'http://localhost:4317',
    token: process.env.VIEWHERD_TOKEN || process.env.WEBDR_TOKEN || '',
    sitesToken: process.env.VIEWHERD_SITES_TOKEN || process.env.WEBDR_SITES_TOKEN || '',
    actor: 'agent:cli', full: false, stdin: false, mcp: false,
    interval: 500, after: undefined, id: undefined, revision: undefined,
  };
  const positional = [];
  const values = { '--url': 'url', '--token': 'token', '--actor': 'actor', '--id': 'id', '--revision': 'revision', '--after': 'after', '--interval': 'interval' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (name in values) {
      const value = equals === -1 ? args[++index] : arg.slice(equals + 1);
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
      config[values[name]] = value;
    } else if (arg === '--full') config.full = true;
    else if (arg === '--stdin') config.stdin = true;
    else if (arg === '--mcp-stdio') config.mcp = true;
    else if (arg === '--help' || arg === '-h') config.help = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${name}`);
    else positional.push(arg);
  }
  const url = new URL(config.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--url must use http or https');
  if (url.username || url.password || url.search || url.hash) throw new Error('--url must not contain credentials, a query, or a fragment');
  config.url = config.url.replace(/\/+$/, '');
  config.interval = Number(config.interval);
  if (!Number.isFinite(config.interval) || config.interval < 100) throw new Error('--interval must be at least 100 milliseconds');
  if (config.after !== undefined) {
    config.after = Number(config.after);
    if (!Number.isSafeInteger(config.after) || config.after < 0) throw new Error('--after must be a nonnegative integer');
  }
  if (config.revision !== undefined) {
    config.revision = Number(config.revision);
    if (!Number.isSafeInteger(config.revision) || config.revision < 0) throw new Error('--revision must be a nonnegative integer');
  }
  if (!config.actor.trim()) throw new Error('--actor must not be empty');
  config.command = positional[0];
  config.json = positional[1];
  if (positional.length > 2) throw new Error('Quote JSON params as a single argument');
  if (config.stdin && config.json !== undefined) throw new Error('Use JSON params or --stdin, not both');
  return config;
}

function scrub(message, config) {
  let text = String(message);
  for (const secret of [config?.token, config?.sitesToken]) if (secret) text = text.split(secret).join('[redacted]');
  return text;
}

function paramsObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Params must be a JSON object');
  return value;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
    if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new Error('JSON params exceed 2 MiB');
  }
  return data;
}

function client(config) {
  async function request(path, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    if (config.sitesToken) headers['OAI-Sites-Authorization'] = `Bearer ${config.sitesToken}`;
    let response;
    try {
      response = await fetch(`${config.url}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
    } catch (error) {
      throw new Error(`Cannot reach Viewherd at ${config.url}: ${scrub(error.message, config)}`);
    }
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch {
      if ([401, 403].includes(response.status)) throw new Error(`Access denied (${response.status}). Check the server or hosted service credential.`);
      throw new Error(`Viewherd returned HTTP ${response.status} without JSON. Check --url and hosted access.`);
    }
    if (!response.ok || data.error) {
      const error = data.error;
      throw new Error(scrub(typeof error === 'string' ? error : error?.message || `HTTP ${response.status}`, config));
    }
    return data;
  }
  return {
    state: () => request('/api/state'),
    schema: () => request('/api/schema'),
    events: (after) => request(`/api/events?after=${encodeURIComponent(after)}`),
    call: (method, params = {}, id = config.id || randomUUID(), expectedRevision = config.revision) => request('/api/rpc', {
      id, method, params: { actor: config.actor, ...paramsObject(params) },
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  };
}

function compact(response) {
  return { id: response.id, revision: response.revision, result: response.result, ...(response.replayed === undefined ? {} : { replayed: response.replayed }) };
}

function print(value, config, pretty = true) {
  process.stdout.write(scrub(JSON.stringify(value, null, pretty ? 2 : undefined), config) + '\n');
}

async function watch(api, config) {
  let revision = config.after;
  if (revision === undefined) {
    const initial = await api.state();
    revision = initial.revision ?? initial.state?.revision ?? 0;
  }
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      const batch = await api.events(revision);
      for (const event of batch.events || []) {
        print(event, config, false);
        revision = Math.max(revision, event.revision || 0);
      }
      revision = Math.max(revision, batch.revision || 0);
      if (batch.resetRequired || batch.reset || batch.truncated) print({ type: 'resync', revision, reason: 'Event history was trimmed; request a snapshot.' }, config, false);
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, config.interval));
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function demo(api, config) {
  // Each step is a real API mutation in a newly created workspace.
  const created = await api.call('workspace.create', { label: `CLI demo · ${new Date().toISOString().slice(11, 19)}`, title: 'Agent handoff', view: 'document' }, randomUUID());
  const result = created.result || {};
  const workspaceId = result.workspaceId || result.workspace?.id || result.id;
  const workspace = created.state?.workspaces?.find((item) => item.id === workspaceId) || result.workspace;
  const tabId = result.tabId || result.tab?.id || workspace?.tabs?.[0]?.id;
  const paneId = result.paneId || result.pane?.id || result.tab?.focusedPaneId || workspace?.tabs?.[0]?.focusedPaneId;
  if (!workspaceId || !tabId || !paneId) throw new Error('Demo workspace created, but its tab/pane IDs were absent. Inspect viewherd snapshot.');
  print({ step: 'workspace.create', ...compact(created) }, config, false);
  const split = await api.call('pane.split', { paneId, direction: 'right', view: 'tasks', title: 'Launch checklist', data: { items: [
    { id: 'demo-workspace', text: 'Create a workspace through the API', done: true },
    { id: 'demo-split', text: 'Split a pane and publish a shared document', done: true },
    { id: 'demo-human', text: 'Take over in the web UI', done: false },
  ] } }, randomUUID(), created.revision);
  print({ step: 'pane.split', ...compact(split) }, config, false);
  const note = await api.call('view.update', { paneId, data: { content: '# Viewherd is controlled through its API\n\nThis workspace was created by the dependency-free CLI. The same operations are available to an agent through MCP.\n\n- Created a separate workspace\n- Split a live pane\n- Updated this shared document\n\nEdit this note in the web UI and run `viewherd snapshot` to see the change.' } }, randomUUID(), split.revision);
  print({ step: 'view.update', ...compact(note) }, config, false);
  const status = await api.call('agent.report', { id: 'cli-demo', name: 'CLI demo', paneId, status: 'done', message: 'CLI demo complete. Take over in the web UI.' }, randomUUID(), note.revision);
  print({ step: 'agent.report', ...compact(status) }, config, false);
  process.stderr.write(`Demo ready in ${config.url}. Select the new CLI demo workspace.\n`);
}

const MCP_TOOLS = [
  { name: 'viewherd_call', description: 'Operate the live shared Viewherd UI. Call viewherd_schema first for method names and params. Use a stable id when retrying, and expectedRevision to reject stale edits.', inputSchema: { type: 'object', properties: { method: { type: 'string' }, params: { type: 'object', additionalProperties: true }, id: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 } }, required: ['method'], additionalProperties: false } },
  { name: 'viewherd_snapshot', description: 'Read current Viewherd workspaces, tabs, panes, views, and revision.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'viewherd_schema', description: 'Read the live API schema before operating Viewherd.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

async function mcp(api, config) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch {
      print({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }, config, false);
      continue;
    }
    if (message.id === undefined) continue;
    let result;
    let error;
    try {
      if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'viewherd-lab', version: '0.2.0' } };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list') result = { tools: MCP_TOOLS };
      else if (message.method === 'tools/call') {
        const name = message.params?.name;
        const args = message.params?.arguments || {};
        try {
          let data;
          if (name === 'viewherd_snapshot') data = await api.state();
          else if (name === 'viewherd_schema') data = await api.schema();
          else if (name === 'viewherd_call') {
            if (typeof args.method !== 'string' || !args.method) throw new Error('method is required');
            if (args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)) throw new Error('expectedRevision must be a nonnegative integer');
            data = compact(await api.call(args.method, args.params || {}, args.id || randomUUID(), args.expectedRevision));
          } else throw new Error(`Unknown tool: ${name}`);
          result = { content: [{ type: 'text', text: scrub(JSON.stringify(data), config) }] };
        } catch (cause) {
          result = { isError: true, content: [{ type: 'text', text: scrub(cause.message, config) }] };
        }
      } else error = { code: -32601, message: `Unknown method: ${message.method}` };
    } catch (cause) { error = { code: -32603, message: scrub(cause.message, config) }; }
    print({ jsonrpc: '2.0', id: message.id, ...(error ? { error } : { result }) }, config, false);
  }
}

let config;
try {
  config = parse(process.argv.slice(2));
  if (config.help || (!config.command && !config.mcp)) process.stdout.write(HELP);
  else {
    const api = client(config);
    if (config.mcp) await mcp(api, config);
    else if (config.command === 'snapshot') print(await api.state(), config);
    else if (config.command === 'schema') print(await api.schema(), config);
    else if (config.command === 'watch') await watch(api, config);
    else if (config.command === 'demo') await demo(api, config);
    else {
      if (!/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/.test(config.command)) throw new Error('Use a dot-separated API method, e.g. pane.split. Run viewherd schema for available methods.');
      const raw = config.stdin ? await readStdin() : config.json || '{}';
      let params;
      try { params = JSON.parse(raw); } catch { throw new Error('Params must be valid JSON'); }
      const response = await api.call(config.command, paramsObject(params));
      print(config.full ? response : compact(response), config);
    }
  }
} catch (error) {
  process.stderr.write(`viewherd: ${scrub(error.message, config)}\n`);
  process.exitCode = 1;
}
