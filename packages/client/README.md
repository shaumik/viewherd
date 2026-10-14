# @viewherd/client

Dependency-free ESM client for a Viewherd session. This local package is not yet published to npm.

```js
import { createClient } from '@viewherd/client';

const client = createClient({ baseUrl: '/viewherd', sessionId: 'product-studio' });
await client.snapshot();
const unsubscribe = client.subscribe((state, event) => render(state));
await client.call('panel.action', {
  paneId: 'pane_inbox', action: 'open', args: { ticketId: 'SUP-1042' }
});
// When this application leaves the session:
unsubscribe();
client.destroy();
```

`snapshot()` returns authoritative session state. `schema()` reads the server's discoverable contract. `call()` sends a version 1 command and returns its response envelope. Errors throw `ViewherdError` with `code`, HTTP `status`, and any authoritative conflict `state`.

Pass `expectedRevision` for edits that must not overwrite an intervening update. Pass an explicit `requestId` when retrying the same command; do not reuse it for changed parameters. The server controls the bounded replay window. The client does not automatically retry mutations.

Subscribers share one fetch-based SSE connection with authentication headers, resume cursors, revision guards, and reconnect backoff. Unsubscribing the final listener aborts the stream. Repeated or older revisions never replace current state. A `resync_required` event reports a server-requested reset; the following snapshot restores state. `onConnection` receives `{status, attempt, error?}`.

`headers` accepts a `HeadersInit` or a function returning fresh headers, including an async function for refreshed credentials. Browser cookie authentication uses fetch's normal same-origin behavior. The application supplies real authorization on the server. Treat `client.state` and subscriber state as read-only; send all durable changes through commands.
