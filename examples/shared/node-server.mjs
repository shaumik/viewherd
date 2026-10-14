import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const contentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

// Keep Node hosting outside the examples' SDK setup. Only browser files are served.
async function browserFiles(root) {
  const files = new Map();
  const prefix = "/" + relative(repositoryRoot, root).split("\\").join("/");

  function add(path, file, type) {
    files.set(path, { file, type });
    files.set(prefix + path, { file, type });
  }

  for (const name of [
    "index.html",
    "styles.css",
    "client.js",
    "app.js",
    "render.mjs",
  ]) {
    const type = name.endsWith(".html")
      ? "text/html"
      : name.endsWith(".css")
        ? "text/css"
        : "text/javascript";
    add("/" + name, resolve(root, name), type + "; charset=utf-8");
  }

  async function addModules(directory, route) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const file = resolve(directory, entry.name);
      const path = route + "/" + entry.name;
      if (entry.isDirectory()) await addModules(file, path);
      else if (entry.isFile() && entry.name.endsWith(".js"))
        add(path, file, "text/javascript; charset=utf-8");
    }
  }

  await addModules(resolve(root, "client"), "/client");
  for (const [path, file, type] of [
    ["/sdk/client/index.mjs", "packages/client/index.mjs", "text/javascript"],
    ["/sdk/dom/index.mjs", "packages/dom/index.mjs", "text/javascript"],
    ["/sdk/dom/styles.css", "packages/dom/styles.css", "text/css"],
  ])
    files.set(path, {
      file: resolve(repositoryRoot, file),
      type: type + "; charset=utf-8",
    });
  return files;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 300000)
      throw Object.assign(new Error("Request body is too large."), {
        status: 413,
      });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function sendResponse(response, output, signal) {
  output.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    output.end();
    return;
  }
  const reader = response.body.getReader();
  const cancel = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!output.write(Buffer.from(value))) {
        await new Promise((resolve) => {
          const resume = () => {
            output.off("drain", resume);
            output.off("close", resume);
            resolve();
          };
          output.once("drain", resume);
          output.once("close", resume);
        });
      }
    }
    if (!output.destroyed) output.end();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Start a localhost Fetch handler with browser assets and streaming responses. */
export function startExampleServer({ handler, root, port }) {
  root = root instanceof URL ? fileURLToPath(root) : resolve(root);
  const filesReady = browserFiles(root);
  const server = createServer(async (input, output) => {
    const abort = new AbortController();
    output.once("close", () => {
      if (!output.writableEnded) abort.abort();
    });
    try {
      const host = input.headers.host;
      if (
        !host ||
        !/^((localhost|127\.0\.0\.1)(:\d+)?|\[::1\](:\d+)?)$/.test(host)
      ) {
        output.writeHead(403);
        output.end("Invalid host");
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(input.headers)) {
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      }
      const method = input.method;
      const body =
        method === "GET" || method === "HEAD"
          ? undefined
          : await readBody(input);
      const request = new Request(`http://${host}${input.url}`, {
        method,
        headers,
        body,
        signal: abort.signal,
      });
      let response = await handler(request);
      if (!response) {
        const path = new URL(request.url).pathname;
        const asset = (await filesReady).get(
          path === "/" ? "/index.html" : path,
        );
        if (asset && ["GET", "HEAD"].includes(method)) {
          const content = await readFile(asset.file);
          response = new Response(method === "HEAD" ? null : content, {
            headers: {
              "content-type": asset.type,
              "content-security-policy": contentSecurityPolicy,
              "x-content-type-options": "nosniff",
            },
          });
        } else
          response = Response.json({ error: "Not found." }, { status: 404 });
      }
      await sendResponse(response, output, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (output.headersSent) {
        output.destroy();
        return;
      }
      const status = error.code === "ENOENT" ? 404 : (error.status ?? 500);
      output.writeHead(status, { "content-type": "application/json" });
      output.end(
        JSON.stringify({
          error: status === 500 ? "Server error." : error.message,
        }),
      );
    }
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Viewherd is ready at http://127.0.0.1:${server.address().port}`,
    ),
  );
  const shutdown = () => server.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.once("close", () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  });
  return server;
}
