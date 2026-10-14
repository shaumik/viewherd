import { definePanel } from "@viewherd/core";

// A panel declares its data and the actions an agent or person may call.
export const notePanel = definePanel({
  type: "note",
  title: "Note",
  dataSchema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 1000 } },
    required: ["text"],
    additionalProperties: false,
  },
  actions: {
    open: {
      description: "Open another note beside this one.",
      inputSchema: { type: "object", additionalProperties: false },
      run(ctx) {
        return ctx.call("pane.split", {
          paneId: ctx.pane.id,
          direction: "right",
          view: "note",
          title: "New note",
          data: { text: "" },
        });
      },
    },
    update: {
      description: "Replace the text in this note.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", maxLength: 1000 } },
        required: ["text"],
        additionalProperties: false,
      },
      run(ctx, { text }) {
        ctx.call("view.update", { paneId: ctx.pane.id, data: { text } });
        return { text };
      },
    },
  },
});
