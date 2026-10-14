import {
  instructions,
  toolDefinitions,
  modelError,
  throwIfCancelled,
  byteLength,
} from "./openai-tools.mjs";

const maxResponseBytes = 256000;
const maxContextBytes = 128000;

async function readResponse(response, signal) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxResponseBytes) {
    await response.body?.cancel().catch(() => {});
    throw modelError("agent_response", "The model response was too large.");
  }
  if (!response.body)
    throw modelError("agent_response", "The model returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0,
    body = "";
  try {
    while (true) {
      throwIfCancelled(signal);
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes)
        throw modelError("agent_response", "The model response was too large.");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (signal?.aborted || error?.name === "AbortError")
      throw new DOMException(
        "The assistant request was cancelled.",
        "AbortError",
      );
    if (error?.code === "agent_response") throw error;
    throw modelError("agent_response", "The model response could not be read.");
  } finally {
    reader.releaseLock();
  }
}

export function createResponsesClient({
  apiKey,
  model = "gpt-4.1-mini",
  fetch: fetchImplementation = globalThis.fetch,
  baseUrl = "https://api.openai.com/v1/responses",
} = {}) {
  if (
    typeof apiKey !== "string" ||
    !apiKey.trim() ||
    apiKey.length > 1024 ||
    /[\r\n]/.test(apiKey)
  )
    throw new TypeError("A server-side OpenAI API key is required.");
  if (
    typeof model !== "string" ||
    !/^[A-Za-z0-9._:-]{1,120}$/.test(model) ||
    typeof fetchImplementation !== "function"
  )
    throw new TypeError("Configure a valid model and fetch implementation.");
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new TypeError("Configure a valid Responses API URL.");
  }
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    (endpoint.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
  )
    throw new TypeError("Configure a secure Responses API URL.");
  const redact = (value) => value.split(apiKey).join("[credential omitted]");

  return {
    model,
    redact,
    async create(input, signal) {
      const body = JSON.stringify({
        model,
        instructions: instructions,
        tools: toolDefinitions,
        tool_choice: "auto",
        parallel_tool_calls: false,
        max_output_tokens: 1200,
        stream: false,
        store: false,
        include: ["reasoning.encrypted_content"],
        input,
      });
      if (byteLength(body) > maxContextBytes)
        throw modelError(
          "agent_limit",
          "This assistant turn reached its context limit. Send a smaller request.",
        );
      let response;
      try {
        response = await fetchImplementation(endpoint.href, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal,
          redirect: "error",
        });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError")
          throw new DOMException(
            "The assistant request was cancelled.",
            "AbortError",
          );
        throw modelError(
          "agent_unavailable",
          "The model service could not be reached.",
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const code =
          response.status === 401 || response.status === 403
            ? "agent_credentials"
            : response.status === 429
              ? "agent_rate_limit"
              : "agent_unavailable";
        const explanation =
          code === "agent_credentials"
            ? "The model service rejected its server credentials."
            : code === "agent_rate_limit"
              ? "The model service is busy or its usage limit was reached."
              : "The model service could not complete the request.";
        throw modelError(code, explanation);
      }
      return readResponse(response, signal);
    },
  };
}
