# @viewherd/server

Web-standard HTTP, SSE and MCP adapters for an application-controlled Viewherd session. The package is native ESM with no transport dependencies. It depends on `@viewherd/core`; local package tarballs are built from the repository with `npm run pack:sdk`. These package names are not published to npm.

Workers and current Node versions provide Web Crypto. A standalone Node 18 host must add this before creating its handler (the repository's example server already does):

```js
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
```

```js
import { createRegistry, createSession } from '@viewherd/core';
import { createViewherdHandler, createMemoryStore } from '@viewherd/server';

const registry = createRegistry(myPanels);
const store = createMemoryStore({
  createState: id => createSession({ id, view: 'my-panel', registry })
});
const handle = createViewherdHandler({
  registry, store,
  async authorize(request, { sessionId, method, params }) {
    const user = await yourExistingAuthentication(request);
    if (!user) return null;
    if (!await yourSessionAccessCheck(user, sessionId, method, params)) {
      throw Object.assign(new Error('Session access denied.'), { code: 'forbidden' });
    }
    return { id: user.id, name: user.name };
  }
});
// In a Worker, framework route, or other Request/Response host:
const response = await handle(request);
```

`authorize` is mandatory. A principal must be a JSON object with a non-empty `id` of at most 120 characters. Optional `actor` has the same limit; it supplies audit attribution. Caller-supplied actor fields cannot confer authority. Return `null` or `false` for HTTP 401; throw an error with `code: 'forbidden'` or `status: 403` for HTTP 403. Unexpected authentication errors return HTTP 500 without exposing internal messages. Perform your own session, action and data access checks here. The adapter neither mints accounts nor assumes tenant access.

## Wire contract

Default routes are `GET /viewherd/snapshot`, `GET /viewherd/schema`, `GET /viewherd/events`, `POST /viewherd/rpc` and `POST /mcp`. GET routes require `?sessionId=your-session` unless a fixed `sessionId` is configured on the handler. A configured session also rejects other session IDs. IDs have at most 120 characters and match `[A-Za-z0-9][A-Za-z0-9_.:-]*`.

```json
{
  "version": 1,
  "requestId": "one-stable-id-per-command",
  "sessionId": "your-session",
  "method": "panel.action",
  "params": {"paneId":"pane_inbox","action":"open","args":{"ticketId":"SUP-1042"}},
  "expectedRevision": 12
}
```

Success returns `{version, requestId, sessionId, result, revision, state, replayed?}`. Failure returns `{version, requestId, sessionId, error:{code,message}, state?}` with a real HTTP status. Stale revisions and reused request IDs return HTTP 409. A fresh command after a conflict requires a **new** request ID. Conflict state is returned only after authenticating that exact session again. Snapshot GET returns the state directly; schema GET returns the core operation schemas and serializable registered panel definitions.

Mutations, including no-ops, remember exact results in a bounded retry window: at most 24 receipts and 200 KB of receipts per session. One action result may contain at most 160 KB; larger results fail before commit. Receipts bind session, method, canonical parameters, expected revision and authenticated principal ID. Replaying an unchanged request ID returns its original result alongside the current authoritative state. An expired receipt is no longer an exactly-once guarantee: durable external effects require the host's own transactional outbox and business idempotency, and are not supported inside panel handlers.

Requests are limited to 300 KB and session state to 900 KB. Mutations and receipt-only updates advance an independent storage generation, preventing lost no-op receipts under concurrent writers. Reads do not write receipts. No session or state is read before host authorization succeeds.

## Streaming

The Viewherd events route is SSE. It sends `snapshot` initially, then `state.changed` when the persisted revision advances. Every event carries `{sessionId,revision,state}` and an SSE `id` equal to its revision. It does not synthesize application events. The server polls durable storage every 900 ms by default; snapshots may coalesce multiple commits. It respects stream backpressure by retaining the latest revision rather than buffering successive full states.

Reconnect with `Last-Event-ID`. If the revision lies outside retained event history, the stream sends `resync_required` followed by a current snapshot. Heartbeat comments keep idle connections active. Connections end after 25 seconds and the client reconnects; abort, cancellation, authorization failure and expiration clear timers and close the stream. Host authorization is rechecked before each poll. `stream` options allow `pollIntervalMs`, `heartbeatMs` and `lifetimeMs`; lifetime cannot exceed 60 seconds. Viewherd SSE is separate from the MCP protocol's transport.

## MCP

The same dispatcher serves `viewherd_snapshot`, `viewherd_schema`, `viewherd_call` and generated `viewherd_action_{panel}_{action}` tools with the registered action's argument schema. Action tool target types are checked inside the transaction, including CAS retries. MCP `viewherd_call` requires `requestId`; the JSON-RPC ID is not a mutation idempotency key.

Modern MCP 2026-07-28 requests supply `params._meta` protocol version and client capabilities, plus matching `MCP-Protocol-Version`, `Mcp-Method`, and, for tools/call, `Mcp-Name` headers. Results include `resultType: 'complete'` and server identity metadata. `server/discover` advertises supported versions. Unknown modern versions and header mismatches are rejected; modern `initialize` is not implemented. Legacy stateless initialization is supported for 2025-11-25, 2025-06-18 and 2025-03-26. There is no 2024 HTTP+SSE transport, protocol session lifecycle, sampling, elicitation, or MCP subscription stream. Use an authorized default session or `?sessionId=...` for MCP discovery; tool arguments may select a session subject to host authorization.

Origins must match the request URL when an `Origin` header is present. `trustedMcpOrigin: true` permits cross-origin MCP traffic only for an upstream service that authenticates and validates that traffic; mandatory host authorization still runs. Browser clients must use a same-origin proxy. The host must validate its accepted hostnames, provide HTTPS and configure its existing authentication. This SDK does not install CORS or OAuth middleware.

## Stores

`createMemoryStore({createState,maxSessions})` is ephemeral and defaults to at most 1,000 sessions. `createD1Store(db,{createState,retries})` uses the repository's `webdr_sessions` SQL migration and stores each session under `sdk:{sessionId}`, isolated from legacy demo state. D1 retries compare-and-swap conflicts up to six times. Actions must be short, deterministic state transactions because CAS may invoke them more than once before a commit.

```js
import { createFileStore } from '@viewherd/server/node';
const store = createFileStore({ path: './data/viewherd.json', createState });
```

The file adapter serializes adapters within **one Node process**, writes a private temporary file, syncs it, and atomically renames it. It does not provide locks for multiple processes or machines. Use D1 or implement the store contract for a transactional production database in that case.

Custom stores implement `read(sessionId) -> {state,receipts,storageRevision}` and `transact(sessionId, callback) -> response`. The callback receives a private record and returns `{record,response,changed}`. Committed changes advance `storageRevision` exactly once; aborted callbacks leave state untouched. Never share mutable records with other callers, and guarantee serialization or compare-and-swap for concurrent writers.
