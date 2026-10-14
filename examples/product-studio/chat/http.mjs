import { publicTurn } from "./projection.mjs";

export const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const failure = (code, message, status = 400) =>
  Object.assign(new Error(message), { code, status });
export const jsonResponse = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
export const streamHeaders = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const encoder = new TextEncoder();
export const encodeEvent = (event) =>
  encoder.encode(JSON.stringify(event) + "\n");

export function errorMessage(error) {
  if (error?.code === "revision_conflict")
    return "The design changed while I was working. Your newer edit is safe. Send the request again to continue.";
  if (error?.code === "agent_cancelled")
    return "This request was cancelled because the studio changed. Send a new message to continue.";
  if (error?.code === "assistant_timeout")
    return "This request took too long. The changes already completed are saved.";
  if (error?.name === "AbortError" || error?.code === "assistant_cancelled")
    return "This request was interrupted. The changes already completed are saved.";
  if (error?.code === "agent_credentials")
    return "The model connection is not configured. Ask the app owner to check the server settings.";
  if (error?.code === "agent_rate_limit")
    return "The model is busy. Try again in a moment; completed changes are saved.";
  if (
    ["agent_unavailable", "agent_response", "agent_limit"].includes(error?.code)
  )
    return "The model could not finish this request. The changes already completed are saved.";
  if (
    typeof error?.message === "string" &&
    [
      "schema_validation",
      "design_not_found",
      "last_design",
      "turn_in_progress",
      "turn_conflict",
      "unsupported_action",
      "tool_limit",
      "invalid_reply",
    ].includes(error.code)
  )
    return error.message.slice(0, 600);
  return "I could not finish this request. The changes already completed are saved.";
}

export function errorStatus(error) {
  if (
    [
      "turn_in_progress",
      "turn_conflict",
      "request_conflict",
      "revision_conflict",
      "agent_cancelled",
    ].includes(error?.code)
  )
    return 409;
  if (error?.code === "unauthorized") return 401;
  if (["forbidden", "agent_forbidden"].includes(error?.code)) return 403;
  if (
    Number.isInteger(error?.status) &&
    error.status >= 400 &&
    error.status <= 599
  )
    return error.status;
  return 400;
}

export function checkOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw failure("forbidden", "Use the assistant from this app.", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw failure("forbidden", "Use the assistant from this app.", 403);
}

export async function readMessage(request) {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw failure("content_type", "Send a JSON message.", 415);
  if (Number(request.headers.get("content-length") || 0) > 12000)
    throw failure(
      "body_too_large",
      "Keep the message under 2,000 characters.",
      413,
    );
  if (!request.body) throw failure("invalid_message", "Write a message first.");
  const reader = request.body.getReader();
  const abortRead = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener("abort", abortRead, { once: true });
  let bytes = 0,
    chunks = [];
  try {
    while (true) {
      if (request.signal.aborted)
        throw failure("assistant_cancelled", "The request was cancelled.");
      const { value, done } = await reader.read();
      if (request.signal.aborted)
        throw failure("assistant_cancelled", "The request was cancelled.");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 12000)
        throw failure(
          "body_too_large",
          "Keep the message under 2,000 characters.",
          413,
        );
      chunks.push(value);
    }
  } finally {
    request.signal.removeEventListener("abort", abortRead);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw failure("invalid_json", "Send a valid JSON message.");
  }
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => !["requestId", "message"].includes(key))
  )
    throw failure("invalid_message", "Send only requestId and message.");
  if (
    typeof value.requestId !== "string" ||
    !value.requestId.trim() ||
    value.requestId.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(value.requestId)
  )
    throw failure("invalid_message", "Supply a requestId of 1–80 characters.");
  if (
    typeof value.message !== "string" ||
    !value.message.trim() ||
    value.message.length > 2000 ||
    /[\u0000\u000b\u000c\u007f]/.test(value.message)
  )
    throw failure("invalid_message", "Write a message of 1–2,000 characters.");
  return { requestId: value.requestId, message: value.message.trim() };
}
export function replayTurn(turn, mode) {
  const events = [{ type: "start", turnId: turn.id, mode, replayed: true }];
  if (turn.reply) events.push({ type: "text", text: turn.reply });
  for (const step of turn.steps || []) events.push({ type: "tool", step });
  events.push({ type: "done", turn: publicTurn(turn) });
  return new Response(
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    {
      headers: streamHeaders,
    },
  );
}

export function errorResponse(error) {
  const publicCodes = [
    "forbidden",
    "unauthorized",
    "agent_forbidden",
    "content_type",
    "body_too_large",
    "invalid_message",
    "invalid_json",
    "assistant_cancelled",
    "turn_conflict",
    "turn_in_progress",
    "request_conflict",
    "revision_conflict",
    "agent_cancelled",
  ];
  const safe = publicCodes.includes(error?.code);
  return jsonResponse(
    {
      error: {
        code: safe ? error.code : "assistant_error",
        message:
          safe && typeof error?.message === "string"
            ? error.message.slice(0, 600)
            : "The assistant is unavailable.",
      },
    },
    errorStatus(error),
  );
}
