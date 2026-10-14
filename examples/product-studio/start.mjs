import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createFileStore } from "@viewherd/server/node";
import { startExampleServer } from "../shared/node-server.mjs";
import { createLocalAuth } from "../shared/local-auth.mjs";
import { createStudioApp } from "./server.mjs";
import { createStudioState } from "./studio/state.mjs";
import { createDemoAgent } from "./chat/agents/demo.mjs";
import { createOpenAIAgent } from "./chat/agents/openai.mjs";

const root = new URL(".", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../", root));
const store = createFileStore({
  path:
    process.env.VIEWHERD_STUDIO_DATA_FILE ??
    resolve(repositoryRoot, ".webdr/product-studio.json"),
  createState: createStudioState,
});
const agent = process.env.OPENAI_API_KEY
  ? createOpenAIAgent({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    })
  : createDemoAgent();

// This localhost demo has one user. Replace this with your app's authentication.
const auth = createLocalAuth({
  token: process.env.VIEWHERD_TOKEN ?? process.env.WEBDR_TOKEN,
});
const handleStudio = createStudioApp({
  store,
  authorize: auth.authorize,
  agent,
});

startExampleServer({
  handler: async (request) =>
    (await auth.handleLogin(request)) ?? handleStudio(request),
  root,
  port: Number(process.env.PORT ?? 4317),
});
