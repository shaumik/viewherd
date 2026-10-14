import { createRegistry } from "@viewherd/core";
import { createController, createViewherdHandler } from "@viewherd/server";
import { studioPanels } from "./panels.mjs";
import { createStudioAssistantHandler } from "./chat/handler.mjs";
import { createDemoAgent } from "./chat/agents/demo.mjs";

/** The host supplies storage and authentication. The SDK owns workspace changes. */
export function createStudioApp({
  store,
  authorize,
  agent = createDemoAgent(),
  serviceProtected = false,
}) {
  const sessionId = "product-studio";
  const registry = createRegistry(studioPanels);
  if (typeof authorize !== "function")
    throw new TypeError("Supply your app authentication function.");

  async function authorizeStudio(request, command) {
    if (command.sessionId !== sessionId) {
      throw Object.assign(
        new Error("This example only exposes its own session."),
        { code: "forbidden", status: 403 },
      );
    }
    return authorize(request, command);
  }

  const handleWorkspace = createViewherdHandler({
    registry,
    store,
    sessionId,
    authorize: authorizeStudio,
    trustedMcpOrigin: serviceProtected,
  });

  const handleChat = createStudioAssistantHandler({
    agent,
    async clientFor(request, { turnId }) {
      const user = await authorizeStudio(request, {
        sessionId,
        method: "assistant.chat",
        params: {},
      });
      if (!user)
        throw Object.assign(new Error("Sign in first."), {
          code: "unauthorized",
          status: 401,
        });
      const principal = {
        ...user,
        actor: "agent:studio",
        roles: [...(user.roles ?? []), "studio-agent"],
        ...(turnId ? { turnId } : {}),
      };
      const client = createController({
        registry,
        store,
        sessionId,
        // Only this backend assigns the agent role, turn lease, and clock.
        principal: () => ({ ...principal, serverTime: Date.now() }),
      });
      return { client, principal };
    },
  });

  return async function handleStudio(request) {
    const path = new URL(request.url).pathname;
    if (path === "/assistant") return handleChat(request);
    if (
      path === "/mcp" ||
      path === "/viewherd" ||
      path.startsWith("/viewherd/")
    )
      return handleWorkspace(request);
    return null;
  };
}
