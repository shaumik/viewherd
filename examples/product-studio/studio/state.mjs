import { createSession } from "@viewherd/core";
import { PRODUCT_IMAGE } from "../product-image.mjs";

export function createDesign(theme = "sand") {
  if (theme === "sand") {
    return {
      id: "design_sand",
      name: "Warm minimal",
      format: "square",
      theme,
      headline: "Sound.\nWithout limits.",
      subhead: "Meet FORMA One. Wireless sound, beautifully simple.",
      eyebrow: "FORMA ONE / WIRELESS HEADPHONES",
      cta: "Discover FORMA One",
    };
  }

  return {
    id: "design_midnight",
    name: "After hours",
    format: "square",
    theme: "midnight",
    headline: "Find your\nquiet.",
    subhead: "Less noise. More of what moves you.",
    eyebrow: "FORMA ONE / YOUR EVERYDAY ESCAPE",
    cta: "Find your sound",
  };
}

export function createApp() {
  const design = createDesign();
  return {
    name: "Forma Studio",
    sample: true,
    asset: { name: "FORMA One headphones", src: PRODUCT_IMAGE },
    designs: { [design.id]: design },
    selectedDesignId: design.id,
    history: [],
    sequence: 0,
    lastExport: null,
    chat: { turns: [], activeTurnId: null },
  };
}

export function createStudioState(sessionId = "product-studio") {
  const app = createApp();
  const state = createSession({
    id: sessionId,
    label: "Forma Studio",
    view: "studio",
    title: "Studio chat",
    data: {},
    app,
  });

  // Start with the chat and one artboard visible. Later panel actions use the
  // same pane.split, pane.close, and pane.focus layout operations.
  state.panes.pane_design_seed = {
    id: "pane_design_seed",
    view: "canvas",
    title: app.designs.design_sand.name,
    data: { designId: "design_sand" },
  };
  const tab = state.workspaces[0].tabs[0];
  tab.label = "Launch assets";
  tab.focusedPaneId = "pane_inbox";
  tab.layout = {
    type: "split",
    id: "split_studio_seed",
    direction: "right",
    ratio: 0.3,
    first: { type: "pane", paneId: "pane_inbox" },
    second: { type: "pane", paneId: "pane_design_seed" },
  };
  return state;
}
