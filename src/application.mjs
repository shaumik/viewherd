import { handleRequest } from "./http.mjs";
import { createRegistry } from "@viewherd/core";
import { createViewherdHandler } from "@viewherd/server";
import { supportPanels } from "../examples/support-desk/domain.mjs";
import { createStudioApp } from "../examples/product-studio/server.mjs";
import { createDemoAgent } from "../examples/product-studio/chat/agents/demo.mjs";

const appSupportRegistry = createRegistry(supportPanels);

function appHasToken(request, token) {
  if (!token) return true;
  if (request.headers.get("authorization") === `Bearer ${token}`) return true;
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .some(
        (part) => part.trim() === `webdr_token=${encodeURIComponent(token)}`,
      ) === true
  );
}

/** Reference-app routing. Real applications supply their own authorization adapter. */
export function createAppHandler({
  legacyStore,
  supportStore,
  studioStore,
  assets,
  token,
  agent = createDemoAgent(),
  serviceProtected = false,
}) {
  async function authorize(request, room, sessionId = room) {
    if (sessionId && sessionId !== room)
      throw Object.assign(
        new Error("This example only exposes its own session."),
        { code: "forbidden", status: 403 },
      );
    if (!appHasToken(request, token))
      throw Object.assign(new Error("Supply this server’s access token."), {
        code: "unauthorized",
        status: 401,
      });
    const userId = serviceProtected
      ? request.headers.get("oai-authenticated-user-id")
      : null;
    return {
      id: userId || (serviceProtected ? "private-site-service" : "local-user"),
      actor: userId ? "human/ui" : "reference-app",
      name: "Studio user",
      roles: ["owner"],
    };
  }
  const makeHandler = (registry, store, room, basePath, mcpPath) =>
    createViewherdHandler({
      registry,
      store,
      sessionId: room,
      basePath,
      mcpPath,
      trustedMcpOrigin: serviceProtected,
      authorize: async (request, { sessionId }) => {
        // This hosted reference app is owner-private. Dispatch authenticates visitors
        // and service callers. It exposes one shared, fictional demo room.
        // Applications replace this adapter with their membership/permission checks.
        return authorize(request, room, sessionId);
      },
    });
  const supportHandler = makeHandler(
    appSupportRegistry,
    supportStore,
    "support-desk",
    "/webdr",
    "/support/mcp",
  );
  const studioHandler = createStudioApp({
    store: studioStore,
    serviceProtected,
    agent,
    authorize: (request, { sessionId }) =>
      authorize(request, "product-studio", sessionId),
  });
  return async (request) => {
    const url = new URL(request.url);
    const studioResponse = await studioHandler(request);
    if (studioResponse) return studioResponse;
    if (
      url.pathname === "/support/mcp" ||
      url.pathname === "/webdr" ||
      url.pathname.startsWith("/webdr/")
    )
      return supportHandler(request);
    if (url.pathname === "/support" || url.pathname === "/support/") {
      url.pathname = "/support/index.html";
      return handleRequest(new Request(url, request), {
        store: legacyStore,
        assets,
        token,
        serviceProtected,
      });
    }
    if (url.pathname === "/lab/mcp") {
      url.pathname = "/mcp";
      return handleRequest(new Request(url, request), {
        store: legacyStore,
        assets,
        token,
        serviceProtected,
      });
    }
    if (url.pathname === "/lab" || url.pathname === "/lab/") {
      url.pathname = "/lab/index.html";
      return handleRequest(new Request(url, request), {
        store: legacyStore,
        assets,
        token,
        serviceProtected,
      });
    }
    return handleRequest(request, {
      store: legacyStore,
      assets,
      token,
      serviceProtected,
    });
  };
}
