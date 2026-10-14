# @viewherd/core

Viewherd's dependency-free state runtime. This package is part of the Viewherd source release; it is not published to npm.

```js
import { definePanel, createRegistry, createSession, executeCommand } from '@viewherd/core';

const registry = createRegistry([definePanel({
  type: 'counter',
  title: 'Counter',
  dataSchema: { type: 'object', additionalProperties: false },
  actions: {
    increment: {
      description: 'Increase the shared counter by one.',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'integer' },
      run(ctx) { ctx.app.count += 1; return ctx.app.count; },
    },
  },
})]);

let state = createSession({
  id: 'demo', view: 'counter', title: 'Shared counter',
  app: { count: 0 }, registry,
});

const outcome = await executeCommand(state, {
  version: 1, requestId: 'increment-1', sessionId: 'demo',
  method: 'panel.action',
  params: { paneId: 'pane_inbox', action: 'increment', args: {} },
}, { registry, principal: { id: 'alice' } });
state = outcome.state;
```

`createSession()` makes `ws_main`, `tab_main`, and `pane_inbox`. Custom initial panel data can validate eagerly by passing `registry`; otherwise it validates before the first command. Layout commands reuse the same engine as the standalone lab. `api.schema` includes application panel/action definitions without handler functions.

Actions receive a private mutable `ctx.app`, live `ctx.pane` and `ctx.state`, authenticated `ctx.principal`, and a synchronous `ctx.call(method, params)` for layout/data operations. `ctx.call()` returns the operation's result, not a response envelope. Nested `panel.action` calls are rejected. A successful handler and every nested change commit as one revision and one event; any error discards the complete draft. Returning an invalid result also rolls back. Handlers may be async, but must perform deterministic transactional state changes only. External network calls, email, payments, and browser-local execution are outside this contract.

The runtime validates plain JSON, custom input/output/data schemas, layout invariants, and the 900 KB state limit. The supported schema subset includes types (and type unions), properties, required, additionalProperties, items, enum, const, numeric bounds, string lengths/patterns, array/property counts, and title/description/default annotations. Defaults are documentation, not automatically applied. Unsupported keywords fail during registration. Accessors, hostile prototypes, unsafe keys, cycles, sparse arrays, nonfinite numbers and non-JSON results are rejected.

`executeCommand()` is always async and returns `{state, result, changed}`. It validates `expectedRevision`; retry receipts and authentication are provided by `@viewherd/server`, not by the bare runtime. When a principal is supplied, event attribution comes from `principal.actor` or `principal.id`, never a caller's `params.actor`.
