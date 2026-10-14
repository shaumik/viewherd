import {
  checkOrigin,
  errorResponse,
  failure,
  jsonResponse,
  readMessage,
  replayTurn,
} from "./http.mjs";
import { prepareTurn, streamTurn } from "./turn.mjs";

/**
 * Connect an authenticated SDK client to a backend agent adapter.
 * GET describes the connection. POST runs one saved, streamed conversation turn.
 */
export function createStudioAssistantHandler({ clientFor, agent }) {
  if (
    typeof clientFor !== "function" ||
    typeof agent?.run !== "function" ||
    !["demo", "openai"].includes(agent.mode)
  ) {
    throw new TypeError(
      "Supply an authenticated SDK client factory and an agent adapter.",
    );
  }

  return async function handleChat(request) {
    let client;
    try {
      checkOrigin(request);
      if (!["GET", "POST"].includes(request.method)) {
        return jsonResponse(
          {
            error: { code: "method_not_allowed", message: "Use GET or POST." },
          },
          405,
          { allow: "GET, POST" },
        );
      }

      const input =
        request.method === "POST" ? await readMessage(request) : undefined;
      const authenticated = await clientFor(request, {
        turnId: input?.requestId,
      });
      client = authenticated.client;
      const principal = authenticated.principal;
      if (
        !client ||
        typeof client.snapshot !== "function" ||
        typeof client.call !== "function" ||
        typeof principal?.id !== "string" ||
        !principal.id
      ) {
        throw failure(
          "forbidden",
          "An authenticated studio user is required.",
          403,
        );
      }

      // This read also checks access before reporting the configured agent mode.
      const state = await client.snapshot();
      if (request.method === "GET") {
        client.destroy?.();
        return jsonResponse({
          mode: agent.mode,
          ...(agent.model ? { model: agent.model } : {}),
          streaming: true,
        });
      }
      if (request.signal.aborted)
        throw failure("assistant_cancelled", "The request was cancelled.");

      const turn = await prepareTurn({
        client,
        principal,
        input,
        agent,
        state,
      });
      if (turn.replay) {
        client.destroy?.();
        return replayTurn(turn.replay, turn.replay.mode);
      }
      return streamTurn({ request, client, agent, input, ...turn });
    } catch (error) {
      client?.destroy?.();
      return errorResponse(error);
    }
  };
}
