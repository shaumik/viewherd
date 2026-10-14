export async function getAgentInfo(signal) {
  const response = await fetch("/assistant", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("Agent connection unavailable.");
  return response.json();
}

export async function sendMessage({ requestId, message, signal, onEvent }) {
  const response = await fetch("/assistant", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      accept: "application/x-ndjson",
    },
    body: JSON.stringify({ requestId, message }),
    signal,
  });

  if (!response.ok) {
    let detail;
    try {
      detail = await response.json();
    } catch {}
    throw new Error(
      detail?.error?.message ||
        detail?.message ||
        `The assistant could not start (${response.status}). Try again.`,
    );
  }
  await readChatStream(response, onEvent);
}

// Text and tool progress are transient. The workspace snapshot remains authoritative.
export function applyTurnEvent(turn, event) {
  switch (event.type) {
    case "start":
      if (typeof event.turnId !== "string" || !event.turnId) {
        throw new Error("The assistant returned an invalid turn.");
      }
      return { ...turn, id: event.turnId, mode: event.mode };
    case "text":
      if (
        typeof event.text !== "string" ||
        turn.reply.length + event.text.length > 20000
      ) {
        throw new Error("The assistant response was too large.");
      }
      return { ...turn, reply: turn.reply + event.text };
    case "tool": {
      const step = event.step;
      if (
        !step ||
        typeof step.id !== "string" ||
        typeof step.label !== "string" ||
        !["running", "done", "failed"].includes(step.status)
      ) {
        throw new Error("The assistant returned an invalid tool result.");
      }
      const index = turn.steps.findIndex((item) => item.id === step.id);
      const steps = [...turn.steps];
      if (index >= 0) steps[index] = step;
      else {
        if (steps.length >= 12)
          throw new Error("The assistant returned too many tool steps.");
        steps.push(step);
      }
      return { ...turn, steps };
    }
    case "done":
      if (
        !event.turn ||
        event.turn.id !== turn.id ||
        !["completed", "failed"].includes(event.turn.status)
      ) {
        throw new Error("The assistant returned an invalid completion.");
      }
      return event.turn;
    case "error":
      return turn;
    default:
      throw new Error("The assistant returned an unknown event.");
  }
}

export async function readChatStream(response, onEvent) {
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("application/x-ndjson")
  )
    throw new Error("The assistant returned an invalid stream. Try again.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let received = 0;
  let complete = false;
  function line(value) {
    const text = value.trim();
    if (!text) return false;
    if (text.length > 131072)
      throw new Error(
        "The assistant response was too large. Try a shorter request.",
      );
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      throw new Error(
        "The assistant response was interrupted. Your workspace is safe.",
      );
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string")
      throw new Error("The assistant returned an invalid event.");
    onEvent(event);
    return event.type === "done";
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        received += value.byteLength;
        if (received > 2097152)
          throw new Error("The assistant response was too large.");
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const value = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line(value)) {
          complete = true;
          return;
        }
      }
      if (buffer.length > 131072)
        throw new Error("The assistant response was too large.");
      if (done) {
        if (buffer.trim()) complete = line(buffer);
        if (!complete)
          throw new Error(
            "The assistant disconnected before finishing. Your workspace is safe.",
          );
        return;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
}
