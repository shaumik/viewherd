# Connect an agent

Viewherd lets a backend agent control the same workspace a person sees. The browser renders registered panels; it does not run the model or hold its API key.

In the product studio, a chat message goes to the host backend. The backend agent reads the current workspace, chooses an allowed action, and sends a Viewherd command. The SDK validates the action and saves the updated workspace. A live event stream tells the browser to render the change. Chat shows the actual actions as they run.

The example works without a key using a clearly labeled local demo agent. To use a real OpenAI model locally, set server environment variables before starting it:

```sh
export OPENAI_API_KEY='your-api-key'
export OPENAI_MODEL='gpt-4.1-mini'
npm run example
```

`OPENAI_MODEL` is optional. The [OpenAI adapter](../examples/product-studio/chat/agents/openai.mjs) lives in the example, outside the SDK. It uses the [Responses function calling API](https://developers.openai.com/api/docs/guides/function-calling) and sends a small workspace description, without product photo bytes. The [demo adapter](../examples/product-studio/chat/agents/demo.mjs) uses the same tools. Keep model keys on your server. Hosted deployments need their own server secret configuration.

An agent in your application backend uses `createController({registry, store, sessionId, principal})` from `@viewherd/server`. Your host authenticates the user and checks session access before creating it. The controller reads the workspace and calls registered actions directly. See the [basic example](../examples/basic/server.mjs) for a small integration, or the studio's [server](../examples/product-studio/server.mjs) and [agent tools](../examples/product-studio/chat/agent-tools.mjs) for the full chat flow.

An agent in another service can connect to the application's authenticated `/mcp` endpoint to discover its tools, or send commands to `/viewherd/rpc` over HTTP. Read the workspace and action schemas first; use a stable request ID for retries and `expectedRevision` to protect edits made by people. See the [SDK guide](SDK.md) for the contract and host integration.

The host application decides which panels and actions exist and who can use them. The agent receives only those capabilities. It does not need DOM selectors, screenshots, or access to the person's browser.
