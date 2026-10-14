import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { listAssetFiles } from "../src/assets.mjs";
globalThis.crypto ??= webcrypto;

const root = fileURLToPath(new URL("..", import.meta.url));
const [source, manifest] = await Promise.all([
  readFile(resolve(root, "dist/server/index.js"), "utf8"),
  readFile(resolve(root, "dist/.openai/hosting.json"), "utf8"),
]);
JSON.parse(manifest);
const worker = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
assert.equal(typeof worker.default?.fetch, "function");
assert.equal(typeof worker.makeD1Store, "function");

// Exercise the actual generated module with a CAS-capable D1 test adapter.
const rows = new Map();
const db = {
  prepare(sql) {
    return {
      bind(...args) {
        return {
          async first() {
            const row = rows.get(args[0]);
            return row ? { payload: row.payload } : null;
          },
          async run() {
            if (sql.startsWith("INSERT")) {
              if (!rows.has(args[0]))
                rows.set(args[0], { revision: args[1], payload: args[2] });
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith("UPDATE")) {
              const row = rows.get(args[3]);
              if (!row || row.revision !== args[4])
                return { meta: { changes: 0 } };
              rows.set(args[3], { revision: args[0], payload: args[1] });
              return { meta: { changes: 1 } };
            }
            throw new Error(`Unexpected validation SQL: ${sql}`);
          },
        };
      },
    };
  },
};
const request = (path, init) =>
  worker.default.fetch(new Request(`https://webdr.test${path}`, init), {
    DB: db,
  });
const home = await request("/");
assert.equal(home.status, 200);
assert.match(await home.text(), /<title>Forma/);
for (const path of [
  "/examples/product-studio/app.js",
  "/examples/product-studio/render.mjs",
  "/support",
  "/examples/support-desk/app.js",
  "/sdk/client/index.mjs",
  "/sdk/dom/index.mjs",
  "/sdk/dom/styles.css",
  "/lab",
])
  assert.equal((await request(path)).status, 200, path);
for (const [path, , type] of await listAssetFiles()) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get("content-type"), type, path);
}
for (const path of [
  "/examples/product-studio/server.mjs",
  "/examples/product-studio/chat/agents/openai.mjs",
  "/examples/product-studio/studio/state.mjs",
]) {
  assert.equal(
    (await request(path)).status,
    404,
    "Backend source must not be served: " + path,
  );
}
const schema = await (
  await request("/webdr/schema?sessionId=support-desk")
).json();
assert.ok(schema.methods.find((method) => method.name === "panel.action"));
assert.equal(schema.panels.length, 4);
const command = {
  version: 1,
  requestId: "artifact-open-primary",
  sessionId: "support-desk",
  method: "panel.action",
  params: {
    paneId: "pane_inbox",
    action: "open",
    args: { ticketId: "SUP-1042" },
  },
};
const opened = await (
  await request("/webdr/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  })
).json();
assert.ok(opened.result.paneId);
assert.equal(opened.state.panes[opened.result.paneId].view, "ticket");
const replay = await (
  await request("/webdr/rpc", { method: "POST", body: JSON.stringify(command) })
).json();
assert.equal(replay.replayed, true);
assert.equal(replay.result.paneId, opened.result.paneId);
const mcp = await (
  await request("/support/mcp", {
    method: "POST",
    headers: { "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
).json();
assert.ok(
  mcp.result.tools.find(
    (tool) => tool.name === "viewherd_action_ticket_prepareReply",
  ),
);
const legacy = await (await request("/api/schema")).json();
assert.equal(legacy.methods.length, 24);
assert.ok(rows.has("sdk:support-desk"));
const studioSchema = await (
  await request("/viewherd/schema?sessionId=product-studio")
).json();
assert.deepEqual(
  studioSchema.panels.map((panel) => panel.type),
  ["studio", "canvas", "inspector", "deliverables"],
);
const directionsCommand = {
  version: 1,
  requestId: "artifact-create-directions",
  sessionId: "product-studio",
  method: "panel.action",
  params: { paneId: "pane_inbox", action: "createDirections", args: {} },
};
const directionsResponse = await request("/viewherd/rpc", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(directionsCommand),
});
assert.equal(directionsResponse.status, 200);
const directions = await directionsResponse.json();
assert.equal(
  Object.values(directions.state.panes).filter((pane) => pane.view === "canvas")
    .length,
  2,
);
const studioMcp = await (
  await request("/mcp", {
    method: "POST",
    headers: { "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  })
).json();
assert.ok(
  studioMcp.result.tools.find(
    (tool) => tool.name === "viewherd_action_studio_createDirections",
  ),
);
assert.ok(rows.has("sdk:product-studio"));
assert.equal(
  (await request("/viewherd/snapshot?sessionId=support-desk")).status,
  403,
);
const assistantConfig = await request("/assistant");
assert.equal(assistantConfig.status, 200);
assert.equal((await assistantConfig.json()).mode, "demo");
const chatResponse = await request("/assistant", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    requestId: "artifact-chat-select",
    message: "Keep the dark one and make it cobalt",
  }),
});
assert.equal(chatResponse.status, 200);
const chatEvents = (await chatResponse.text())
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.ok(
  chatEvents.some(
    (event) => event.type === "done" && event.turn.status === "completed",
  ),
);
const chatWorkspace = await (
  await request("/viewherd/snapshot?sessionId=product-studio")
).json();
assert.equal(
  Object.values(chatWorkspace.panes).filter((pane) => pane.view === "canvas")
    .length,
  1,
);
assert.equal(chatWorkspace.app.designs.design_midnight.theme, "cobalt");
assert.ok(
  chatWorkspace.events.find(
    (event) => event.actor === "agent:studio" && event.action === "refine",
  ),
);
console.log(
  "Generated Worker serves Forma Studio, Relay, SDK modules, legacy lab, transactional actions, isolated sessions and MCP tools.",
);
