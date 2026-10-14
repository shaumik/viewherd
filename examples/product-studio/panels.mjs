import { definePanel } from "@viewherd/core";
import {
  conversationActions,
  guardAgentActions,
} from "./chat/conversation.mjs";
import {
  emptyInput,
  designDataSchema,
  designEditsSchema,
  targetedEditsSchema,
} from "./studio/schemas.mjs";
import {
  panelsInTab,
  studioPanel,
  getDesign,
  prepareDirections,
  retainArtboards,
  compareDirections,
  selectDesign,
  openEditor,
  openExportPanel,
  updateDesign,
  removeDesign,
  exportDesign,
  uploadImage,
  resetStudio,
  recordChange,
} from "./studio/actions.mjs";

// Register the actions your app allows. Both human controls and backend agents
// call these actions through panel.action; they never mutate browser elements.
export const studioPanels = [
  definePanel({
    type: "studio",
    title: "Studio chat",
    description:
      "Create, compare, edit, and export real product launch assets.",
    dataSchema: emptyInput,
    actions: {
      ...conversationActions,
      ...guardAgentActions({
        createDirections: {
          description:
            "Open two visual directions side by side. Reopening preserves existing copy and edits.",
          inputSchema: emptyInput,
          run(ctx) {
            const { designIds, created } = prepareDirections(ctx);
            retainArtboards(ctx, designIds);
            const paneIds = [];

            for (const designId of designIds) {
              const existing = panelsInTab(ctx).find(
                (pane) =>
                  pane.view === "canvas" && pane.data.designId === designId,
              );

              if (existing) {
                paneIds.push(existing.id);
                continue;
              }

              const design = getDesign(ctx, designId);
              const targetPaneId = paneIds.at(-1) ?? studioPanel(ctx).id;
              // This changes the saved layout. The SDK streams the new panel
              // to every browser watching this session.
              const opened = ctx.call("pane.split", {
                paneId: targetPaneId,
                direction: "right",
                ratio: paneIds.length ? 0.5 : 0.3,
                view: "canvas",
                title: design.name,
                data: { designId },
              });
              paneIds.push(opened.paneId);
            }

            const selected = designIds.indexOf(ctx.app.selectedDesignId);
            ctx.call("pane.focus", { paneId: paneIds[selected] ?? paneIds[0] });
            if (created.length) {
              recordChange(
                ctx,
                "createDirections",
                "Created two visual directions",
              );
            }
            return {
              designIds,
              paneIds,
              created,
              selectedDesignId: ctx.app.selectedDesignId,
            };
          },
        },
        refine: {
          description:
            "Update a specified design’s palette, copy, or size. Omitting designId uses the selected design. Other designs retain their edits.",
          inputSchema: targetedEditsSchema,
          run(ctx, { designId, ...edits }) {
            return updateDesign(ctx, getDesign(ctx, designId).id, edits);
          },
        },
        compare: {
          description:
            "Show both saved directions in real split panels without replacing human edits.",
          inputSchema: emptyInput,
          run: compareDirections,
        },
        select: {
          description:
            "Keep one winning artboard open and close the comparison and editing panels.",
          inputSchema: designDataSchema,
          run(ctx, { designId }) {
            return selectDesign(ctx, designId);
          },
        },
        remove: {
          description:
            "Delete a specified saved direction and its panels. Keep at least one design.",
          inputSchema: designDataSchema,
          run(ctx, { designId }) {
            return removeDesign(ctx, designId);
          },
        },
        inspect: {
          description:
            "Open a live editing panel beside the selected artboard.",
          inputSchema: emptyInput,
          run(ctx) {
            return openEditor(ctx, getDesign(ctx).id);
          },
        },
        export: {
          description:
            "Open export controls and prepare a self-contained SVG of the selected artboard.",
          inputSchema: emptyInput,
          run(ctx) {
            const designId = getDesign(ctx).id;
            const result = exportDesign(ctx, designId);
            const opened = openExportPanel(ctx, designId);
            ctx.app.lastExport = {
              designId,
              filename: result.filename,
              width: result.width,
              height: result.height,
            };
            recordChange(
              ctx,
              "export",
              "Prepared a downloadable asset",
              designId,
            );
            return { ...result, paneId: opened.paneId };
          },
        },
        upload: {
          description:
            "Replace the product photo with a browser-normalized PNG, JPEG, or WebP data URL. Preserve designs.",
          inputSchema: {
            type: "object",
            properties: {
              src: { type: "string", minLength: 30, maxLength: 120000 },
              name: { type: "string", minLength: 1, maxLength: 80 },
            },
            required: ["src", "name"],
            additionalProperties: false,
          },
          run: uploadImage,
        },
        reset: {
          description:
            "Explicitly restore the sample photo and original design, closing the other panels.",
          inputSchema: emptyInput,
          run: resetStudio,
        },
      }),
    },
  }),
  definePanel({
    type: "canvas",
    title: "Artboard",
    description:
      "A live launch design that humans and agents can select, edit, or remove.",
    dataSchema: designDataSchema,
    actions: guardAgentActions({
      select: {
        description: "Select this design and close the other artboards.",
        inputSchema: emptyInput,
        run(ctx) {
          return selectDesign(ctx, ctx.pane.data.designId);
        },
      },
      inspect: {
        description: "Open editing controls for this artboard.",
        inputSchema: emptyInput,
        run(ctx) {
          return openEditor(ctx, ctx.pane.data.designId);
        },
      },
      remove: {
        description:
          "Delete this saved direction and all panels showing it. Keep at least one design.",
        inputSchema: emptyInput,
        run(ctx) {
          return removeDesign(ctx, ctx.pane.data.designId);
        },
      },
    }),
  }),
  definePanel({
    type: "inspector",
    title: "Edit design",
    description:
      "Edit typography, color, and format without replacing the live artboard.",
    dataSchema: designDataSchema,
    actions: guardAgentActions({
      update: {
        description:
          "Save only the supplied design fields. Use expectedRevision to protect concurrent human edits.",
        inputSchema: designEditsSchema,
        run(ctx, edits) {
          return updateDesign(ctx, ctx.pane.data.designId, edits);
        },
      },
    }),
  }),
  definePanel({
    type: "deliverables",
    title: "Export assets",
    description:
      "Prepare a self-contained SVG that can also be rendered to PNG in the browser.",
    dataSchema: designDataSchema,
    actions: guardAgentActions({
      export: {
        description:
          "Return the current design as a standalone SVG, including the embedded product photo.",
        inputSchema: emptyInput,
        run(ctx) {
          return exportDesign(ctx, ctx.pane.data.designId);
        },
      },
    }),
  }),
];
