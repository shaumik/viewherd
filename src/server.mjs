import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { handleRequest, initialRecord, applyRequest } from "./http.mjs";
import { createAppHandler } from "./application.mjs";
import { createFileStore } from "@viewherd/server/node";
import { createSupportState } from "../examples/support-desk/domain.mjs";
import { createStudioState } from "../examples/product-studio/domain.mjs";
import { listAssetFiles } from "./assets.mjs";
import { createDemoAgent } from "../examples/product-studio/demo-agent.mjs";
import { createOpenAIAgent } from "../examples/product-studio/openai-agent.mjs";

globalThis.crypto ??= webcrypto;
const root = fileURLToPath(new URL("..", import.meta.url));
const dataFile = resolve(
  process.env.WEBDR_DATA_FILE ?? resolve(root, ".webdr/state.json"),
);
let record;
try {
  record = JSON.parse(await readFile(dataFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  record = initialRecord();
}
await mkdir(dirname(dataFile), { recursive: true });
let tail = Promise.resolve();
const store = {
  kind: "local-file",
  read: async () => {
    await tail;
    return record;
  },
  transact(body) {
    const operation = tail.then(async () => {
      const output = await applyRequest(record, body);
      if (output.changed) {
        const temp = `${dataFile}.tmp`;
        await writeFile(temp, JSON.stringify(output.record), "utf8");
        await rename(temp, dataFile);
        record = output.record;
      }
      return output.response;
    });
    tail = operation.catch(() => {});
    return operation;
  },
};
const supportStore = createFileStore({
  path: resolve(
    process.env.WEBDR_SUPPORT_DATA_FILE ??
      resolve(root, ".webdr/support-desk.json"),
  ),
  createState: createSupportState,
});
const studioStore = createFileStore({
  path: resolve(
    process.env.VIEWHERD_STUDIO_DATA_FILE ??
      resolve(root, ".webdr/product-studio.json"),
  ),
  createState: createStudioState,
});
const assetFiles = Object.fromEntries(
  (await listAssetFiles()).map(([path, file, type]) => [path, [file, type]]),
);
const agent = process.env.OPENAI_API_KEY
  ? createOpenAIAgent({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    })
  : createDemoAgent();
const server = createServer(async (req, res) => {
  const abort = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    const host = req.headers.host;
    if (
      !host ||
      !/^((localhost|127\.0\.0\.1)(:\d+)?|\[::1\](:\d+)?)$/.test(host)
    ) {
      res.writeHead(403);
      res.end("Invalid host");
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value !== undefined)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const request = new Request(`http://${host}${req.url}`, {
      method: req.method,
      headers,
      signal: abort.signal,
      ...(req.method === "GET" || req.method === "HEAD"
        ? {}
        : { body: req, duplex: "half" }),
    });
    const pathname = new URL(request.url).pathname;
    const path =
      pathname === "/"
        ? "/index.html"
        : pathname === "/lab" || pathname === "/lab/"
          ? "/lab/index.html"
          : pathname === "/support" || pathname === "/support/"
            ? "/support/index.html"
            : pathname;
    const assets = {};
    if (assetFiles[path]) {
      const [file, type] = assetFiles[path];
      let content = await readFile(resolve(root, file), "utf8");
      if (path === "/lab/index.html")
        content = content
          .replaceAll('href="/styles.css"', 'href="/lab/styles.css"')
          .replaceAll('src="/app.js"', 'src="/lab/app.js"')
          .replaceAll('href="/"', 'href="/lab"');
      assets[path] = { content, type };
    }
    const response = await createAppHandler({
      legacyStore: store,
      supportStore,
      studioStore,
      assets,
      token: process.env.VIEWHERD_TOKEN ?? process.env.WEBDR_TOKEN,
      agent,
    })(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    abort.signal.addEventListener(
      "abort",
      () => reader.cancel().catch(() => {}),
      { once: true },
    );
    try {
      while (!abort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value)))
          await new Promise((resolve) => {
            res.once("drain", resolve);
            res.once("close", resolve);
          });
      }
      if (!res.destroyed) res.end();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (abort.signal.aborted) return;
    if (!res.headersSent)
      res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { code: "server_error", message: error.message },
      }),
    );
  }
});
const port = Number(process.env.PORT ?? 4317);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Viewherd is ready at http://127.0.0.1:${port}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
