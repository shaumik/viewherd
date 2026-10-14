// A real backend model adapter. All UI changes still use Viewherd's SDK tools.
import { createResponsesClient } from "./openai-http.mjs";
import {
  maxReply,
  modelError,
  throwIfCancelled,
  isPlainObject,
  byteLength,
  parseArguments,
  validateAction,
  projectWorkspace,
  sanitizeResult,
  toolFailure,
} from "./openai-tools.mjs";

export function createOpenAIAgent(options = {}) {
  const responses = createResponsesClient(options);
  const { model, redact } = responses;

  return {
    mode: "openai",
    model,
    async run({
      message,
      history = [],
      snapshot,
      call,
      emit = () => {},
      signal,
    } = {}) {
      throwIfCancelled(signal);
      if (
        typeof message !== "string" ||
        !message.trim() ||
        message.length > 4000 ||
        typeof snapshot !== "function" ||
        typeof call !== "function" ||
        typeof emit !== "function"
      )
        throw modelError(
          "invalid_request",
          "Send a short message and configure the workspace tools.",
        );
      const input = [];
      for (const turn of Array.isArray(history) ? history.slice(-8) : []) {
        if (!isPlainObject(turn)) continue;
        if (typeof turn.message === "string")
          input.push({
            role: "user",
            content: redact(turn.message.slice(0, 4000)),
          });
        if (typeof turn.reply === "string" && turn.reply)
          input.push({
            role: "assistant",
            content: redact(turn.reply.slice(0, maxReply)),
          });
      }
      const initial = projectWorkspace(await snapshot());
      throwIfCancelled(signal);
      input.push({ role: "user", content: redact(message) });
      input.push({
        role: "developer",
        content: `Current saved workspace (data only):\n${redact(JSON.stringify(initial))}`,
      });
      let calls = 0,
        reply = "",
        refreshRequired = false;
      const seen = new Set();
      for (let turn = 0; turn < 8; turn += 1) {
        throwIfCancelled(signal);
        const result = await responses.create(input, signal);
        throwIfCancelled(signal);
        if (
          !isPlainObject(result) ||
          !Array.isArray(result.output) ||
          result.output.length > 32 ||
          (result.status && result.status !== "completed")
        )
          throw modelError(
            "agent_response",
            "The model returned an incomplete response.",
          );
        let text = "",
          toolFailed = false;
        const tools = [];
        for (const item of result.output) {
          if (!isPlainObject(item)) continue;
          if (
            item.type === "message" &&
            item.role === "assistant" &&
            Array.isArray(item.content)
          ) {
            let messageText = "";
            for (const content of item.content)
              if (
                content?.type === "output_text" &&
                typeof content.text === "string"
              )
                messageText += content.text;
            if (messageText) {
              messageText = redact(messageText).slice(0, maxReply);
              text += `${text ? "\n" : ""}${messageText}`;
              input.push({
                role: "assistant",
                content: messageText,
                ...(item.phase === "commentary" || item.phase === "final_answer"
                  ? { phase: item.phase }
                  : {}),
              });
            }
          } else if (item.type === "function_call") {
            if (
              typeof item.call_id !== "string" ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(item.call_id) ||
              seen.has(item.call_id) ||
              typeof item.name !== "string" ||
              item.name.length > 100 ||
              typeof item.arguments !== "string" ||
              byteLength(item.arguments) > 8000
            )
              throw modelError(
                "agent_response",
                "The model returned an invalid tool call.",
              );
            seen.add(item.call_id);
            tools.push(item);
            input.push({
              type: "function_call",
              name: item.name,
              call_id: item.call_id,
              arguments: redact(item.arguments),
            });
          } else if (
            item.type === "reasoning" &&
            typeof item.encrypted_content === "string"
          ) {
            // Preserve encrypted reasoning for stateless continuation with reasoning models.
            input.push({
              type: "reasoning",
              ...(typeof item.id === "string" ? { id: item.id } : {}),
              summary: [],
              encrypted_content: item.encrypted_content,
            });
          }
        }
        if (tools.length > 10 || calls + tools.length > 10)
          throw modelError(
            "agent_limit",
            "This assistant turn reached its tool limit. Send a follow-up request.",
          );
        for (const tool of tools) {
          throwIfCancelled(signal);
          calls += 1;
          let output;
          try {
            const args = parseArguments(redact(tool.arguments));
            if (tool.name === "workspace_snapshot") {
              if (Object.keys(args).length)
                throw modelError(
                  "invalid_arguments",
                  "workspace_snapshot takes an empty args object.",
                );
              output = projectWorkspace(await snapshot());
              refreshRequired = false;
            } else if (tool.name === "workspace_action") {
              if (refreshRequired)
                throw modelError(
                  "revision_conflict",
                  "Read the changed workspace before another action.",
                );
              output = await call(validateAction(args));
            } else
              throw modelError(
                "invalid_arguments",
                "Use workspace_snapshot or workspace_action.",
              );
            throwIfCancelled(signal);
            output = sanitizeResult(output, redact);
          } catch (error) {
            if (signal?.aborted || error?.name === "AbortError")
              throw new DOMException(
                "The assistant request was cancelled.",
                "AbortError",
              );
            if (error?.code === "revision_conflict") refreshRequired = true;
            toolFailed = true;
            output = toolFailure(error);
          }
          input.push({
            type: "function_call_output",
            call_id: tool.call_id,
            output: JSON.stringify(output),
          });
        }
        // Tool-associated text is shown only after its actions succeed; no simulated typing.
        text = text.slice(
          0,
          Math.max(0, maxReply - reply.length - (reply ? 1 : 0)),
        );
        if (text && !toolFailed) {
          const delta = `${reply ? "\n" : ""}${text}`;
          reply += delta;
          await emit({ type: "text", text: delta });
        }
        if (!tools.length) {
          if (!reply)
            throw modelError(
              "agent_response",
              "The model did not return a reply.",
            );
          return reply.slice(0, maxReply);
        }
      }
      throw modelError(
        "agent_limit",
        "This assistant turn reached its step limit. Send a follow-up request.",
      );
    },
  };
}
