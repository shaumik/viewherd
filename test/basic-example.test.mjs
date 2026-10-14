import test from "node:test";
import assert from "node:assert/strict";
import { createBasicHandler } from "../examples/basic/server.mjs";

const request = (path, body, headers = {}) =>
  new Request(`http://localhost:4318${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const snapshot = async (handler) =>
  (await handler(request("/viewherd/snapshot"))).json();
const chat = (handler, message, requestId, expectedRevision) =>
  handler(
    request("/assistant", {
      message,
      requestId,
      expectedRevision,
    }),
  );

test("basic chat creates, edits and closes server-owned panels", async () => {
  const handler = createBasicHandler();
  const initial = await snapshot(handler);
  const originalText = initial.panes.pane_inbox.data.text;

  assert.equal(
    (await chat(handler, "Open a note", "open-1", initial.revision)).status,
    200,
  );
  const opened = await snapshot(handler);
  assert.equal(Object.keys(opened.panes).length, 2);
  const noteId = Object.keys(opened.panes).find((id) => id !== "pane_inbox");
  assert.equal(opened.panes[noteId].view, "note");

  assert.equal(
    (
      await chat(
        handler,
        'Update the note to "Hello from the backend"',
        "edit-1",
        opened.revision,
      )
    ).status,
    200,
  );
  const edited = await snapshot(handler);
  assert.equal(edited.panes[noteId].data.text, "Hello from the backend");
  assert.equal(edited.panes.pane_inbox.data.text, originalText);

  assert.equal(
    (await chat(handler, "Close the note", "close-1", edited.revision)).status,
    200,
  );
  const closed = await snapshot(handler);
  assert.deepEqual(Object.keys(closed.panes), ["pane_inbox"]);
  assert.equal(closed.panes.pane_inbox.data.text, originalText);
  assert.equal(closed.revision, initial.revision + 3);
});

test("basic open request retries create one panel and stale edits do not overwrite", async () => {
  const handler = createBasicHandler();
  const initial = await snapshot(handler);
  const first = await chat(
    handler,
    "Open a note",
    "open-once",
    initial.revision,
  );
  const retry = await chat(
    handler,
    "Open a note",
    "open-once",
    initial.revision,
  );
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), await first.json());
  const opened = await snapshot(handler);
  assert.equal(Object.keys(opened.panes).length, 2);
  assert.equal(opened.revision, 1);

  const stale = await chat(
    handler,
    'Update the note to "Stale text"',
    "stale-edit",
    initial.revision,
  );
  assert.equal(stale.status, 409);
  assert.deepEqual(await snapshot(handler), opened);
});

test("invalid basic commands and foreign origins leave the session unchanged", async () => {
  const handler = createBasicHandler();
  const initial = await snapshot(handler);
  for (const body of [
    null,
    {},
    { message: "Make a sandwich", requestId: "unknown", expectedRevision: 0 },
    { message: "Open a note", requestId: "", expectedRevision: 0 },
    { message: "Open a note", requestId: "bad-revision", expectedRevision: -1 },
    { message: "Close the note", requestId: "last-note", expectedRevision: 0 },
  ]) {
    assert.equal((await handler(request("/assistant", body))).status, 400);
  }
  const foreign = request(
    "/assistant",
    { message: "Open a note", requestId: "foreign", expectedRevision: 0 },
    { origin: "https://other.test" },
  );
  assert.equal((await handler(foreign)).status, 403);
  const oversized = request("/assistant", {
    message: "x".repeat(3000),
    requestId: "large",
    expectedRevision: 0,
  });
  assert.equal((await handler(oversized)).status, 413);
  assert.deepEqual(await snapshot(handler), initial);
  assert.equal(await handler(request("/client.js")), null);
});

test("basic HTTP and MCP expose the registered note actions", async () => {
  const handler = createBasicHandler();
  const schema = await (await handler(request("/viewherd/schema"))).json();
  const note = schema.panels.find((panel) => panel.type === "note");
  assert.ok(note);
  assert.deepEqual(note.actions.map((action) => action.name).sort(), [
    "open",
    "update",
  ]);
  const tools = await (
    await handler(
      request("/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    )
  ).json();
  assert.ok(
    tools.result.tools.some(
      (tool) => tool.name === "viewherd_action_note_open",
    ),
  );
  assert.ok(
    tools.result.tools.some(
      (tool) => tool.name === "viewherd_action_note_update",
    ),
  );
});

test("basic backend mutations reach the browser through the SDK event stream", async () => {
  const handler = createBasicHandler();
  const response = await handler(request("/viewherd/events"));
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let wire = decoder.decode((await reader.read()).value);
  assert.match(wire, /event: snapshot/);
  try {
    assert.equal(
      (await chat(handler, "Open a note", "stream-open", 0)).status,
      200,
    );
    while (!wire.includes("event: state.changed")) {
      const next = await reader.read();
      assert.equal(next.done, false);
      wire += decoder.decode(next.value);
    }
    const changed = wire.split("event: state.changed")[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(changed)[1]);
    assert.equal(data.revision, 1);
    assert.equal(Object.keys(data.state.panes).length, 2);
  } finally {
    await reader.cancel();
  }
});
