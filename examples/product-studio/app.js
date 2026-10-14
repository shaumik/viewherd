import { createClient } from '/sdk/client/index.mjs';
import { mountWorkspace } from '/sdk/dom/index.mjs';
import { renderDesign, dimensionsFor, DESIGN_THEMES } from '/examples/product-studio/render.mjs';

const iconPaths = {
  arrow: 'M3 8h10M9 4l4 4-4 4',
  sparkle: 'm8 1 1.6 4.9L14 8l-4.4 2.1L8 15l-1.6-4.9L2 8l4.4-2.1Z',
  check: 'm3 8 3 3 7-7',
  edit: 'm3 11 1 2 2-1 7-7-3-3-7 7ZM9 3l3 3',
  download: 'M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3',
  panels: 'M2 3h12v10H2ZM7 3v10',
  image: 'M2 2h12v12H2Zm1 10 4-5 3 3 2-2 2 4M11 5h.01',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.25');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', iconPaths[name] || iconPaths.arrow);
  svg.append(path); return svg;
}
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function button(label, className, iconName, callback) {
  const node = el('button', className); node.type = 'button';
  if (iconName) node.append(icon(iconName)); node.append(el('span', '', label));
  if (callback) node.addEventListener('click', callback);
  return node;
}
let toastTimer;
function notify(message, error = false) {
  const node = document.getElementById('toast'); node.textContent = message; node.dataset.error = String(error); node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, error ? 6500 : 3800);
}
const editDrafts = new Map(), editors = new Map(), recoveryListeners = new Set();
function refreshRecovery() { for (const callback of recoveryListeners) callback(); }
const copyFields = ['theme', 'headline', 'subhead', 'cta', 'format'];
const designKey = design => JSON.stringify(copyFields.map(key => design?.[key]));
function currentDesign(ctx) { return ctx.state.app.designs[ctx.pane.data.designId]; }
function studioPane() { return Object.values(client.state?.panes || {}).find(pane => pane.view === 'studio'); }
async function saveOpenEditors(recoverDesignId) {
  for (const [id, draft] of editDrafts) {
    if (!draft.dirty) continue;
    const editor = editors.get(id);
    if (!editor && id === recoverDesignId) continue;
    if (!editor) throw new Error('Your unsaved copy is safe. Recover or discard it in Creative brief before continuing.');
    await editor.save();
  }
}
let running = false;
async function run(task, message, { recoverDesignId } = {}) {
  if (running) return;
  running = true;
  try { await saveOpenEditors(recoverDesignId); const result = await task(); if (message) notify(typeof message === 'function' ? message(result) : message); return result; }
  catch (error) { notify(error.message || 'That change could not be completed.', true); throw error; }
  finally { running = false; }
}
function handled(promise) { Promise.resolve(promise).catch(() => {}); }
async function studioAction(action, args = {}) {
  const pane = studioPane();
  if (!pane) throw new Error('Open the creative brief panel to continue.');
  return client.call('panel.action', { paneId: pane.id, action, args });
}
const client = createClient({
  baseUrl: '/viewherd', sessionId: 'product-studio',
  onConnection({ status }) {
    const connection = document.querySelector('.connection'); connection.dataset.status = status;
    document.getElementById('connection-label').textContent = status === 'connected' ? 'Live workspace' : status === 'connecting' ? 'Connecting' : 'Reconnecting';
  },
});

function studioRenderer(host, initial) {
  let ctx = initial, disposed = false, busy = false;
  const root = el('div', 'studio'), body = el('div', 'studio-content');
  body.append(el('div', 'overline', 'A product. A point of view.'), el('h1', 'studio-title', 'Make your\nnext launch.'), el('p', 'studio-description', 'Turn one product photo into a campaign worth stopping for.'));
  const asset = el('div', 'asset-card'), img = el('img'); img.alt = 'FORMA One headphones, the source product photo';
  const file = el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; file.hidden = true;
  const upload = button('Replace', 'asset-change', null, () => file.click()); upload.setAttribute('aria-label', 'Replace the product photo');
  asset.append(img, el('span', 'asset-card-label', 'Your source image'), upload, file);
  const meta = el('div', 'asset-meta'), assetName = el('span', 'asset-name'), source = el('span', '', 'PNG / WebP'); meta.append(assetName, source);
  const error = el('p', 'upload-error'); error.hidden = true;
  body.append(asset, meta, error, el('div', 'brief-rule'), el('p', 'brief-label', 'THE BRIEF'), el('p', 'brief-copy', 'Launch FORMA One. Quiet confidence. Beautiful sound. Make two directions, then make one your own.'));
  const create = button('Create two directions', 'primary-button', 'sparkle', () => command('createDirections', {}, 'Two directions, two live canvases.'));
  const list = el('div', 'prompt-list');
  const refine = button('Make it midnight', 'prompt-button', 'arrow', () => command('refine', { theme: 'midnight', headline: 'Less noise.\nMore you.', subhead: 'Your world. Your volume. Your everyday escape.', cta: 'Find your quiet' }, 'A new palette and new copy, applied to the live canvas.'));
  const inspect = button('Let me fine-tune it', 'prompt-button', 'edit', () => command('inspect', {}, 'Opened editing controls beside your design.'));
  const compare = button('Compare both directions', 'prompt-button', 'panels', () => command('compare', {}, 'Both directions are back. Your edits are still here.'));
  const exportButton = button('Export the campaign', 'prompt-button', 'download', () => command('export', {}, 'Your campaign is ready to download.'));
  list.append(refine, inspect, compare, exportButton);
  const actionLabel = el('div', 'action-label'); actionLabel.append(icon('check'), el('span', '', 'Every change happens in the live workspace'));
  const recovery = el('div', 'draft-recovery'); recovery.hidden = true;
  body.append(create, list, actionLabel, recovery);
  const history = el('div', 'studio-history'), historyHeader = el('div', 'history-head'), historyList = el('div', 'history-list');
  historyHeader.append(el('span', 'history-indicator'), el('span', '', 'STUDIO ACTIVITY'));
  const footnote = el('p', 'studio-footnote'); footnote.append(document.createTextNode('Scripted demo · '));
  const sdkLink = el('a', '', 'Connect your own agent'); sdkLink.href = 'https://github.com/shaumik/viewherd/blob/main/docs/SDK.md'; sdkLink.target = '_blank'; sdkLink.rel = 'noopener noreferrer'; footnote.append(sdkLink);
  history.append(historyHeader, historyList, footnote); root.append(body, history); host.append(root);
  const controls = [create, refine, inspect, compare, exportButton, upload];
  function paintRecovery() {
    if (disposed) return;
    const orphan = [...editDrafts].find(([id, draft]) => draft.dirty && !editors.has(id));
    recovery.hidden = !orphan; recovery.replaceChildren(); if (!orphan) return;
    const [id, draft] = orphan, exists = !!ctx.state.app.designs[id];
    recovery.append(el('p', 'brief-label', 'Your unsaved copy is safe.'), el('p', 'recovery-note', exists ? 'The editor closed elsewhere. Resume your draft before continuing.' : 'The original design was removed elsewhere. Copy your draft or discard it to continue.'));
    const copy = el('textarea', 'recovery-copy'); copy.readOnly = true; copy.rows = 4; copy.setAttribute('aria-label', 'Preserved unsaved campaign copy'); copy.value = [draft.values.headline, draft.values.subhead, draft.values.cta].join('\n\n'); recovery.append(copy);
    const resume = button('Resume editing', 'secondary-button', null, () => handled(run(async () => { await studioAction('select', { designId: id }); return studioAction('inspect'); }, 'Your unsaved draft is back.', { recoverDesignId: id }))); resume.hidden = !exists;
    const discard = button('Discard local draft', 'secondary-button', null, () => { editDrafts.delete(id); refreshRecovery(); notify('Local draft discarded. The studio is ready.'); });
    const row = el('div', 'recovery-actions'); row.append(resume, discard); recovery.append(row);
  }
  recoveryListeners.add(paintRecovery);
  function setBusy(value) { busy = value; controls.forEach(control => { control.disabled = value; }); create.querySelector('span').textContent = value ? 'Working on your studio…' : 'Create two directions'; }
  async function command(action, args, message) {
    if (busy) return; setBusy(true);
    try { await run(() => ctx.action(action, args), message); } catch {} finally { if (!disposed) setBusy(false); }
  }
  file.addEventListener('change', async () => {
    const chosen = file.files?.[0]; if (!chosen) return;
    error.hidden = true; setBusy(true);
    try {
      const src = await normalizePhoto(chosen);
      await run(() => ctx.action('upload', { src, name: chosen.name.trim().slice(0, 80) || 'Product photo' }), 'Your product photo is now in every direction.');
    } catch (failure) { error.textContent = failure.message; error.hidden = false; } finally { file.value = ''; if (!disposed) setBusy(false); }
  });
  let historySequence = null, assetSrc = null;
  function update(next) {
    ctx = next; const app = ctx.state.app;
    if (assetSrc !== app.asset.src) { img.src = app.asset.src; assetSrc = app.asset.src; }
    img.alt = app.asset.name; assetName.textContent = app.asset.name;
    const entries = app.history || [];
    if (historySequence !== app.sequence) {
      historySequence = app.sequence; historyList.replaceChildren();
      if (!entries.length) historyList.append(el('p', 'history-empty', 'Your brief controls the canvas. Start with two directions.'));
      for (const entry of entries.slice(-3).reverse()) { const row = el('div', 'history-entry'); row.append(icon('check'), el('span', '', entry.label)); historyList.append(row); }
    }
    queueMicrotask(paintRecovery);
  }
  update(ctx); return { update, destroy() { disposed = true; recoveryListeners.delete(paintRecovery); } };
}

function canvasRenderer(host, initial) {
  let ctx = initial, signature = null, busy = false;
  const root = el('div', 'canvas-panel'), toolbar = el('div', 'canvas-toolbar'), label = el('div', 'canvas-label'), dot = el('span', 'theme-indicator'), name = el('span'), format = el('span', 'canvas-format');
  label.append(dot, name, format);
  const inspect = button('Edit design', 'text-button', 'edit', () => act('inspect', 'Open controls. Make it yours.'));
  toolbar.append(label, inspect);
  const stage = el('div', 'canvas-stage'), art = el('div', 'artboard'); stage.append(art);
  const footer = el('div', 'canvas-footer'), size = el('span', 'canvas-size');
  const keep = button('Keep this direction', 'canvas-keep', 'check', () => act('select', 'One winning direction. The comparison panel is closed.'));
  const selected = el('span', 'canvas-selected'); selected.append(icon('check'), el('span', '', 'Selected direction'));
  const exportButton = button('Export', 'canvas-export', null, () => {
    handled(run(async () => { await ctx.action('select', {}); return studioAction('export'); }, 'Ready to take your campaign with you.'));
  });
  footer.append(size, keep, selected, exportButton); root.append(toolbar, stage, footer); host.append(root);
  async function act(action, message) {
    if (busy) return; busy = true; inspect.disabled = keep.disabled = true;
    try { await run(() => ctx.action(action, {}), message); } catch {} finally { busy = false; inspect.disabled = keep.disabled = false; }
  }
  function update(next) {
    ctx = next; const design = currentDesign(ctx); if (!design) return;
    const app = ctx.state.app, dimensions = dimensionsFor(design.format), theme = DESIGN_THEMES.find(item => item.id === design.theme);
    name.textContent = design.name; format.textContent = design.format === 'story' ? 'Story' : 'Social'; dot.style.background = theme?.background || '#eee';
    size.textContent = `${dimensions.width} × ${dimensions.height}`;
    const hasComparison = Object.values(ctx.state.panes).filter(pane => pane.view === 'canvas').length > 1;
    keep.hidden = !hasComparison; selected.hidden = hasComparison; exportButton.hidden = hasComparison;
    const key = JSON.stringify(design) + app.asset.src;
    if (key !== signature) {
      art.innerHTML = renderDesign(design, app.asset); art.dataset.format = design.format;
      const svg = art.querySelector('svg'); if (svg) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${design.name} campaign: ${design.headline.replace(/\n/g, ' ')}`); }
      if (signature !== null) { art.classList.remove('changed'); void art.offsetWidth; art.classList.add('changed'); }
      signature = key;
    }
  }
  update(ctx); return { update };
}

function inspectorRenderer(host, initial) {
  let ctx = initial, disposed = false, saving = false;
  const designId = initial.pane.data.designId;
  let draft = editDrafts.get(designId);
  if (!draft) { draft = { values: pickDesign(currentDesign(ctx)), base: designKey(currentDesign(ctx)), dirty: false }; editDrafts.set(designId, draft); }
  const root = el('form', 'inspector'); root.append(el('div', 'overline', 'Your creative control'), el('h2', 'inspector-title', 'Make it yours.'), el('p', 'inspector-description', 'The artboard stays live. Your draft stays yours until you save.'));
  const inputs = {}, themeField = el('div', 'field'); themeField.append(el('span', 'field-label', 'Color direction'));
  const themeOptions = el('div', 'theme-options'), themeButtons = new Map();
  for (const theme of DESIGN_THEMES) {
    const control = button(theme.label, 'theme-option', null, () => { draft.values.theme = theme.id; changed(); paintThemes(); });
    const swatch = el('span', 'theme-swatch'); swatch.style.background = theme.background; control.prepend(swatch);
    control.setAttribute('aria-label', `${theme.label} color direction`); themeButtons.set(theme.id, control); themeOptions.append(control);
  }
  themeField.append(themeOptions); root.append(themeField);
  function field(key, label, tag = 'input', maxLength) {
    const wrapper = el('label', 'field'); wrapper.append(el('span', 'field-label', label));
    const input = el(tag); input.name = key; if (maxLength) input.maxLength = maxLength;
    if (tag === 'textarea') input.rows = key === 'headline' ? 2 : 3;
    input.value = draft.values[key]; inputs[key] = input; wrapper.append(input); root.append(wrapper);
    input.addEventListener('input', () => { draft.values[key] = input.value; changed(); }); return input;
  }
  field('headline', 'Headline', 'textarea', 80); field('subhead', 'Supporting copy', 'textarea', 140); field('cta', 'Call to action', 'input', 32);
  const size = field('format', 'Canvas size', 'select');
  for (const [value, label] of [['square', 'Social square · 1080 × 1080'], ['story', 'Story · 1080 × 1920']]) { const option = el('option', '', label); option.value = value; size.append(option); }
  size.value = draft.values.format;
  size.addEventListener('change', () => { draft.values.format = size.value; changed(); });
  const badge = el('span', 'dirty-badge', 'Unsaved changes'), row = el('div', 'inspector-save-row');
  const saveButton = button('Save design', 'primary-button', 'check'); saveButton.type = 'submit';
  const discard = button('Use latest', 'secondary-button', null, () => { draft.values = pickDesign(currentDesign(ctx)); draft.base = designKey(currentDesign(ctx)); draft.dirty = false; paintValues(); status.textContent = 'Latest saved design restored.'; status.dataset.error = 'false'; });
  row.append(saveButton, discard); const status = el('p', 'form-message'); status.setAttribute('role', 'status'); root.append(badge, row, status); host.append(root);
  function changed() { draft.dirty = designKey(draft.values) !== draft.base; editDrafts.set(designId, draft); badge.hidden = !draft.dirty; saveButton.disabled = !draft.dirty || saving; status.textContent = draft.dirty ? 'Changes are saved when you choose Save design.' : ''; status.dataset.error = 'false'; }
  function paintThemes() { for (const [id, control] of themeButtons) control.setAttribute('aria-pressed', String(id === draft.values.theme)); }
  function paintValues() { for (const [key, input] of Object.entries(inputs)) input.value = draft.values[key]; paintThemes(); changed(); }
  function lock(value) { saving = value; draft.saving = value; for (const input of Object.values(inputs)) input.disabled = value; for (const control of themeButtons.values()) control.disabled = value; discard.disabled = value; saveButton.disabled = value || !draft.dirty; saveButton.querySelector('span').textContent = value ? 'Saving…' : 'Save design'; }
  async function save() {
    if (!draft.dirty) return;
    if (saving || draft.saving) throw new Error('Your design is still saving. Try again in a moment.');
    if (designKey(currentDesign(ctx)) !== draft.base) {
      status.textContent = 'This design changed elsewhere. Your draft is safe. Choose Use latest to review the new version.'; status.dataset.error = 'true';
      throw new Error('This design changed elsewhere. Your unsaved copy is preserved in Edit design.');
    }
    lock(true);
    try {
      // A pane-focus change can advance the revision without editing this design.
      // Retry harmless conflicts, but retain the draft when its saved design changed.
      for (let attempt = 0; ; attempt++) {
        try { await ctx.action('update', { ...draft.values }, { expectedRevision: ctx.state.revision }); break; }
        catch (error) {
          if (attempt >= 2 || error.code !== 'revision_conflict' || designKey(currentDesign(ctx)) !== draft.base) throw error;
        }
      }
      const savedDesign = client.state?.app?.designs?.[designId];
      if (!savedDesign) throw new Error('This design was removed while saving. Your copy is preserved in Creative brief.');
      draft.values = pickDesign(savedDesign); draft.base = designKey(savedDesign); draft.dirty = false;
      if (!disposed) { paintValues(); status.textContent = 'Saved. Your live artboard has been updated.'; status.dataset.error = 'false'; }
    } catch (error) { if (!disposed) { status.textContent = error.message || 'Could not save. Your draft is still here.'; status.dataset.error = 'true'; } throw error; }
    finally {
      draft.saving = false;
      if (!disposed) lock(false);
      else {
        const mounted = editors.get(designId);
        if (mounted) mounted.refresh();
        else if (!draft.dirty) editDrafts.delete(designId);
        refreshRecovery();
      }
    }
  }
  root.addEventListener('submit', event => { event.preventDefault(); handled(save().then(() => notify('Saved to your live artboard.')).catch(error => { notify(error.message, true); throw error; })); });
  const editor = { save, dirty: () => draft.dirty, refresh() { paintValues(); lock(!!draft.saving); } }; editors.set(designId, editor); refreshRecovery();
  function update(next) {
    ctx = next;
    const design = currentDesign(ctx);
    if (!design) { status.textContent = 'This design was removed elsewhere. Your unsaved copy is preserved in Creative brief.'; status.dataset.error = 'true'; saveButton.disabled = true; return; }
    if (!draft.dirty && !saving) { draft.values = pickDesign(design); draft.base = designKey(design); paintValues(); }
  }
  paintValues(); lock(!!draft.saving); return { update, destroy() { disposed = true; if (editors.get(designId) === editor) editors.delete(designId); if (!draft.dirty && !draft.saving) editDrafts.delete(designId); refreshRecovery(); } };
}
function pickDesign(design) { return Object.fromEntries(copyFields.map(key => [key, design?.[key] || (key === 'theme' ? 'sand' : key === 'format' ? 'square' : '')])); }

function deliverablesRenderer(host, initial) {
  let ctx = initial, signature = null, disposed = false;
  const root = el('div', 'deliverables'), symbol = el('div', 'export-symbol'); symbol.append(icon('download'));
  root.append(symbol, el('div', 'overline', 'Ready for the world'), el('h2', 'deliverables-title', 'Your next\nlaunch, sorted.'), el('p', 'deliverables-description', 'Real assets. Your product. Your copy. Take the design anywhere.'));
  const preview = el('div', 'export-preview'); root.append(preview);
  const buttons = [];
  function fileRow(type, title, info) {
    const row = el('div', 'file-row'), description = el('div', 'file-description'), name = el('div', 'file-name', title), detail = el('div', 'file-info', info);
    description.append(name, detail);
    const download = button('', 'download-button', 'download', () => performDownload(type)); download.setAttribute('aria-label', `Download ${type.toUpperCase()} campaign`);
    buttons.push(download); row.append(el('div', 'file-icon', type.toUpperCase()), description, download); root.append(row); return detail;
  }
  const pngInfo = fileRow('png', 'Campaign image', '1080 × 1080 · Ready to post');
  fileRow('svg', 'Editable artwork', 'Vector · Product image included');
  root.append(el('p', 'deliverable-note', 'Both files are self-contained. No account, extra fonts, or image links needed.'));
  const downloadAll = button('Download campaign', 'primary-button', 'download', () => performDownload('png')); buttons.push(downloadAll); root.append(downloadAll);
  const bottom = el('p', 'deliverables-bottom'); bottom.append(el('strong', '', 'Built with Viewherd.'), document.createTextNode(' The brief created panels, changed the design, and prepared the export. Your own agent can do the same.')); root.append(bottom); host.append(root);
  async function performDownload(type) {
    buttons.forEach(control => { control.disabled = true; });
    try {
      await saveOpenEditors();
      const response = await ctx.action('export', {}), result = response.result;
      if (type === 'svg') downloadBlob(new Blob([result.svg], { type: 'image/svg+xml' }), result.filename);
      else { const png = await svgToPng(result.svg, result.width, result.height); downloadBlob(png, result.filename.replace(/\.svg$/, '.png')); }
      notify(`${type.toUpperCase()} campaign downloaded.`);
    } catch (error) { notify(error.message || 'The file could not be downloaded.', true); }
    finally { if (!disposed) buttons.forEach(control => { control.disabled = false; }); }
  }
  function update(next) {
    ctx = next; const design = currentDesign(ctx), key = JSON.stringify(design) + ctx.state.app.asset.src;
    if (key !== signature) { preview.innerHTML = renderDesign(design, ctx.state.app.asset); signature = key; }
    const dimensions = dimensionsFor(design.format); pngInfo.textContent = `${dimensions.width} × ${dimensions.height} · Ready to post`;
  }
  update(ctx); return { update, destroy() { disposed = true; } };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = el('a'); anchor.href = url; anchor.download = filename; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function svgToPng(svg, width, height) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('This browser cannot create PNG images. Download the SVG instead.');
    context.drawImage(image, 0, 0, width, height);
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed. Download the SVG instead.')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}
async function normalizePhoto(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (file.size > 15 * 1024 * 1024) throw new Error('Choose a product image smaller than 15 MB.');
  const url = URL.createObjectURL(file), image = new Image();
  try {
    image.src = url; await image.decode();
    let size = 1000, quality = 0.85;
    for (let attempt = 0; attempt < 10; attempt++) {
      const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d'); if (!context) throw new Error('This browser cannot prepare the image.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const src = canvas.toDataURL('image/webp', quality);
      if (src.length <= 120000 && src.startsWith('data:image/')) return src;
      if (quality > 0.45) quality -= 0.15; else { size = Math.round(size * 0.75); quality = 0.7; }
    }
    throw new Error('This image is too detailed. Choose a smaller product photo.');
  } catch (error) { if (error instanceof DOMException) throw new Error('This image could not be opened. Choose another photo.'); throw error; }
  finally { URL.revokeObjectURL(url); }
}

mountWorkspace(document.getElementById('workspace'), {
  client, tabBar: false,
  panels: {
    studio: { mount: studioRenderer }, canvas: { mount: canvasRenderer },
    inspector: { mount: inspectorRenderer }, deliverables: { mount: deliverablesRenderer },
  },
  onPaneClose(pane, ctx) {
    if (pane.view === 'studio') return;
    if (pane.view === 'inspector' && editDrafts.get(pane.data.designId)?.dirty) {
      notify('Save your changes or choose Use latest before closing this editor.', true); return;
    }
    return run(() => pane.view === 'canvas' ? ctx.action('remove', {}) : client.call('pane.close', { paneId: pane.id }));
  },
});
document.getElementById('reset-demo').addEventListener('click', () => {
  handled(run(async () => { await studioAction('reset'); editDrafts.clear(); }, 'A fresh brief. Make something good.'));
});
document.getElementById('retry-connect').addEventListener('click', () => location.reload());
window.addEventListener('beforeunload', event => {
  if ([...editDrafts.values()].some(draft => draft.dirty)) { event.preventDefault(); event.returnValue = ''; }
});
client.snapshot().catch(error => { document.getElementById('boot-error').hidden = false; notify(error.message || 'This studio could not connect.', true); });
