# Viewherd SDK

Viewherd lets an application expose a workspace to people and agents through structured operations. It provides the layout and synchronization; your application defines the domain state, panel renderers, authorized actions, and access policy.

## Packages and adoption

The repository uses native ESM and local npm workspaces. The `@viewherd/*` names are not published to npm. From the root, run `npm install --offline --ignore-scripts`, then `npm run example` to inspect a working integration.

| Package | Server/browser | Main exports |
| --- | --- | --- |
| `@viewherd/core` | Server | `definePanel`, `createRegistry`, `createSession`, `executeCommand` |
| `@viewherd/server` | Server | `createViewherdHandler`, `createMemoryStore`, `createD1Store` |
| `@viewherd/server/node` | Node server | `createFileStore` |
| `@viewherd/client` | Browser or Fetch-capable client | `createClient`, `ViewherdError` |
| `@viewherd/dom` | Browser | `mountWorkspace` |
| `@viewherd/dom/styles.css` | Browser stylesheet | Structural workspace styles |

For an application in the same checkout, declare these local workspaces as dependencies. For a separate application during development, use local `file:` dependencies pointing at the packages in this checkout. Do not run `npm install @viewherd/core` expecting a published release.

To install a portable package build in another application, first run `npm run pack:sdk` in this repository. With the two application folders beside each other, run this in your application:

```sh
npm install --offline --ignore-scripts \
  ../viewherd/artifacts/npm/viewherd-core-0.2.0.tgz \
  ../viewherd/artifacts/npm/viewherd-client-0.2.0.tgz \
  ../viewherd/artifacts/npm/viewherd-dom-0.2.0.tgz \
  ../viewherd/artifacts/npm/viewherd-server-0.2.0.tgz
```

Install the core archive together with the server archive, because the server declares `@viewherd/core` as a dependency. Package exports include TypeScript declarations. Native browsers can load the dependency-free client and DOM modules directly; your build tool can resolve the same package imports.

The product studio's domain and renderers are in `examples/product-studio/`. A second application is in `examples/support-desk/`. The reusable code is in `packages/`. The original lab uses the separate legacy contract in [API.md](API.md).

## Define panels and actions

Definitions are server-side contracts. Renderers are browser-side UI. Neither contains the other's implementation.

```js
import { definePanel, createRegistry, createSession } from '@viewherd/core';

const notes = definePanel({
  type: 'notes',
  title: 'Notes',
  description: 'A shared note with a validated save action.',
  dataSchema: {
    type: 'object',
    properties: { content: { type: 'string', maxLength: 10000 } },
    required: ['content'],
    additionalProperties: false
  },
  actions: {
    save: {
      description: 'Replace the note content.',
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string', maxLength: 10000 } },
        required: ['content'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: { saved: { type: 'boolean' } },
        required: ['saved'],
        additionalProperties: false
      },
      run(ctx, args) {
        ctx.call('view.update', {
          paneId: ctx.pane.id,
          data: { content: args.content }
        });
        return { saved: true };
      }
    }
  }
});

const registry = createRegistry([notes]);
const createState = id => createSession({
  id,
  label: 'Team notes',
  view: 'notes',
  title: 'Notes',
  data: { content: '' },
  app: {},
  registry
});
```

The registry publishes serializable panel and action schemas, never handler functions. Use `registry.get(type)`, `registry.has(type)`, and `registry.schema()` to inspect it.

An action handler receives:

| Context field | Meaning |
| --- | --- |
| `app` | Mutable application state on this transaction's private draft |
| `pane` | The target pane on the draft, or `undefined` after the handler closes it |
| `state` | The current draft workspace graph |
| `call(method, params)` | Synchronous layout/data operation within this transaction |
| `principal` | Authenticated identity returned by the host's authorization function |
| `requestId` | ID of the outer command |

Keep domain records in `state.app` and panel configuration in `pane.data`. A ticket pane can contain `{ticketId}` while the ticket and draft live in application state. Actions can update records and open, move, or close panels atomically.

Handlers may return a promise, but must remain short, deterministic state transitions. A storage compare-and-set retry can run a handler again. Network requests, payment changes, email delivery, random values, and wall-clock-derived decisions do not belong in this handler. A failed handler or validation failure commits none of its draft changes. Successful nested changes become one state revision. `ctx.call` supports synchronous layout/data operations and returns their result; nesting another `panel.action` is rejected. `executeCommand` is asynchronous and returns `{state, result, changed}`.

Schemas use a deliberately limited JSON Schema subset: objects, arrays, strings, numbers, integers, booleans, null, required fields, additional properties, enum/const, numeric bounds, string/array length, patterns, and item schemas. Unsupported keywords are rejected at registration. Defaults are annotations and are not applied automatically. This is not a general JSON Schema implementation.

## Mount an authenticated server

```js
import { createViewherdHandler, createMemoryStore } from '@viewherd/server';

const store = createMemoryStore({ createState });
const handleViewherd = createViewherdHandler({
  registry,
  store,
  basePath: '/viewherd',
  mcpPath: '/mcp',
  async authorize(request, command) {
    const user = await authenticateWithYourApplication(request);
    if (!user) return null;
    if (!await userCanAccessSession(user.id, command.sessionId)) {
      throw Object.assign(new Error('Session access denied'), {
        code: 'forbidden'
      });
    }
    return { id: user.id, name: user.name };
  }
});

// Route requests for /viewherd/* and /mcp through handleViewherd(request).
// It accepts a Fetch Request and returns a Fetch Response.
```

`authorize` is mandatory. It runs before state reads, streams, schema access, and commands. Return a plain JSON principal with a nonempty string `id` of at most 120 characters; optional `name` and `actor` support attribution. Omit absent fields rather than returning `undefined` values. A null/false result returns 401. Throw an error with `code: 'forbidden'` or `status: 403` to deny access with 403. Invalid principal objects are server configuration errors.

Check both the authenticated user and session membership. A caller-supplied session ID or actor name is never authority. You can also inspect `method` and `params` to restrict individual operations. Origin checks complement authentication; they do not replace it. Use HTTPS and your application's normal credential handling in deployment.

Stores implement `read(sessionId)` and `transact(sessionId, transaction)`. Memory storage is process-local and transient. The Node file store persists local state; D1 uses transactional compare-and-set with bounded retries and the shipped `webdr_sessions` migration. SDK rows are namespaced separately from the legacy lab. A multi-process deployment needs a shared store with equivalent conflict handling.

The handler requires Fetch Request/Response, streams, and Web Crypto in its host runtime. The included Node server initializes these appropriately. When embedding the handler in Node.js 18, initialize Web Crypto in your host bootstrap:

```js
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
```

## Mount your browser UI

```js
import { createClient } from '@viewherd/client';
import { mountWorkspace } from '@viewherd/dom';
// Also load @viewherd/dom/styles.css through your application's CSS tooling.

const client = createClient({
  baseUrl: '/viewherd',
  sessionId: 'team-notes'
});
await client.snapshot();

const workspace = mountWorkspace(document.querySelector('#workspace'), {
  client,
  panels: {
    notes: {
      mount(host, ctx) {
        const content = document.createElement('p');
        host.append(content);
        function update(next) {
          content.textContent = next.pane.data.content;
        }
        update(ctx);
        return { update, destroy() { content.remove(); } };
      }
    }
  }
});

// When the host application unmounts:
// workspace.destroy();
// client.destroy();
```

Renderer context contains `{pane, state, client, action}`. Call `ctx.action('save', {content})` to invoke the current pane's registered action. You can use your framework inside a renderer; Viewherd only owns the workspace shell and renderer host element.

`mount` synchronously returns `{update(ctx), destroy?()}`; an async mount is not supported. Existing pane hosts remain connected during layout changes, preserving mounted component state, focus, and iframe state. Your renderer should retain unsaved input separately from authoritative state and resolve a revision conflict explicitly instead of silently replacing a person's draft. `destroy` must release your renderer's listeners and resources. Use `onPaneClose` to save or resolve pending input before allowing a pane to close.

The shell supplies panel headers, focus, close, zoom, resizing, and an optional tab bar. `mountWorkspace` options include `tabBar`, `onPaneFocus`, and `onPaneClose`. Its CSS uses `wd-` classes; your panel content remains application-owned.

## Client lifecycle

| Client API | Result |
| --- | --- |
| `snapshot()` | Fetch and retain the authoritative state |
| `schema()` | Fetch the running method/panel/action schemas |
| `call(method, params, options?)` | Execute a command; return its response envelope |
| `state` | Latest accepted state, initially `null` |
| `subscribe((state, event) => {})` | Subscribe to state updates; returns an unsubscribe function |
| `destroy()` | Abort streams and release subscriptions |

`call` options accept `requestId`, `expectedRevision`, and an optional abort `signal`. The client generates a request ID when omitted. For a retry after an uncertain outcome, supply the same ID and unchanged command. For a human edit based on a snapshot, pass that snapshot's revision and show a merge/reload decision on conflict. Structured failures throw `ViewherdError` with `code`, `status`, and the server response. The client accepts authoritative error state before throwing when the server provides it.

The first subscriber starts one shared Fetch-based SSE connection. The client can use supplied `fetch` and `headers` options for your authentication system; `headers` may be an async function to obtain current credentials. It reconnects with a cursor and backoff, refuses decreasing revisions, and aborts streaming when no subscribers remain. Streaming headers must use the same authorized identity as command calls. `onConnection` receives `{status, attempt, error?}` with connecting, connected, reconnecting, disconnected, or error status.

## Wire contract

| Endpoint | Purpose |
| --- | --- |
| `GET /viewherd/snapshot?sessionId=ID` | Current session state |
| `GET /viewherd/schema?sessionId=ID` | Method and registered panel schemas |
| `GET /viewherd/events?sessionId=ID` | SSE authoritative-state subscription |
| `POST /viewherd/rpc` | Command execution |
| `POST /mcp` | MCP adapter to the same dispatcher |

Command envelope:

```json
{
  "version": 1,
  "requestId": "save-note-001",
  "sessionId": "team-notes",
  "method": "panel.action",
  "params": {
    "paneId": "pane_inbox",
    "action": "save",
    "args": { "content": "Review the release notes." }
  },
  "expectedRevision": 4
}
```

All RPC commands require `version`, `requestId`, and `sessionId`. The initial SDK pane is `pane_inbox`; for subsequent operations use IDs returned by commands or found in the snapshot. `panel.action` requires an explicit pane ID, registered action name, and schema-valid arguments. Custom views work with `workspace.create`, `tab.create`, `pane.split`, `view.open`, and `view.update`.

Success returns `{version, requestId, sessionId, result, revision, state, replayed?}`. Errors return `{version, requestId, sessionId, error:{code,message}, state?}` with an appropriate HTTP status. State is a complete authoritative snapshot. A stale expected revision returns a conflict rather than applying a stale write.

The layout methods and builtin view actions remain available; see [API.md](API.md) for their parameters. For the SDK, wrap them in the new envelope above and use `/viewherd/rpc`. The running SDK schema is authoritative for custom panel actions and current limits. The legacy `/api/*` routes remain a separate compatibility surface.

## Streaming and MCP

Viewherd uses request/response commands plus one-way state streaming. A command acknowledgement says what committed; the SSE stream brings connected interfaces up to date. No WebSocket is needed for this contract.

SSE begins with a snapshot and delivers `state.changed` events containing `{sessionId, revision, state, requestId?}`. Event IDs are revisions. Reconnect with `Last-Event-ID`; when its cursor is too old the server sends `resync_required` and a fresh snapshot. The stream is a state subscription, not a replay of every intermediate transition or an audit ledger.

The current adapter checks storage roughly once per second. It sends heartbeats and ends bounded streams so clients reconnect and reauthorize. This is streaming over HTTP, with bounded polling latency inside the storage adapter. Client cancellation releases the connection.

MCP calls use the same authorization, schema validation, transaction, revision checks, and request receipts as HTTP RPC. It provides `viewherd_snapshot`, `viewherd_schema`, `viewherd_call`, and generated panel-action tools; inspect `tools/list` for their exact names and arguments. Supply an explicit session ID and a stable command request ID. The JSON-RPC ID is a response correlation ID, not the command retry key. For discovery, configure a fixed session on the handler or include `?sessionId=ID` in the MCP endpoint URL. Your MCP client chooses the agent/model. Viewherd supplies no model runtime.

The adapter supports the MCP 2026-07-28 request contract and stateless compatibility with 2025-11-25, 2025-06-18, and 2025-03-26. Modern requests require protocol version and client capabilities in `params._meta`, matching `MCP-Protocol-Version` and `Mcp-Method` headers, and `Mcp-Name` for tool calls. There is no modern initialization handshake. It does not implement sampling, elicitation, OAuth middleware, or MCP subscription streams. See [the server package guide](../packages/server/README.md#mcp) for transport details.

The application's SSE endpoint is separate from MCP transport. A browser state subscription does not need to be an MCP client. Do not send MCP JSON-RPC to `/viewherd/rpc` or Viewherd command envelopes directly to `/mcp`.

## Operational limits

Request receipts provide bounded idempotency, not permanent exactly-once execution. They bind the command to its authenticated principal and session. Reusing an ID with different parameters or identity is a conflict. Successful mutation receipts, including no-ops, are retained for at most 24 requests and 200 KB of receipt data. An individual action result is limited to 160 KB. Receipts may expire sooner because of their aggregate byte limit; inspect current state after a long disconnect. External delivery requires the host's own deduplication mechanism.

Workspace state is bounded to roughly 900 KB and request bodies to 300 KB. Recent events and request receipts are bounded. The base workspace limits include 16 workspaces, 16 tabs per workspace, 32 panes per session, and 150 recent events. Ask the running schema for all limits. This snapshot-based design is intended for compact application state, not large file contents or a complete historical ticket database.

Session isolation is a storage boundary; authentication and tenant authorization are host responsibilities. Snapshots expose the entire authorized session, including `state.app`. Hiding a panel does not hide its data from that session's clients. Put only data all session members may read into the session; keep credentials and private server data outside it.

The included example authorizes one sample session. Before operating on real customer data, supply your identity/access policy, shared durable storage, operational monitoring, rate limits, migration policy, and reliable integrations. No claim of cross-system atomicity, external exactly-once effects, or a complete production service is made.
