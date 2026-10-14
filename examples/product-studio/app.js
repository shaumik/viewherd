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
    if (!editor) throw new Error('Your unsaved copy is safe. Recover or discard it in Studio chat before continuing.');
    await editor.save();
  }
}
let running = false, assistantBusy = false;
async function run(task, message, { recoverDesignId } = {}) {
  if (running || assistantBusy) { notify('Let the assistant finish this turn first.'); return; }
  running = true;
  try { await saveOpenEditors(recoverDesignId); const result = await task(); if (message) notify(typeof message === 'function' ? message(result) : message); return result; }
  catch (error) { notify(error.message || 'That change could not be completed.', true); throw error; }
  finally { running = false; }
}
function handled(promise) { Promise.resolve(promise).catch(() => {}); }
async function studioAction(action, args = {}) {
  const pane = studioPane();
  if (!pane) throw new Error('Open Studio chat to continue.');
  return client.call('panel.action', { paneId: pane.id, action, args });
}
const client = createClient({
  baseUrl: '/viewherd', sessionId: 'product-studio',
  onConnection({ status }) {
    const connection = document.querySelector('.connection'); connection.dataset.status = status;
    document.getElementById('connection-label').textContent = status === 'connected' ? 'Live workspace' : status === 'connecting' ? 'Connecting' : 'Reconnecting';
  },
});

async function readAssistantStream(response, onEvent) {
  if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('The assistant returned an invalid stream. Try again.');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', received = 0, complete = false;
  function line(value) {
    const text = value.trim(); if (!text) return false;
    if (text.length > 131072) throw new Error('The assistant response was too large. Try a shorter request.');
    let event; try { event = JSON.parse(text); } catch { throw new Error('The assistant response was interrupted. Your workspace is safe.'); }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('The assistant returned an invalid event.');
    onEvent(event); return event.type === 'done';
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) { received += value.byteLength; if (received > 2097152) throw new Error('The assistant response was too large.'); buffer += decoder.decode(value, { stream: true }); }
      if (done) buffer += decoder.decode();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const value = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line(value)) { complete = true; return; }
      }
      if (buffer.length > 131072) throw new Error('The assistant response was too large.');
      if (done) { if (buffer.trim()) complete = line(buffer); if (!complete) throw new Error('The assistant disconnected before finishing. Your workspace is safe.'); return; }
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

function studioRenderer(host, initial) {
  let ctx = initial, disposed = false, sending = false, localTurn = null, streamController = null;
  let assistantMode = 'demo', model = null, assetSrc = null, streamError = null, scheduledScroll = null, expiryTimer = null;
  const infoController = new AbortController(), turnNodes = new Map();
  const root = el('section', 'studio chat-studio'); root.setAttribute('aria-label', 'Studio chat');
  const head = el('div', 'chat-header'), avatar = el('span', 'assistant-avatar'); avatar.append(icon('sparkle'));
  const heading = el('div', 'chat-heading'); heading.append(el('h1', '', 'Forma assistant'));
  const modeLabel = el('p', 'chat-mode', 'Connecting to the agent…'); heading.append(modeLabel);
  head.append(avatar, heading, el('span', 'chat-server-badge', 'SERVER'));
  const scroll = el('div', 'chat-scroll'), introduction = el('div', 'chat-intro');
  const asset = el('div', 'chat-attachment'), img = el('img'); img.alt = 'FORMA One headphones';
  const metadata = el('div', 'chat-attachment-meta'), assetName = el('strong'), assetCaption = el('span', '', 'Product photo · ready to use'); metadata.append(assetName, assetCaption);
  const file = el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; file.hidden = true;
  const upload = button('Replace', 'chat-replace', null, () => file.click()); upload.setAttribute('aria-label', 'Replace the product photo');
  asset.append(img, metadata, upload, file);
  introduction.append(asset, el('p', 'chat-welcome', "I've got your product photo. Tell me what you want to make — I'll build it in the workspace beside us."));
  const transcript = el('div', 'chat-transcript'); transcript.setAttribute('role', 'log'); transcript.setAttribute('aria-label', 'Conversation with Forma assistant'); transcript.setAttribute('aria-live', 'polite'); transcript.setAttribute('aria-relevant', 'additions text');
  const starters = el('div', 'chat-starters'), starterLabel = el('p', '', 'TRY ASKING'); starters.append(starterLabel);
  const create = button('Create two launch directions', 'chat-starter', 'arrow', () => send('Create two launch directions for this product.'));
  const dark = button('Make it midnight. Less noise. More you.', 'chat-starter', 'arrow', () => send('Make it midnight and change the headline to "Less noise. More you."'));
  starters.append(create, dark);
  const recovery = el('div', 'draft-recovery'); recovery.hidden = true;
  scroll.append(introduction, transcript, starters, recovery);
  const bottom = el('div', 'chat-bottom'), error = el('p', 'chat-error'); error.hidden = true; error.setAttribute('role', 'alert');
  const form = el('form', 'chat-composer'), input = el('textarea'); input.rows = 2; input.maxLength = 2000; input.placeholder = 'Ask the agent to change your workspace…'; input.setAttribute('aria-label', 'Message the assistant');
  const composeRow = el('div', 'chat-composer-row'), hint = el('span', 'chat-compose-hint', 'Enter to send');
  const sendButton = button('', 'chat-send', 'arrow'); sendButton.type = 'submit'; sendButton.setAttribute('aria-label', 'Send message'); composeRow.append(hint, sendButton); form.append(input, composeRow);
  const footnote = el('p', 'chat-footnote'); footnote.append(document.createTextNode('The agent calls Viewherd on the server. '));
  const sdkLink = el('a', '', 'Connect your own agent'); sdkLink.href = 'https://github.com/shaumik/viewherd/blob/main/docs/SDK.md'; sdkLink.target = '_blank'; sdkLink.rel = 'noopener noreferrer'; footnote.append(sdkLink);
  bottom.append(error, form, footnote); root.append(head, scroll, bottom); host.append(root);

  function nearBottom() { return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 72; }
  function scrollToLatest(force = false) {
    if (!force && !nearBottom()) return;
    if (scheduledScroll !== null) cancelAnimationFrame(scheduledScroll);
    scheduledScroll = requestAnimationFrame(() => { scheduledScroll = null; if (!disposed) scroll.scrollTop = scroll.scrollHeight; });
  }
  function activeTurn() {
    const chat = ctx.state.app.chat;
    return chat?.turns?.find(turn => turn.id === chat.activeTurnId && turn.status === 'running' && Number.isFinite(turn.expiresAt) && turn.expiresAt > Date.now());
  }
  function setBusy(value) {
    sending = value;
    const remote = activeTurn(), locked = value || !!remote; assistantBusy = locked;
    clearTimeout(expiryTimer); expiryTimer = null;
    if (remote) expiryTimer = setTimeout(() => { if (!disposed) { setBusy(sending); paintConversation(); } }, Math.min(2147483647, Math.max(1, remote.expiresAt - Date.now() + 1)));
    input.disabled = locked; sendButton.disabled = locked || !input.value.trim(); upload.disabled = locked; create.disabled = dark.disabled = locked;
    document.getElementById('reset-demo').disabled = locked;
    hint.textContent = locked ? value ? 'Agent is working…' : 'Another agent is working…' : 'Enter to send';
    form.dataset.busy = String(locked);
  }
  function makeTurn(turn) {
    const node = el('article', 'chat-turn'), user = el('div', 'chat-user-message'), reply = el('div', 'chat-assistant-message'), response = el('p', 'chat-response'), steps = el('div', 'chat-tool-steps'), status = el('p', 'chat-turn-status');
    reply.append(response, steps, status); node.append(user, reply);
    const entry = { node, user, response, steps, status, stepNodes: new Map() }; turnNodes.set(turn.id, entry); return entry;
  }
  function paintTurn(turn) {
    const entry = turnNodes.get(turn.id) || makeTurn(turn);
    entry.user.textContent = turn.message || '';
    entry.response.textContent = turn.reply || ''; entry.response.hidden = !turn.reply;
    const seen = new Set();
    for (const step of turn.steps || []) {
      if (!step || typeof step.id !== 'string') continue;
      seen.add(step.id); let row = entry.stepNodes.get(step.id);
      if (!row) { row = el('div', 'chat-tool-step'); row.append(el('span', 'chat-step-icon'), el('span', 'chat-step-label')); entry.stepNodes.set(step.id, row); entry.steps.append(row); }
      row.dataset.status = step.status;
      row.querySelector('.chat-step-icon').textContent = step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : '·';
      row.querySelector('.chat-step-label').textContent = step.label || 'Update workspace';
      if (step.error) row.title = step.error; else row.removeAttribute('title');
    }
    for (const [id, row] of entry.stepNodes) if (!seen.has(id)) { row.remove(); entry.stepNodes.delete(id); }
    entry.steps.hidden = !(turn.steps?.length);
    entry.status.hidden = turn.status === 'completed' || (!!turn.reply && turn.status !== 'failed');
    entry.status.textContent = turn.status === 'failed' ? 'This turn could not finish. Your changes are still in the workspace.' : turn.steps?.length ? 'Working in your workspace…' : 'Thinking…';
    entry.status.dataset.status = turn.status;
    return entry.node;
  }
  function paintConversation(force = false) {
    const follow = force || nearBottom(), remote = ctx.state.app.chat?.turns || [];
    const turns = remote.filter(turn => !localTurn || turn.id !== localTurn.id);
    if (localTurn) turns.push(localTurn);
    const seen = new Set();
    for (const turn of turns) {
      if (!turn || typeof turn.id !== 'string') continue;
      seen.add(turn.id); const node = paintTurn(turn);
      // Keep existing message nodes connected while streaming text and tool results.
      const previous = transcript.children[seen.size - 1]; if (previous !== node) transcript.insertBefore(node, previous || null);
    }
    for (const [id, entry] of turnNodes) if (!seen.has(id)) { entry.node.remove(); turnNodes.delete(id); }
    starters.hidden = turns.length > 0;
    introduction.classList.toggle('has-conversation', turns.length > 0);
    error.hidden = !streamError; error.textContent = streamError || '';
    if (follow) scrollToLatest(true);
  }
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
  async function send(value) {
    const message = (typeof value === 'string' ? value : input.value).trim();
    if (!message || sending || activeTurn() || running) return;
    if (message.length > 2000) { streamError = 'Keep your request under 2,000 characters.'; paintConversation(); return; }
    streamError = null; setBusy(true); input.value = ''; paintConversation();
    const requestId = crypto.randomUUID(), controller = new AbortController(); streamController = controller;
    const timeout = setTimeout(() => controller.abort(), 180000);
    let completed = false, failed = false;
    try {
      await saveOpenEditors();
      if (disposed) return;
      localTurn = { id: requestId, message, mode: assistantMode, status: 'running', reply: '', steps: [] }; paintConversation(true);
      const response = await fetch('/assistant', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ requestId, message }), signal: controller.signal });
      if (!response.ok) {
        let detail; try { detail = await response.json(); } catch {}
        throw new Error(detail?.error?.message || detail?.message || `The assistant could not start (${response.status}). Try again.`);
      }
      await readAssistantStream(response, event => {
        if (disposed) return;
        if (event.type === 'start') {
          if (typeof event.turnId !== 'string' || !event.turnId) throw new Error('The assistant returned an invalid turn.');
          const entry = turnNodes.get(localTurn.id); if (entry) { turnNodes.delete(localTurn.id); turnNodes.set(event.turnId, entry); }
          localTurn.id = event.turnId; localTurn.mode = event.mode; if (['demo', 'openai'].includes(event.mode)) { assistantMode = event.mode; modeLabel.textContent = event.mode === 'openai' ? `${model || 'OpenAI agent'} · runs on server` : 'Demo agent · runs on server'; }
        } else if (event.type === 'text') {
          if (typeof event.text !== 'string' || localTurn.reply.length + event.text.length > 20000) throw new Error('The assistant response was too large.');
          localTurn.reply += event.text;
        } else if (event.type === 'tool') {
          const step = event.step;
          if (!step || typeof step.id !== 'string' || typeof step.label !== 'string' || !['running', 'done', 'failed'].includes(step.status)) throw new Error('The assistant returned an invalid tool result.');
          const previous = localTurn.steps.findIndex(item => item.id === step.id);
          if (previous >= 0) localTurn.steps[previous] = step; else { if (localTurn.steps.length >= 12) throw new Error('The assistant returned too many tool steps.'); localTurn.steps.push(step); }
        } else if (event.type === 'done') {
          if (!event.turn || event.turn.id !== localTurn.id || !['completed', 'failed'].includes(event.turn.status)) throw new Error('The assistant returned an invalid completion.');
          localTurn = event.turn; completed = true; failed = event.turn.status === 'failed';
        } else if (event.type === 'error') {
          streamError = typeof event.message === 'string' ? event.message : 'The assistant could not finish this turn.';
        } else throw new Error('The assistant returned an unknown event.');
        paintConversation();
      });
      // Read the latest authoritative workspace immediately; SSE remains subscribed.
      try { await client.snapshot(); } catch { notify('The agent finished. Reconnecting to your live workspace…'); }
      const persisted = client.state?.app?.chat?.turns?.find(turn => turn.id === localTurn?.id);
      if (persisted && persisted.status !== 'running') localTurn = null;
      if (failed) input.value = message;
    } catch (failure) {
      if (disposed) return;
      streamError = failure.name === 'AbortError' ? 'The assistant connection timed out. Your workspace is safe. Try again.' : failure.message || 'The assistant connection was interrupted. Try again.';
      input.value = message;
      if (localTurn) localTurn.status = 'failed';
      try { await client.snapshot(); } catch {}
      const persisted = client.state?.app?.chat?.turns?.find(turn => turn.id === localTurn?.id);
      if (persisted && persisted.status !== 'running') localTurn = null;
    } finally {
      clearTimeout(timeout); if (streamController === controller) streamController = null;
      if (!disposed) { setBusy(false); paintConversation(); const focused = document.activeElement; if (completed && !failed && input.offsetParent !== null && (focused === document.body || form.contains(focused) || focused === create || focused === dark)) input.focus({ preventScroll: true }); }
      else assistantBusy = false;
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); handled(send()); });
  input.addEventListener('input', () => { sendButton.disabled = sending || !!activeTurn() || !input.value.trim(); input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 128)}px`; });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); handled(send()); } });
  file.addEventListener('change', async () => {
    const chosen = file.files?.[0]; if (!chosen || sending) return;
    streamError = null; upload.disabled = true;
    try { const src = await normalizePhoto(chosen); await run(() => ctx.action('upload', { src, name: chosen.name.trim().slice(0, 80) || 'Product photo' }), 'Your product photo is now in every direction.'); }
    catch (failure) { streamError = failure.message; paintConversation(); }
    finally { file.value = ''; if (!disposed) upload.disabled = sending || !!activeTurn(); }
  });
  fetch('/assistant', { credentials: 'same-origin', cache: 'no-store', signal: infoController.signal })
    .then(async response => { if (!response.ok) throw new Error('unavailable'); return response.json(); })
    .then(info => { if (disposed) return; assistantMode = info.mode === 'openai' ? 'openai' : 'demo'; model = typeof info.model === 'string' ? info.model : null; modeLabel.textContent = assistantMode === 'openai' ? `${model || 'OpenAI agent'} · runs on server` : 'Demo agent · runs on server'; })
    .catch(() => { if (!disposed) modeLabel.textContent = 'Agent connection unavailable'; });
  function update(next) {
    ctx = next; const app = ctx.state.app;
    if (assetSrc !== app.asset.src) { img.src = app.asset.src; assetSrc = app.asset.src; }
    img.alt = app.asset.name; assetName.textContent = app.asset.name;
    if (!sending && localTurn) {
      const persisted = app.chat?.turns?.find(turn => turn.id === localTurn.id);
      if (persisted && persisted.status !== 'running') localTurn = null;
    }
    setBusy(sending); paintConversation(); queueMicrotask(paintRecovery);
  }
  update(ctx);
  return { update, destroy() { disposed = true; infoController.abort(); streamController?.abort(); clearTimeout(expiryTimer); if (scheduledScroll !== null) cancelAnimationFrame(scheduledScroll); recoveryListeners.delete(paintRecovery); assistantBusy = false; document.getElementById('reset-demo').disabled = false; } };
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
      if (!savedDesign) throw new Error('This design was removed while saving. Your copy is preserved in Studio chat.');
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
    if (!design) { status.textContent = 'This design was removed elsewhere. Your unsaved copy is preserved in Studio chat.'; status.dataset.error = 'true'; saveButton.disabled = true; return; }
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
  client, tabBar: false, multiPaneBreakpoint: 0,
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
