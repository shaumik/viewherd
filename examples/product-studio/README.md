# Forma Studio

Turn a product photo into a launch campaign.

Ask the chat to create two directions. Tell it which one to keep, change the copy and colors, then export SVG or PNG. You can also upload your own product photo.

From the repository root, run:

```sh
npm run example
```

Open http://localhost:4317. [start.mjs](start.mjs) starts the local server.

The demo agent runs on the server and handles sample requests without an API key. It creates, edits, and closes real panels through Viewherd. [Connect a real model or your own agent](../../docs/AGENTS.md).

Read these files in order:

1. [server.mjs](server.mjs): connect storage, authentication, chat, and Viewherd.
2. [panels.mjs](panels.mjs): define the actions that create and change panels.
3. [client/main.js](client/main.js): connect the browser and register its panel renderers.
4. [chat/agent-tools.mjs](chat/agent-tools.mjs): let a backend agent call those actions.

For the shortest starting point, see the [basic example](../basic). The sample headphones and brand are fictional.
