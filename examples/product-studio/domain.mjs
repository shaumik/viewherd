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
const studioTargetedEdits = { ...studioEdits, properties: { ...studioEdits.properties, designId: studioDesignId } };
const studioTurnId = { type: 'string', minLength: 1, maxLength: 128 };
const studioReply = { type: 'string', maxLength: 4000 };
const studioStep = {
  type: 'object', additionalProperties: false, required: ['id', 'label', 'status', 'action'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    label: { type: 'string', minLength: 1, maxLength: 200 },
    status: { type: 'string', enum: ['running', 'done', 'failed'] },
    action: { type: 'string', minLength: 1, maxLength: 120 },
    revision: { type: 'integer', minimum: 0 },
    error: { type: 'string', maxLength: 800 },
  },
};

function studioSeedDesign(theme = 'sand') {
  return theme === 'sand'
    ? { id: 'design_sand', name: 'Warm minimal', format: 'square', theme, headline: 'Sound.\nWithout limits.', subhead: 'Meet FORMA One. Wireless sound, beautifully simple.', eyebrow: 'FORMA ONE / WIRELESS HEADPHONES', cta: 'Discover FORMA One' }
    : { id: 'design_midnight', name: 'After hours', format: 'square', theme: 'midnight', headline: 'Find your\nquiet.', subhead: 'Less noise. More of what moves you.', eyebrow: 'FORMA ONE / YOUR EVERYDAY ESCAPE', cta: 'Find your sound' };
}

function studioSeedApp() {
  const design = studioSeedDesign();
  return { name: 'Forma Studio', sample: true, asset: { name: 'FORMA One headphones', src: PRODUCT_IMAGE }, designs: { [design.id]: design }, selectedDesignId: design.id, history: [], sequence: 0, lastExport: null, chat: { turns: [], activeTurnId: null } };
}

function studioError(code, message) { throw Object.assign(new Error(message), { code, ...(code === 'agent_forbidden' ? { status: 403 } : {}) }); }
function studioChat(ctx) {
  // Older saved sessions gain conversation state only when a turn is started.
  ctx.app.chat ??= { turns: [], activeTurnId: null };
  return ctx.app.chat;
}
function studioAgent(ctx, turnId) {
  const principal = ctx.principal;
  if (!Array.isArray(principal?.roles) || !principal.roles.includes('studio-agent') ||
    typeof principal.id !== 'string' || !principal.id || principal.turnId !== turnId ||
    !Number.isSafeInteger(principal.serverTime) || principal.serverTime < 0) {
    studioError('agent_forbidden', 'Only the trusted studio agent can update a conversation.');
  }
  return principal;
}
function studioOwnedTurn(ctx, turnId) {
  const principal = studioAgent(ctx, turnId);
  const chat = studioChat(ctx), turn = chat.turns.find(item => item.id === turnId);
  if (!turn || turn.ownerId !== principal.id) studioError('agent_cancelled', 'This request was cancelled.');
  return { chat, turn, principal };
}
function studioRunningTurn(ctx, turnId = ctx.principal?.turnId, allowExpired = false) {
  const owned = studioOwnedTurn(ctx, turnId);
  if (owned.chat.activeTurnId !== turnId || owned.turn.status !== 'running' ||
    !allowExpired && owned.turn.expiresAt <= owned.principal.serverTime) {
    studioError('agent_cancelled', 'This request is no longer active.');
  }
  return owned;
}
function studioBeginTurn(ctx, args) {
  const principal = studioAgent(ctx, args.turnId), chat = studioChat(ctx);
  const previous = chat.turns.find(item => item.id === args.turnId);
  if (previous) {
    if (previous.ownerId !== principal.id || previous.message !== args.message || previous.mode !== args.mode) {
      studioError('turn_conflict', 'That request ID has already been used for another message.');
    }
    return { turn: structuredClone(previous), replayed: true };
  }
  if (!args.message.trim()) studioError('empty_message', 'Enter a message for the studio.');
  if (!Number.isSafeInteger(args.expiresAt) || args.expiresAt <= principal.serverTime) studioError('invalid_lease', 'The agent request must have a future expiry.');
  const active = chat.turns.find(item => item.id === chat.activeTurnId);
  if (active?.status === 'running') {
    if (active.expiresAt > principal.serverTime) studioError('turn_in_progress', 'Wait for the current request to finish.');
    active.status = 'failed'; active.reply = active.reply || 'This request expired. Try again.';
    for (const step of active.steps) if (step.status === 'running') { step.status = 'failed'; step.error = 'This request expired.'; }
  }
  if (ctx.pane.title === 'Creative brief') ctx.call('view.update', { paneId: ctx.pane.id, title: 'Studio chat', data: {} });
  const turn = { id: args.turnId, ownerId: principal.id, message: args.message, mode: args.mode, status: 'running', reply: '', steps: [], expiresAt: args.expiresAt };
  chat.turns.push(turn); chat.turns = chat.turns.slice(-12); chat.activeTurnId = turn.id;
  return { turn: structuredClone(turn) };
}
function studioSaveStep(turn, step) {
  const index = turn.steps.findIndex(item => item.id === step.id);
  if (index === -1) {
    if (turn.steps.length >= 12) studioError('step_limit', 'A studio request can take up to 12 actions.');
    turn.steps.push(structuredClone(step));
  } else {
    // A repeated start notification cannot regress an already finished step.
    const previous = turn.steps[index];
    if (previous.status === 'running' || step.status !== 'running') turn.steps[index] = { ...previous, ...step };
  }
}
function studioUpdateTurn(ctx, { turnId, reply, step }) {
  const { turn } = studioRunningTurn(ctx, turnId);
  if (reply !== undefined) turn.reply = reply;
  if (step) studioSaveStep(turn, step);
  return { turn: structuredClone(turn) };
}
function studioFinishTurn(ctx, { turnId, status, reply, steps }) {
  const { chat, turn } = studioOwnedTurn(ctx, turnId);
  if (turn.status !== 'running') return { turn: structuredClone(turn), replayed: true };
  studioRunningTurn(ctx, turnId, true);
  if (steps) {
    if (new Set(steps.map(step => step.id)).size !== steps.length) studioError('invalid_steps', 'Final action steps must have unique IDs.');
    // A tool can commit before its progress write fails. Reconcile the server's
    // verified outcomes so ending the request does not report that action failed.
    for (const step of steps) studioSaveStep(turn, step);
  }
  turn.status = status; turn.reply = reply; chat.activeTurnId = null;
  for (const step of turn.steps) if (step.status === 'running') { step.status = 'failed'; step.error ??= 'The request ended before this action finished.'; }
  return { turn: structuredClone(turn) };
}
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
  return ctx.call('pane.split', { paneId: targetPaneId ?? studioController(ctx).id, direction: 'right', ratio: targetPaneId ? ratio : 0.30, view: 'canvas', title: design.name, data: { designId } }).paneId;
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
function studioRemove(ctx, designId) {
  studioDesign(ctx, designId);
  const remaining = Object.keys(ctx.app.designs).filter(id => id !== designId);
  if (!remaining.length) studioError('last_design', 'Keep at least one design in the studio.');
  delete ctx.app.designs[designId];
  if (ctx.app.selectedDesignId === designId) ctx.app.selectedDesignId = remaining[0];
  ctx.app.lastExport = null;
  studioRecord(ctx, 'remove', 'Removed a design', designId);
  // Open the survivor before closing the action's own pane.
  const controllerId = studioController(ctx).id;
  studioEnsureCanvas(ctx, ctx.app.selectedDesignId, controllerId, 0.30);
  const toClose = studioPanes(ctx).filter(pane => pane.data.designId === designId).map(pane => pane.id);
  for (const paneId of toClose) ctx.call('pane.close', { paneId });
  return { removed: true, designId, selectedDesignId: ctx.app.selectedDesignId };
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

const studioDefinitions = [
  {
    type: 'studio', title: 'Studio chat', description: 'Create, compare, edit, and export real product launch assets.', dataSchema: studioEmpty,
    actions: {
      beginTurn: {
        description: 'Restricted server action: begin an agent conversation with a bounded lease. Requires a host-verified studio-agent role and matching turn owner.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['turnId', 'message', 'mode', 'expiresAt'], properties: { turnId: studioTurnId, message: { type: 'string', minLength: 1, maxLength: 2000 }, mode: { type: 'string', enum: ['demo', 'openai'] }, expiresAt: { type: 'integer', minimum: 0 } } },
        run: studioBeginTurn,
      },
      updateTurn: {
        description: 'Restricted server action: publish reply text and the current agent tool step. Requires a host-verified studio-agent role and matching active turn owner.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['turnId'], properties: { turnId: studioTurnId, reply: studioReply, step: studioStep } },
        run: studioUpdateTurn,
      },
      finishTurn: {
        description: 'Restricted server action: finish an agent conversation and release its lease. Requires a host-verified studio-agent role and matching turn owner.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['turnId', 'status', 'reply'], properties: { turnId: studioTurnId, status: { type: 'string', enum: ['completed', 'failed'] }, reply: studioReply, steps: { type: 'array', items: studioStep, maxItems: 12 } } },
        run: studioFinishTurn,
      },
      createDirections: {
        description: 'Open two visual directions side by side. Reopening preserves existing copy and edits.', inputSchema: studioEmpty,
        run(ctx) { const result = studioDirections(ctx); if (result.created.length) studioRecord(ctx, 'createDirections', 'Created two visual directions'); return result; },
      },
      refine: {
        description: 'Update a specified design’s palette, copy, or size. Omitting designId uses the selected design. Other designs retain their edits.', inputSchema: studioTargetedEdits,
        run(ctx, { designId, ...edits }) { return studioUpdate(ctx, studioDesign(ctx, designId).id, edits); },
      },
      compare: {
        description: 'Show both saved directions in real split panels without replacing human edits.', inputSchema: studioEmpty,
        run(ctx) { return studioDirections(ctx); },
      },
      select: {
        description: 'Keep one winning artboard open and close the comparison and editing panels.', inputSchema: { type: 'object', properties: { designId: studioDesignId }, required: ['designId'], additionalProperties: false },
        run(ctx, { designId }) { return studioSelect(ctx, designId); },
      },
      remove: {
        description: 'Delete a specified saved direction and its panels. Keep at least one design.', inputSchema: studioDesignData,
        run(ctx, { designId }) { return studioRemove(ctx, designId); },
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
          const chat = ctx.principal?.turnId ? studioChat(ctx) : null;
          for (const key of Object.keys(ctx.app)) delete ctx.app[key];
          Object.assign(ctx.app, studioSeedApp());
          if (chat) ctx.app.chat = chat;
          const paneId = studioEnsureCanvas(ctx, ctx.app.selectedDesignId);
          ctx.call('pane.focus', { paneId: controllerId });
          return { reset: true, designId: ctx.app.selectedDesignId, paneId };
        },
      },
    },
  },
  {
    type: 'canvas', title: 'Artboard', description: 'A live launch design that humans and agents can select, edit, or remove.', dataSchema: studioDesignData,
    actions: {
      select: { description: 'Select this design and close the other artboards.', inputSchema: studioEmpty, run(ctx) { return studioSelect(ctx, ctx.pane.data.designId); } },
      inspect: { description: 'Open editing controls for this artboard.', inputSchema: studioEmpty, run(ctx) { return studioOpenDetail(ctx, 'inspector', ctx.pane.data.designId); } },
      remove: {
        description: 'Delete this saved direction and all panels showing it. Keep at least one design.', inputSchema: studioEmpty,
        run(ctx) { return studioRemove(ctx, ctx.pane.data.designId); },
      },
    },
  },
  {
    type: 'inspector', title: 'Edit design', description: 'Edit typography, color, and format without replacing the live artboard.', dataSchema: studioDesignData,
    actions: { update: { description: 'Save only the supplied design fields. Use expectedRevision to protect concurrent human edits.', inputSchema: studioEdits, run(ctx, args) { return studioUpdate(ctx, ctx.pane.data.designId, args); } } },
  },
  {
    type: 'deliverables', title: 'Export assets', description: 'Prepare a self-contained SVG that can also be rendered to PNG in the browser.', dataSchema: studioDesignData,
    actions: { export: { description: 'Return the current design as a standalone SVG, including the embedded product photo.', inputSchema: studioEmpty, run(ctx) { return studioExport(ctx, ctx.pane.data.designId); } } },
  },
];

const studioConversationActions = new Set(['beginTurn', 'updateTurn', 'finishTurn']);
export const studioPanels = studioDefinitions.map(definition => definePanel({
  ...definition,
  actions: Object.fromEntries(Object.entries(definition.actions).map(([name, action]) => [name, {
    ...action,
    run(ctx, args) {
      if (ctx.principal?.turnId !== undefined && !(definition.type === 'studio' && studioConversationActions.has(name))) studioRunningTurn(ctx);
      return action.run(ctx, args);
    },
  }])),
}));

export function createStudioState(sessionId = 'product-studio') {
  const app = studioSeedApp();
  const state = createSession({ id: sessionId, label: 'Forma Studio', view: 'studio', title: 'Studio chat', data: {}, app });
  state.panes.pane_design_seed = { id: 'pane_design_seed', view: 'canvas', title: app.designs.design_sand.name, data: { designId: 'design_sand' } };
  const tab = state.workspaces[0].tabs[0];
  tab.label = 'Launch assets'; tab.focusedPaneId = 'pane_inbox';
  tab.layout = { type: 'split', id: 'split_studio_seed', direction: 'right', ratio: 0.30, first: { type: 'pane', paneId: 'pane_inbox' }, second: { type: 'pane', paneId: 'pane_design_seed' } };
  return state;
}
