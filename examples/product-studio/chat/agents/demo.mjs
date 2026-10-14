// The demo uses a deterministic parser. A real model implements the same run() contract.
import { parseDemoMessage } from "./demo-parser.mjs";

export function createDemoAgent() {
  return {
    mode: "demo",
    async run({ message, snapshot, call, signal }) {
      if (signal.aborted) throw signal.reason;
      const planned = parseDemoMessage(message, await snapshot());
      if (planned.reply) return planned.reply;
      const replies = [];
      for (const step of planned.plan) {
        if (signal.aborted) throw signal.reason;
        await call({ action: step.action, args: step.args, label: step.label });
        replies.push(step.reply);
      }
      return replies.join(" ");
    },
  };
}
