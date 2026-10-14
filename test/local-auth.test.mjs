import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createMemoryStore } from "@viewherd/server";
import { createLocalAuth } from "../examples/shared/local-auth.mjs";
import { createStudioApp } from "../examples/product-studio/server.mjs";
import { createStudioState } from "../examples/product-studio/studio/state.mjs";

globalThis.crypto ??= webcrypto;

function request(path, { body, headers = {}, method } = {}) {
  return new Request(`http://localhost:4317${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

test("unprotected localhost examples retain their one-user authentication", async () => {
  const auth = createLocalAuth();
  assert.equal(auth.authorize(request("/")).id, "local-user");
  assert.equal(await auth.handleLogin(request("/")), null);
  assert.equal(
    await auth.handleLogin(request("/api/auth", { body: "token=unused" })),
    null,
  );
});

test("token login grants the same browser cookie access as authenticated SDK requests", async () => {
  const token = "a local token; with spaces";
  const auth = createLocalAuth({ token });
  const handleStudio = createStudioApp({
    authorize: auth.authorize,
    store: createMemoryStore({ createState: createStudioState }),
  });
  const handler = async (input) =>
    (await auth.handleLogin(input)) ?? handleStudio(input);

  const signIn = await handler(request("/"));
  assert.equal(signIn.status, 200);
  assert.match(await signIn.text(), /action="\/api\/auth"/);
  assert.equal(signIn.headers.get("cache-control"), "no-store");
  assert.equal((await handler(request("/viewherd/snapshot"))).status, 401);

  const login = await handler(
    request("/api/auth", {
      body: new URLSearchParams({ token }).toString(),
      headers: {
        origin: "http://localhost:4317",
        "content-type": "application/x-www-form-urlencoded",
      },
    }),
  );
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/");
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /; Path=\/; HttpOnly; SameSite=Strict$/);
  const cookieHeader = cookie.split(";")[0];
  assert.equal(
    await auth.handleLogin(request("/", { headers: { cookie: cookieHeader } })),
    null,
  );
  const snapshot = await handler(
    request("/viewherd/snapshot", { headers: { cookie: cookieHeader } }),
  );
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).sessionId, "product-studio");
  const chat = await handler(
    request("/assistant", { headers: { cookie: cookieHeader } }),
  );
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).mode, "demo");
  assert.equal(
    (
      await handler(
        request("/viewherd/schema", {
          headers: { authorization: `Bearer ${token}` },
        }),
      )
    ).status,
    200,
  );
});

test("local login rejects foreign origins, bad tokens and invalid or oversized bodies", async () => {
  const auth = createLocalAuth({ token: "local-secret" });
  assert.equal(
    (
      await auth.handleLogin(
        request("/api/auth", {
          body: "token=local-secret",
          headers: { origin: "https://other.test" },
        }),
      )
    ).status,
    403,
  );
  for (const [body, status] of [
    ["token=wrong", 401],
    ["token=" + "x".repeat(2048), 413],
    [new Uint8Array([0xff]), 400],
  ]) {
    const response = await auth.handleLogin(request("/api/auth", { body }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  const wrongMethod = await auth.handleLogin(request("/api/auth"));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal(auth.authorize(request("/")), null);
});
