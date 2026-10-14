import { createDesign, createApp } from "./state.mjs";
import { ensureConversation } from "../chat/conversation.mjs";
import { renderDesign, dimensionsFor } from "../render.mjs";

function fail(code, message) {
  throw Object.assign(new Error(message), {
    code,
    ...(code === "agent_forbidden" ? { status: 403 } : {}),
  });
}

function paneIdsFromLayout(layout) {
  return layout.type === "pane"
    ? [layout.paneId]
    : [...paneIdsFromLayout(layout.first), ...paneIdsFromLayout(layout.second)];
}

// A transaction can close the panel whose action is running. Remember its tab
// so later operations in that same transaction still find the workspace.
const contextTabs = new WeakMap();

function currentTab(ctx) {
  const cached = contextTabs.get(ctx);
  for (const workspace of ctx.state.workspaces) {
    for (const tab of workspace.tabs) {
      if (
        cached
          ? tab.id === cached
          : paneIdsFromLayout(tab.layout).includes(ctx.pane.id)
      ) {
        contextTabs.set(ctx, tab.id);
        return tab;
      }
    }
  }
  fail("pane_not_found", "This panel is no longer attached to a workspace.");
}

export function panelsInTab(ctx) {
  return paneIdsFromLayout(currentTab(ctx).layout).map(
    (id) => ctx.state.panes[id],
  );
}

export function studioPanel(ctx) {
  const pane = panelsInTab(ctx).find((item) => item.view === "studio");
  if (!pane) {
    fail(
      "studio_not_found",
      "Open the studio control panel in this workspace first.",
    );
  }
  return pane;
}

export function getDesign(ctx, designId = ctx.app.selectedDesignId) {
  const design = Object.hasOwn(ctx.app.designs, designId)
    ? ctx.app.designs[designId]
    : null;
  if (!design) fail("design_not_found", "That design is no longer available.");
  return design;
}

export function recordChange(
  ctx,
  action,
  label,
  designId = ctx.app.selectedDesignId,
) {
  ctx.app.sequence += 1;
  ctx.app.history.push({ sequence: ctx.app.sequence, action, label, designId });
  ctx.app.history = ctx.app.history.slice(-32);
}

export function closePanels(ctx, predicate) {
  // Cache IDs before closing a panel: ctx.call reconciles the shared draft in place.
  const ids = panelsInTab(ctx)
    .filter(predicate)
    .map((pane) => pane.id);
  for (const id of ids) {
    ctx.call("pane.close", { paneId: id });
  }
}

function openCanvas(ctx, designId, targetPaneId, ratio = 0.5) {
  const design = getDesign(ctx, designId);
  const existing = panelsInTab(ctx).find(
    (pane) => pane.view === "canvas" && pane.data.designId === designId,
  );
  if (existing) return existing.id;
  return ctx.call("pane.split", {
    paneId: targetPaneId ?? studioPanel(ctx).id,
    direction: "right",
    ratio: targetPaneId ? ratio : 0.3,
    view: "canvas",
    title: design.name,
    data: { designId },
  }).paneId;
}

export function retainArtboards(ctx, designIds) {
  designIds.forEach((id) => getDesign(ctx, id));
  const retained = new Set();
  closePanels(ctx, (pane) => {
    if (["inspector", "deliverables"].includes(pane.view)) return true;
    if (pane.view !== "canvas") return false;
    if (
      !designIds.includes(pane.data.designId) ||
      retained.has(pane.data.designId)
    ) {
      return true;
    }
    retained.add(pane.data.designId);
    return false;
  });
}

function showDesigns(ctx, designIds) {
  retainArtboards(ctx, designIds);
  const paneIds = [];
  for (const designId of designIds) {
    paneIds.push(openCanvas(ctx, designId, paneIds.at(-1)));
  }
  const focused =
    paneIds[designIds.indexOf(ctx.app.selectedDesignId)] ?? paneIds[0];
  if (focused) ctx.call("pane.focus", { paneId: focused });
  return paneIds;
}

export function prepareDirections(ctx) {
  const created = [];
  for (const theme of ["sand", "midnight"]) {
    const design = createDesign(theme);
    if (!Object.hasOwn(ctx.app.designs, design.id)) {
      ctx.app.designs[design.id] = design;
      created.push(design.id);
    }
  }
  if (created.includes("design_midnight")) {
    ctx.app.selectedDesignId = "design_midnight";
  }
  return { designIds: ["design_sand", "design_midnight"], created };
}

export function compareDirections(ctx) {
  const { designIds, created } = prepareDirections(ctx);
  const paneIds = showDesigns(ctx, designIds);
  return {
    designIds,
    paneIds,
    created,
    selectedDesignId: ctx.app.selectedDesignId,
  };
}

export function selectDesign(ctx, designId) {
  getDesign(ctx, designId);
  const previous = ctx.app.selectedDesignId;
  ctx.app.selectedDesignId = designId;
  const [paneId] = showDesigns(ctx, [designId]);
  if (previous !== designId) {
    recordChange(ctx, "select", "Selected a direction", designId);
  }
  return { designId, paneId };
}

function openDetail(ctx, type, designId) {
  const design = getDesign(ctx, designId);
  ctx.app.selectedDesignId = designId;
  const otherType = type === "inspector" ? "deliverables" : "inspector";
  closePanels(
    ctx,
    (pane) =>
      pane.view === otherType ||
      (pane.view === type && pane.data.designId !== designId),
  );
  const existing = panelsInTab(ctx).find(
    (pane) => pane.view === type && pane.data.designId === designId,
  );
  if (existing) {
    ctx.call("pane.focus", { paneId: existing.id });
    return { designId, paneId: existing.id, reused: true };
  }
  // A focused editor or download panel gets space beside one winning artboard.
  closePanels(
    ctx,
    (pane) => pane.view === "canvas" && pane.data.designId !== designId,
  );
  const canvasId = openCanvas(ctx, designId);
  const paneId = ctx.call("pane.split", {
    paneId: canvasId,
    direction: "right",
    ratio: 0.68,
    view: type,
    title: type === "inspector" ? "Edit design" : "Export assets",
    data: { designId: design.id },
  }).paneId;
  return { designId, paneId, reused: false };
}

export function openEditor(ctx, designId) {
  return openDetail(ctx, "inspector", designId);
}

export function openExportPanel(ctx, designId) {
  return openDetail(ctx, "deliverables", designId);
}

export function updateDesign(ctx, designId, args) {
  const design = getDesign(ctx, designId);
  for (const key of ["headline", "cta"]) {
    if (args[key] !== undefined && !args[key].trim()) {
      fail("empty_copy", "The headline and button text cannot be blank.");
    }
  }
  const changed = Object.entries(args).some(
    ([key, value]) => design[key] !== value,
  );
  Object.assign(design, args);
  ctx.app.selectedDesignId = designId;
  if (changed) {
    ctx.app.lastExport = null;
    recordChange(ctx, "refine", "Updated the design", designId);
  }
  return { designId, changed, design: { ...design } };
}

export function removeDesign(ctx, designId) {
  getDesign(ctx, designId);
  const remaining = Object.keys(ctx.app.designs).filter(
    (id) => id !== designId,
  );
  if (!remaining.length) {
    fail("last_design", "Keep at least one design in the studio.");
  }
  delete ctx.app.designs[designId];
  if (ctx.app.selectedDesignId === designId) {
    ctx.app.selectedDesignId = remaining[0];
  }
  ctx.app.lastExport = null;
  recordChange(ctx, "remove", "Removed a design", designId);
  // Open the survivor before closing the action's own pane.
  const controllerId = studioPanel(ctx).id;
  openCanvas(ctx, ctx.app.selectedDesignId, controllerId, 0.3);
  const toClose = panelsInTab(ctx)
    .filter((pane) => pane.data.designId === designId)
    .map((pane) => pane.id);
  for (const paneId of toClose) ctx.call("pane.close", { paneId });
  return {
    removed: true,
    designId,
    selectedDesignId: ctx.app.selectedDesignId,
  };
}

export function exportDesign(ctx, designId) {
  const design = getDesign(ctx, designId);
  const svg = renderDesign(design, ctx.app.asset);
  const { width, height } = dimensionsFor(design.format);
  const result = {
    designId,
    filename: `forma-one-${design.theme}-${design.format}.svg`,
    svg,
    width,
    height,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 150000) {
    fail(
      "export_limit",
      "The image is too large to export. Upload a smaller product photo.",
    );
  }
  return result;
}

function validateImage(src) {
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
  if (!match || match[2].length % 4 !== 0) {
    fail("invalid_image", "Choose a PNG, JPEG, or WebP product photo.");
  }
  let binary;
  try {
    binary = atob(match[2]);
  } catch {
    fail("invalid_image", "The product photo is not a valid image data URL.");
  }
  const byte = (position) => binary.charCodeAt(position);
  let valid;
  if (match[1] === "png") {
    valid = [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, position) => byte(position) === value,
    );
  } else if (match[1] === "jpeg") {
    valid = byte(0) === 255 && byte(1) === 216 && byte(2) === 255;
  } else {
    valid = binary.startsWith("RIFF") && binary.slice(8, 12) === "WEBP";
  }
  if (!valid) {
    fail("invalid_image", "The photo format does not match its contents.");
  }
}

export function resetStudio(ctx) {
  const controllerId = studioPanel(ctx).id;
  closePanels(ctx, (pane) => pane.id !== controllerId);
  const chat = ctx.principal?.turnId ? ensureConversation(ctx) : null;
  for (const key of Object.keys(ctx.app)) delete ctx.app[key];
  Object.assign(ctx.app, createApp());
  if (chat) ctx.app.chat = chat;
  const paneId = openCanvas(ctx, ctx.app.selectedDesignId);
  ctx.call("pane.focus", { paneId: controllerId });
  return { reset: true, designId: ctx.app.selectedDesignId, paneId };
}

export function uploadImage(ctx, { src, name }) {
  if (!name.trim()) fail("invalid_image", "Give the product photo a name.");
  validateImage(src);
  const changed = ctx.app.asset.src !== src || ctx.app.asset.name !== name;
  ctx.app.asset = { src, name };
  ctx.app.lastExport = null;
  if (changed) recordChange(ctx, "upload", "Replaced the product photo");
  return { name, changed };
}
