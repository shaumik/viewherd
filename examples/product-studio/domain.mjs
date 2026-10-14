import { definePanel, createSession } from '@viewherd/core';
import { PRODUCT_IMAGE } from './product-image.mjs';
import { renderDesign, dimensionsFor } from './render.mjs';

const studioEmpty = { type: 'object', properties: {}, additionalProperties: false };
const studioDesignId = { type: 'string', minLength: 1, maxLength: 80 };
const studioDesignData = { type: 'object', properties: { designId: studioDesignId }, required: ['designId'], additionalProperties: false };
const studioEdits = {
  type: 'object', additionalProperties: false,
  properties: {
    theme: { type: 'string', enum: ['sand', 'midnight', 'cobalt'] },
    format: { type: 'string', enum: ['square', 'story'] },
    headline: { type: 'string', minLength: 1, maxLength: 80 },
    subhead: { type: 'string', maxLength: 140 },
    eyebrow: { type: 'string', maxLength: 48 },
    cta: { type: 'string', minLength: 1, maxLength: 32 },
  },
};

function studioSeedDesign(theme = 'sand') {
  return theme === 'sand'
    ? { id: 'design_sand', name: 'Warm minimal', format: 'square', theme, headline: 'Sound.\nWithout limits.', subhead: 'Meet FORMA One. Wireless sound, beautifully simple.', eyebrow: 'FORMA ONE / WIRELESS HEADPHONES', cta: 'Discover FORMA One' }
    : { id: 'design_midnight', name: 'After hours', format: 'square', theme: 'midnight', headline: 'Find your\nquiet.', subhead: 'Less noise. More of what moves you.', eyebrow: 'FORMA ONE / YOUR EVERYDAY ESCAPE', cta: 'Find your sound' };
}

function studioSeedApp() {
  const design = studioSeedDesign();
  return { name: 'Forma Studio', sample: true, asset: { name: 'FORMA One headphones', src: PRODUCT_IMAGE }, designs: { [design.id]: design }, selectedDesignId: design.id, history: [], sequence: 0, lastExport: null };
}

function studioError(code, message) { throw Object.assign(new Error(message), { code }); }
function studioLeaves(layout) { return layout.type === 'pane' ? [layout.paneId] : [...studioLeaves(layout.first), ...studioLeaves(layout.second)]; }
const studioContextTabs = new WeakMap();
function studioTab(ctx) {
  const cached = studioContextTabs.get(ctx);
  for (const workspace of ctx.state.workspaces) for (const tab of workspace.tabs) {
    if (cached ? tab.id === cached : studioLeaves(tab.layout).includes(ctx.pane.id)) { studioContextTabs.set(ctx, tab.id); return tab; }
  }
  studioError('pane_not_found', 'This panel is no longer attached to a workspace.');
}
function studioPanes(ctx) { return studioLeaves(studioTab(ctx).layout).map(id => ctx.state.panes[id]); }
function studioController(ctx) {
  const pane = studioPanes(ctx).find(item => item.view === 'studio');
  if (!pane) studioError('studio_not_found', 'Open the studio control panel in this workspace first.');
  return pane;
}
function studioDesign(ctx, designId = ctx.app.selectedDesignId) {
  const design = Object.hasOwn(ctx.app.designs, designId) ? ctx.app.designs[designId] : null;
  if (!design) studioError('design_not_found', 'That design is no longer available.');
  return design;
}
function studioRecord(ctx, action, label, designId = ctx.app.selectedDesignId) {
  ctx.app.sequence += 1;
  ctx.app.history.push({ sequence: ctx.app.sequence, action, label, designId });
  ctx.app.history = ctx.app.history.slice(-32);
}
function studioClose(ctx, predicate) {
  // Cache IDs before closing a panel: ctx.call reconciles the shared draft in place.
  for (const id of studioPanes(ctx).filter(predicate).map(pane => pane.id)) ctx.call('pane.close', { paneId: id });
}
function studioEnsureCanvas(ctx, designId, targetPaneId, ratio = 0.5) {
  const design = studioDesign(ctx, designId);
  const existing = studioPanes(ctx).find(pane => pane.view === 'canvas' && pane.data.designId === designId);
  if (existing) return existing.id;
  return ctx.call('pane.split', { paneId: targetPaneId ?? studioController(ctx).id, direction: 'right', ratio: targetPaneId ? ratio : 0.25, view: 'canvas', title: design.name, data: { designId } }).paneId;
}
function studioShow(ctx, designIds) {
  designIds.forEach(id => studioDesign(ctx, id));
  const retained = new Set();
  studioClose(ctx, pane => {
    if (['inspector', 'deliverables'].includes(pane.view)) return true;
    if (pane.view !== 'canvas') return false;
    if (!designIds.includes(pane.data.designId) || retained.has(pane.data.designId)) return true;
    retained.add(pane.data.designId); return false;
  });
  const paneIds = [];
  for (const designId of designIds) paneIds.push(studioEnsureCanvas(ctx, designId, paneIds.at(-1)));
  const focused = paneIds[designIds.indexOf(ctx.app.selectedDesignId)] ?? paneIds[0];
  if (focused) ctx.call('pane.focus', { paneId: focused });
  return paneIds;
}
function studioDirections(ctx) {
  const created = [];
  for (const theme of ['sand', 'midnight']) {
    const design = studioSeedDesign(theme);
    if (!Object.hasOwn(ctx.app.designs, design.id)) { ctx.app.designs[design.id] = design; created.push(design.id); }
  }
  if (created.includes('design_midnight')) ctx.app.selectedDesignId = 'design_midnight';
  const designIds = ['design_sand', 'design_midnight'];
  const paneIds = studioShow(ctx, designIds);
  return { designIds, paneIds, created, selectedDesignId: ctx.app.selectedDesignId };
}
function studioSelect(ctx, designId) {
  studioDesign(ctx, designId);
  const previous = ctx.app.selectedDesignId;
  ctx.app.selectedDesignId = designId;
  const [paneId] = studioShow(ctx, [designId]);
  if (previous !== designId) studioRecord(ctx, 'select', 'Selected a direction', designId);
  return { designId, paneId };
}
function studioOpenDetail(ctx, type, designId) {
  const design = studioDesign(ctx, designId);
  ctx.app.selectedDesignId = designId;
  const otherType = type === 'inspector' ? 'deliverables' : 'inspector';
  studioClose(ctx, pane => pane.view === otherType || pane.view === type && pane.data.designId !== designId);
  const existing = studioPanes(ctx).find(pane => pane.view === type && pane.data.designId === designId);
  if (existing) { ctx.call('pane.focus', { paneId: existing.id }); return { designId, paneId: existing.id, reused: true }; }
  // A focused editor or download panel gets space beside one winning artboard.
  studioClose(ctx, pane => pane.view === 'canvas' && pane.data.designId !== designId);
  const canvasId = studioEnsureCanvas(ctx, designId);
  const paneId = ctx.call('pane.split', { paneId: canvasId, direction: 'right', ratio: 0.68, view: type, title: type === 'inspector' ? 'Edit design' : 'Export assets', data: { designId: design.id } }).paneId;
  return { designId, paneId, reused: false };
}
function studioUpdate(ctx, designId, args) {
  const design = studioDesign(ctx, designId);
  for (const key of ['headline', 'cta']) if (args[key] !== undefined && !args[key].trim()) studioError('empty_copy', 'The headline and button text cannot be blank.');
  const changed = Object.entries(args).some(([key, value]) => design[key] !== value);
  Object.assign(design, args);
  ctx.app.selectedDesignId = designId;
  if (changed) { ctx.app.lastExport = null; studioRecord(ctx, 'refine', 'Updated the design', designId); }
  return { designId, changed, design: { ...design } };
}
function studioExport(ctx, designId) {
  const design = studioDesign(ctx, designId);
  const svg = renderDesign(design, ctx.app.asset);
  const { width, height } = dimensionsFor(design.format);
  const result = { designId, filename: `forma-one-${design.theme}-${design.format}.svg`, svg, width, height };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 150000) studioError('export_limit', 'The image is too large to export. Upload a smaller product photo.');
  return result;
}
function studioAsset(src) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
  if (!match || match[2].length % 4 !== 0) studioError('invalid_image', 'Choose a PNG, JPEG, or WebP product photo.');
  let binary;
  try { binary = atob(match[2]); } catch { studioError('invalid_image', 'The product photo is not a valid image data URL.'); }
  const byte = position => binary.charCodeAt(position);
  const valid = match[1] === 'png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((value, position) => byte(position) === value)
    : match[1] === 'jpeg' ? byte(0) === 255 && byte(1) === 216 && byte(2) === 255
      : binary.startsWith('RIFF') && binary.slice(8, 12) === 'WEBP';
  if (!valid) studioError('invalid_image', 'The photo format does not match its contents.');
}

export const studioPanels = [
  definePanel({
    type: 'studio', title: 'Creative brief', description: 'Create, compare, edit, and export real product launch assets.', dataSchema: studioEmpty,
    actions: {
      createDirections: {
        description: 'Open two visual directions side by side. Reopening preserves existing copy and edits.', inputSchema: studioEmpty,
        run(ctx) { const result = studioDirections(ctx); if (result.created.length) studioRecord(ctx, 'createDirections', 'Created two visual directions'); return result; },
      },
      refine: {
        description: 'Update the selected design’s palette, copy, or size. Other designs retain their edits.', inputSchema: studioEdits,
        run(ctx, args) { return studioUpdate(ctx, studioDesign(ctx).id, args); },
      },
      compare: {
        description: 'Show both saved directions in real split panels without replacing human edits.', inputSchema: studioEmpty,
        run(ctx) { return studioDirections(ctx); },
      },
      select: {
        description: 'Keep one winning artboard open and close the comparison and editing panels.', inputSchema: { type: 'object', properties: { designId: studioDesignId }, required: ['designId'], additionalProperties: false },
        run(ctx, { designId }) { return studioSelect(ctx, designId); },
      },
      inspect: {
        description: 'Open a live editing panel beside the selected artboard.', inputSchema: studioEmpty,
        run(ctx) { return studioOpenDetail(ctx, 'inspector', studioDesign(ctx).id); },
      },
      export: {
        description: 'Open export controls and prepare a self-contained SVG of the selected artboard.', inputSchema: studioEmpty,
        run(ctx) {
          const designId = studioDesign(ctx).id;
          const result = studioExport(ctx, designId);
          const opened = studioOpenDetail(ctx, 'deliverables', designId);
          ctx.app.lastExport = { designId, filename: result.filename, width: result.width, height: result.height };
          studioRecord(ctx, 'export', 'Prepared a downloadable asset', designId);
          return { ...result, paneId: opened.paneId };
        },
      },
      upload: {
        description: 'Replace the product photo with a browser-normalized PNG, JPEG, or WebP data URL. Preserve designs.',
        inputSchema: { type: 'object', properties: { src: { type: 'string', minLength: 30, maxLength: 120000 }, name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['src', 'name'], additionalProperties: false },
        run(ctx, { src, name }) {
          if (!name.trim()) studioError('invalid_image', 'Give the product photo a name.');
          studioAsset(src);
          const changed = ctx.app.asset.src !== src || ctx.app.asset.name !== name;
          ctx.app.asset = { src, name }; ctx.app.lastExport = null;
          if (changed) studioRecord(ctx, 'upload', 'Replaced the product photo');
          return { name, changed };
        },
      },
      reset: {
        description: 'Explicitly restore the sample photo and original design, closing the other panels.', inputSchema: studioEmpty,
        run(ctx) {
          const controllerId = studioController(ctx).id;
          studioClose(ctx, pane => pane.id !== controllerId);
          for (const key of Object.keys(ctx.app)) delete ctx.app[key];
          Object.assign(ctx.app, studioSeedApp());
          const paneId = studioEnsureCanvas(ctx, ctx.app.selectedDesignId);
          ctx.call('pane.focus', { paneId });
          return { reset: true, designId: ctx.app.selectedDesignId, paneId };
        },
      },
    },
  }),
  definePanel({
    type: 'canvas', title: 'Artboard', description: 'A live launch design that humans and agents can select, edit, or remove.', dataSchema: studioDesignData,
    actions: {
      select: { description: 'Select this design and close the other artboards.', inputSchema: studioEmpty, run(ctx) { return studioSelect(ctx, ctx.pane.data.designId); } },
      inspect: { description: 'Open editing controls for this artboard.', inputSchema: studioEmpty, run(ctx) { return studioOpenDetail(ctx, 'inspector', ctx.pane.data.designId); } },
      remove: {
        description: 'Delete this saved direction and all panels showing it. Keep at least one design.', inputSchema: studioEmpty,
        run(ctx) {
          const designId = studioDesign(ctx, ctx.pane.data.designId).id;
          const remaining = Object.keys(ctx.app.designs).filter(id => id !== designId);
          if (!remaining.length) studioError('last_design', 'Keep at least one design in the studio.');
          delete ctx.app.designs[designId];
          if (ctx.app.selectedDesignId === designId) ctx.app.selectedDesignId = remaining[0];
          ctx.app.lastExport = null;
          studioRecord(ctx, 'remove', 'Removed a design', designId);
          // Open the survivor before closing the action’s own pane.
          const controllerId = studioController(ctx).id;
          studioEnsureCanvas(ctx, ctx.app.selectedDesignId, controllerId, 0.25);
          const toClose = studioPanes(ctx).filter(pane => pane.data.designId === designId).map(pane => pane.id);
          for (const paneId of toClose) ctx.call('pane.close', { paneId });
          return { removed: true, designId, selectedDesignId: ctx.app.selectedDesignId };
        },
      },
    },
  }),
  definePanel({
    type: 'inspector', title: 'Edit design', description: 'Edit typography, color, and format without replacing the live artboard.', dataSchema: studioDesignData,
    actions: { update: { description: 'Save only the supplied design fields. Use expectedRevision to protect concurrent human edits.', inputSchema: studioEdits, run(ctx, args) { return studioUpdate(ctx, ctx.pane.data.designId, args); } } },
  }),
  definePanel({
    type: 'deliverables', title: 'Export assets', description: 'Prepare a self-contained SVG that can also be rendered to PNG in the browser.', dataSchema: studioDesignData,
    actions: { export: { description: 'Return the current design as a standalone SVG, including the embedded product photo.', inputSchema: studioEmpty, run(ctx) { return studioExport(ctx, ctx.pane.data.designId); } } },
  }),
];

export function createStudioState(sessionId = 'product-studio') {
  const app = studioSeedApp();
  const state = createSession({ id: sessionId, label: 'Forma Studio', view: 'studio', title: 'Creative brief', data: {}, app });
  state.panes.pane_design_seed = { id: 'pane_design_seed', view: 'canvas', title: app.designs.design_sand.name, data: { designId: 'design_sand' } };
  const tab = state.workspaces[0].tabs[0];
  tab.label = 'Launch assets'; tab.focusedPaneId = 'pane_design_seed';
  tab.layout = { type: 'split', id: 'split_studio_seed', direction: 'right', ratio: 0.25, first: { type: 'pane', paneId: 'pane_inbox' }, second: { type: 'pane', paneId: 'pane_design_seed' } };
  return state;
}
