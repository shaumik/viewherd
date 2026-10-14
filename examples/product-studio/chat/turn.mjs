import {
  createAgentTools,
  studioPaneId,
  throwIfAborted,
  writeConversation,
} from "./agent-tools.mjs";
import {
  encodeEvent,
  errorMessage,
  failure,
  isObject,
  streamHeaders,
} from "./http.mjs";
import { publicTurn } from "./projection.mjs";

/** Claim the saved turn before doing any model or network work. */
export async function prepareTurn({ client, principal, input, agent, state }) {
  const existing = (state.app?.chat?.turns || []).find(
    (turn) => turn.id === input.requestId,
  );
  if (existing) {
    if (
      existing.ownerId !== principal.id ||
      existing.message !== input.message
    ) {
      throw failure(
        "turn_conflict",
        "This requestId was already used for a different message.",
        409,
      );
    }
    if (existing.status !== "running") return { replay: existing };
    if (existing.expiresAt > Date.now()) {
      throw failure(
        "turn_in_progress",
        "This message is already running. Wait for it to finish.",
        409,
      );
    }
    const expired = await client.call(
      "panel.action",
      {
        paneId: studioPaneId(state),
        action: "finishTurn",
        args: {
          turnId: input.requestId,
          status: "failed",
          reply:
            existing.reply ||
            "This request expired. Send a new message to continue.",
        },
      },
      { requestId: `chat:${input.requestId}:expire` },
    );
    return { replay: expired.result.turn };
  }

  const start = await client.call(
    "panel.action",
    {
      paneId: studioPaneId(state),
      action: "beginTurn",
      args: {
        turnId: input.requestId,
        message: input.message,
        mode: agent.mode,
        expiresAt: Date.now() + 120000,
      },
    },
    { requestId: `chat:${input.requestId}:begin` },
  );
  const turn = start.result?.turn;
  if (!turn)
    throw failure("invalid_response", "The studio did not start this request.");
  if (start.result.replayed) {
    if (turn.status === "running") {
      throw failure(
        "turn_in_progress",
        "This message is already running. Wait for it to finish.",
        409,
      );
    }
    return { replay: turn };
  }

  const history = (start.state.app?.chat?.turns || [])
    .filter((item) => item.id !== turn.id && item.status !== "running")
    .slice(-12)
    .map(publicTurn);
  return { history, initialRevision: start.revision };
}

/** Stream a single agent run; disconnects abort the agent and release its lease. */
export function streamTurn({
  request,
  client,
  agent,
  input,
  history,
  initialRevision,
}) {
  const aborter = new AbortController();
  let controller;
  let closed = false;
  let timer;
  let replyText = "";

  function stop(reason) {
    if (!aborter.signal.aborted) {
      aborter.abort(
        reason ||
          failure("assistant_cancelled", "The request was interrupted."),
      );
    }
  }

  function disconnect() {
    stop(failure("assistant_cancelled", "The request was interrupted."));
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {}
  }

  function send(event) {
    if (closed) return;
    try {
      controller.enqueue(encodeEvent(event));
    } catch {
      closed = true;
      disconnect();
    }
  }

  function emit(event) {
    throwIfAborted(aborter.signal);
    if (
      !isObject(event) ||
      event.type !== "text" ||
      typeof event.text !== "string"
    ) {
      throw failure(
        "invalid_reply",
        "The assistant returned an invalid message.",
      );
    }
    if (replyText.length + event.text.length > 4000) {
      throw failure("invalid_reply", "The assistant reply was too long.");
    }
    replyText += event.text;
    if (event.text) send({ type: "text", text: event.text });
  }

  const tools = createAgentTools({
    client,
    turnId: input.requestId,
    initialRevision,
    signal: aborter.signal,
    send,
    getReply: () => replyText,
  });

  async function finish(status, reply) {
    // Finish metadata even after a disconnect. Completed tool proofs survive
    // failed transcript writes and the next chat message can start safely.
    const result = await writeConversation(
      client,
      input.requestId,
      "finishTurn",
      { status, reply, steps: tools.steps() },
      `finish:${status}`,
    );
    const turn = result.result?.turn;
    if (turn) send({ type: "done", turn: publicTurn(turn) });
  }

  async function run() {
    const cancelled = new Promise((_, reject) => {
      if (aborter.signal.aborted) return reject(aborter.signal.reason);
      aborter.signal.addEventListener(
        "abort",
        () => reject(aborter.signal.reason),
        { once: true },
      );
    });
    try {
      throwIfAborted(aborter.signal);
      const reply = await Promise.race([
        Promise.resolve().then(() =>
          agent.run({
            message: input.message,
            history,
            snapshot: tools.snapshot,
            call: tools.call,
            emit,
            signal: aborter.signal,
          }),
        ),
        cancelled,
      ]);
      throwIfAborted(aborter.signal);
      if (typeof reply !== "string" || !reply.trim() || reply.length > 4000) {
        throw failure(
          "invalid_reply",
          "The assistant returned an invalid reply.",
        );
      }
      if (!replyText) emit({ type: "text", text: reply });
      else if (reply.startsWith(replyText) && reply.length > replyText.length) {
        emit({ type: "text", text: reply.slice(replyText.length) });
      }
      await finish("completed", reply);
    } catch (error) {
      const message = errorMessage(error);
      const reply = replyText
        ? `${replyText.slice(0, 3300)}\n\n${message}`
        : message;
      let finalTurn;
      try {
        finalTurn = (
          await writeConversation(
            client,
            input.requestId,
            "finishTurn",
            { status: "failed", reply, steps: tools.steps() },
            "finish:failed",
          )
        ).result?.turn;
      } catch {}
      send({ type: "error", message });
      if (finalTurn) send({ type: "done", turn: publicTurn(finalTurn) });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", disconnect);
      stop(failure("assistant_cancelled", "This request has finished."));
      client.destroy?.();
      close();
    }
  }

  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
      request.signal.addEventListener("abort", disconnect, { once: true });
      if (request.signal.aborted) disconnect();
      timer = setTimeout(
        () => stop(failure("assistant_timeout", "The request took too long.")),
        60000,
      );
      send({ type: "start", turnId: input.requestId, mode: agent.mode });
      // The handler returns immediately; run catches agent and persistence errors.
      void run().catch(close);
    },
    cancel() {
      closed = true;
      disconnect();
    },
  });
  return new Response(body, { headers: streamHeaders });
}
