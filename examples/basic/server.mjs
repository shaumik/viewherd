import { pathToFileURL } from "node:url";
import { createRegistry, createSession } from "@viewherd/core";
import {
  createController,
  createMemoryStore,
  createViewherdHandler,
} from "@viewherd/server";
import { startExampleServer } from "../shared/node-server.mjs";
import { notePanel } from "./panels.mjs";

const json = (body, status = 200) => Response.json(body, { status });

export function createBasicHandler() {
  const sessionId = "basic";
  const registry = createRegistry([notePanel]);
  const store = createMemoryStore({
    createState: (id) =>
      createSession({
        id,
        view: "note",
        title: "Workspace note",
        data: {
          text: "Chat opens and changes notes. You can edit them here, too.",
        },
        registry,
      }),
  });
  // This localhost demo has one user. Replace this with your app's authentication.
  const authorize = () => ({ id: "local-demo-user" });
  const handleUI = createViewherdHandler({
    registry,
    store,
    authorize,
    sessionId,
  });

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/viewherd/") || url.pathname === "/mcp")
      return handleUI(request);
    if (url.pathname !== "/assistant") return null;
    if (request.method !== "POST")
      return json({ error: "Use POST for demo commands." }, 405);
    if (
      request.headers.has("origin") &&
      request.headers.get("origin") !== url.origin
    )
      return json({ error: "Use the same origin." }, 403);

    try {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 2048)
        return json({ error: "Keep the request under 2 KB." }, 413);
      const { message, requestId, expectedRevision } =
        JSON.parse(new TextDecoder().decode(bytes)) ?? {};
      if (
        typeof message !== "string" ||
        message.length > 1100 ||
        typeof requestId !== "string" ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(requestId) ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0
      ) {
        return json(
          { error: "Send message, requestId and expectedRevision." },
          400,
        );
      }

      // Authenticate before creating an agent's session-bound SDK controller.
      const principal = await authorize(request);
      if (!principal) return json({ error: "Sign in first." }, 401);
      const controller = createController({
        registry,
        store,
        sessionId,
        principal,
      });
      const state = await controller.snapshot();
      const note = Object.values(state.panes)
        .filter((pane) => pane.view === "note")
        .at(-1);
      const edit = /^Update the note to "([\s\S]*)"$/i.exec(message.trim());
      let method = "panel.action";
      let params;
      let reply;
      if (/^Open a note$/i.test(message.trim())) {
        params = { paneId: "pane_inbox", action: "open", args: {} };
        reply = "Opened a note beside your workspace note.";
      } else if (edit) {
        params = { paneId: note.id, action: "update", args: { text: edit[1] } };
        reply = "Updated the note.";
      } else if (
        /^Close the note$/i.test(message.trim()) &&
        note.id !== "pane_inbox"
      ) {
        method = "pane.close";
        params = { paneId: note.id };
        reply = "Closed the note. Your workspace note is still here.";
      } else {
        return json(
          {
            error:
              'Try: Open a note, Update the note to "Hello", or Close the note.',
          },
          400,
        );
      }
      const result = await controller.call(method, params, {
        requestId,
        expectedRevision,
      });
      return json({ reply, revision: result.revision });
    } catch (error) {
      return json(
        {
          error:
            error instanceof SyntaxError ? "Send valid JSON." : error.message,
        },
        error.status ?? 400,
      );
    }
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startExampleServer({
    handler: createBasicHandler(),
    root: new URL(".", import.meta.url),
    port: 4318,
  });
}
