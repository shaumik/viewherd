import { createClient } from '/sdk/client/index.mjs';
import { mountWorkspace } from '/sdk/dom/index.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icons = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  customer: '<circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6zM13 6l5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h3"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  note: '<path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.arrow}</svg>`;
const time = value => value ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '';
const shortDate = value => value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: 'UTC' } : {}) }).format(new Date(value)) : '';
const money = (amount, currency = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(amount) || 0);
const statusLabel = value => ({ open: 'Open', draft: 'Draft', pending: 'Pending', resolved: 'Resolved' }[value] || value);
const ticketForPane = ctx => ctx.state.app?.tickets?.[ctx.pane.data?.ticketId];
const accountForTicket = (state, ticket) => state.app?.accounts?.[ticket?.accountId];
const findPane = (state, type, ticketId) => Object.values(state?.panes || {}).find(pane => pane.view === type && (!ticketId || pane.data?.ticketId === ticketId));
const newestState = (...states) => states.filter(Boolean).reduce((current, candidate) => candidate.revision >= current.revision ? candidate : current);

let client;
let workspace;
let state;
let toastTimer;
let currentDrawer;
let drawerReturnFocus;
let workflowRunning = false;
let workflowRun = 0;
let workflowSteps = [];
let workflowCalls = [];
const draftGuards = new Map();
const noteDrafts = new Map();

function toast(message, error = false) {
  const element = $('#toast');
  clearTimeout(toastTimer);
  element.textContent = message;
  element.classList.toggle('toast-error', error);
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 6000 : 3500);
}

function readableError(error) {
  if (error?.code === 'revision_conflict') return 'The workspace changed. Please try that action again.';
  if (error?.code === 'unauthorized' || error?.code === 'forbidden') return 'Your session is not authorized. Reload to reconnect.';
  return error?.message || 'We could not complete that action. Please try again.';
}

async function perform(button, operation) {
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.classList.add('is-busy'); }
  try { return await operation(); }
  catch (error) { toast(readableError(error), true); return undefined; }
  finally { if (button?.isConnected) { button.disabled = false; button.classList.remove('is-busy'); } }
}

async function action(paneId, name, args = {}, options) {
  if (['open', 'openCustomer', 'prepareReply', 'reset'].includes(name)) {
    for (const save of draftGuards.values()) {
      if (!await save()) throw new Error('Save or resolve your reply draft before changing this conversation.');
    }
  }
  return client.call('panel.action', { paneId, action: name, args }, options);
}

function setConnection(connection) {
  const status = typeof connection === 'string' ? connection : connection?.status || connection?.state || 'connecting';
  const live = ['connected', 'open', 'online', 'live'].includes(status);
  $('#connection-dot').classList.toggle('is-live', live);
  $('#connection-label').textContent = live ? 'Live workspace' : status === 'closed' ? 'Offline' : 'Reconnecting';
}

function syncGlobal(nextState) {
  state = nextState;
  const ticket = ticketForPane({ state, pane: findPane(state, 'ticket') || {} });
  const target = $('#workflow-target');
  target.innerHTML = ticket ? `<span class="avatar avatar-sm">${escapeHTML(ticket.customer?.initials || ticket.customer?.name?.slice(0, 1))}</span><div><strong>${escapeHTML(ticket.customer?.name)}</strong><span>${escapeHTML(ticket.id)} · ${escapeHTML(ticket.subject)}</span></div>` : '<span>Select a ticket to start.</span>';
  $('#workflow-start').disabled = workflowRunning || !ticket;
}

function mountInbox(host, initialCtx) {
  let ctx = initialCtx;
  let query = initialCtx.pane.data?.query || '';
  let filter = initialCtx.pane.data?.status || 'all';
  let timer;
  let dirty = false;
  host.innerHTML = `<section class="relay-inbox"><header class="inbox-heading"><div><h1>Your inbox</h1><span class="inbox-total"></span></div><span class="inbox-team">Support</span></header><label class="inbox-search">${icon('search')}<input type="search" placeholder="Search tickets" aria-label="Search tickets" maxlength="200" value="${escapeHTML(query)}"><kbd>/</kbd></label><div class="inbox-filters" role="group" aria-label="Filter tickets"><button type="button" data-filter="all">All</button><button type="button" data-filter="open">Open</button><button type="button" data-filter="pending">Pending</button><button type="button" data-filter="resolved">Resolved</button></div><div class="ticket-list" aria-label="Tickets"></div><div class="inbox-bottom"><span class="team-dot"></span>Assigned to the support team</div></section>`;
  const input = $('input', host);
  const list = $('.ticket-list', host);
  const rows = new Map();

  function render() {
    const tickets = Object.values(ctx.state.app?.tickets || {});
    const selected = findPane(ctx.state, 'ticket')?.data?.ticketId;
    $('.inbox-total', host).textContent = `${tickets.filter(ticket => ticket.status !== 'resolved').length} active conversations`;
    host.querySelectorAll('[data-filter]').forEach(button => { button.classList.toggle('is-active', button.dataset.filter === filter); button.setAttribute('aria-pressed', String(button.dataset.filter === filter)); });
    const needle = query.trim().toLocaleLowerCase();
    const filtered = tickets.filter(ticket => (filter === 'all' || ticket.status === filter || filter === 'open' && ticket.status === 'draft') && (!needle || [ticket.id, ticket.customer?.name, ticket.subject, ticket.preview, accountForTicket(ctx.state, ticket)?.name].join(' ').toLocaleLowerCase().includes(needle)));
    const visibleIds = new Set(filtered.map(ticket => ticket.id));
    for (const [id, row] of rows) if (!visibleIds.has(id)) { row.remove(); rows.delete(id); }
    $('.inbox-empty', list)?.remove();
    if (!filtered.length) { list.innerHTML = `<div class="inbox-empty">${icon('search')}<strong>No matching tickets</strong><p>Try another search or filter.</p></div>`; return; }
    filtered.forEach((ticket, index) => {
      let row = rows.get(ticket.id);
      if (!row) { row = document.createElement('button'); row.type = 'button'; row.dataset.ticket = ticket.id; rows.set(ticket.id, row); }
      row.className = `ticket-row ${selected === ticket.id ? 'is-selected' : ''}`;
      if (selected === ticket.id) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
      const content = `<div class="ticket-row-top"><span class="avatar avatar-sm avatar-${escapeHTML((ticket.category || 'other').toLowerCase())}">${escapeHTML(ticket.customer?.initials || ticket.customer?.name?.slice(0, 1))}</span><span class="ticket-customer">${escapeHTML(ticket.customer?.name)}</span><time datetime="${escapeHTML(ticket.updatedAt || ticket.createdAt)}">${time(ticket.updatedAt || ticket.createdAt)}</time></div><strong class="ticket-subject">${escapeHTML(ticket.subject)}</strong><p>${escapeHTML(ticket.preview)}</p><div class="ticket-row-bottom"><span>${escapeHTML(accountForTicket(ctx.state, ticket)?.name || ticket.customer?.email)}</span><span class="ticket-state state-${escapeHTML(ticket.status)}"><i></i>${escapeHTML(statusLabel(ticket.status))}</span></div>`;
      if (row.relayContent !== content) { row.innerHTML = content; row.relayContent = content; }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    });
  }
  async function saveFilter() {
    const expectedQuery = query;
    const expectedFilter = filter;
    try { await ctx.action('filter', { query: expectedQuery, status: expectedFilter }); if (query === expectedQuery && filter === expectedFilter) dirty = false; }
    catch (error) { toast(readableError(error), true); }
  }
  input.addEventListener('input', () => { query = input.value; dirty = true; render(); clearTimeout(timer); timer = setTimeout(saveFilter, 300); });
  host.addEventListener('click', event => {
    const filterButton = event.target.closest('[data-filter]');
    if (filterButton) { filter = filterButton.dataset.filter; dirty = true; render(); clearTimeout(timer); void saveFilter(); }
    const row = event.target.closest('[data-ticket]');
    if (row) void perform(row, () => action(ctx.pane.id, 'open', { ticketId: row.dataset.ticket }));
  });
  render();
  return {
    update(nextCtx) { ctx = nextCtx; if (!dirty && document.activeElement !== input) { query = ctx.pane.data?.query || ''; filter = ctx.pane.data?.status || 'all'; input.value = query; } render(); },
    destroy() { clearTimeout(timer); },
  };
}

function mountTicket(host, initialCtx) {
  let ctx = initialCtx;
  let currentId;
  let threadSignature;
  let notesSignature;

  function build() {
    const ticket = ticketForPane(ctx);
    if (!ticket) { host.innerHTML = '<div class="panel-empty"><h2>Select a conversation</h2><p>Your customer context and reply will stay together.</p></div>'; return; }
    currentId = ticket.id;
    threadSignature = undefined;
    notesSignature = undefined;
    host.innerHTML = `<article class="relay-ticket"><header class="ticket-toolbar"><div class="ticket-reference"><span>${escapeHTML(ticket.id)}</span><span class="reference-dot"></span><span>${escapeHTML(ticket.category || 'Support')}</span></div><label class="status-select"><span class="sr-only">Ticket status</span><i></i><select aria-label="Ticket status"><option value="open">Open</option><option value="pending">Pending</option><option value="resolved">Resolved</option></select>${icon('down')}</label></header><div class="ticket-scroll"><header class="conversation-heading"><div class="conversation-person"><span class="avatar avatar-lg">${escapeHTML(ticket.customer?.initials || ticket.customer?.name?.slice(0, 1))}</span><div><h2>${escapeHTML(ticket.subject)}</h2><p><strong>${escapeHTML(ticket.customer?.name)}</strong><span class="person-email">${escapeHTML(ticket.customer?.email)}</span></p></div></div><div class="conversation-meta"><span class="account-name"></span><span class="meta-divider"></span><span>Assigned to <strong>${escapeHTML(ticket.assignee || 'Alex')}</strong></span></div></header><div class="conversation-thread"></div><section class="internal-notes" hidden><h3>${icon('lock')}Internal notes</h3><div class="notes-list"></div></section><details class="add-note"><summary>${icon('note')}Add an internal note</summary><form><label class="sr-only" for="note-${escapeHTML(ctx.pane.id)}">Internal note</label><textarea id="note-${escapeHTML(ctx.pane.id)}" placeholder="Add context for your team…" rows="3" maxlength="4000"></textarea><div><span>Only visible to your team</span><button class="button button-small" type="submit">Save note</button></div></form></details></div><footer class="ticket-footer"><button type="button" class="button button-quiet" data-ticket-action="context">${icon('customer')}<span>Customer context</span></button><div class="ticket-reply-actions"><button type="button" class="button button-quiet draft-button" data-ticket-action="draft">${icon('edit')}<span>Draft reply</span></button><button type="button" class="button button-primary" data-ticket-action="assist">${icon('sparkle')}<span>Assist with reply</span></button></div></footer></article>`;
    $('.status-select select', host).addEventListener('change', event => {
      const select = event.target;
      const intendedStatus = select.value;
      void perform(select, async () => {
        try { await ctx.action('setStatus', { status: intendedStatus }, { expectedRevision: ctx.state.revision }); toast(`Ticket moved to ${statusLabel(intendedStatus).toLowerCase()}.`); }
        catch (error) { const saved = ticketForPane(ctx)?.status; select.value = saved === 'draft' ? 'open' : saved || 'open'; throw error; }
      });
    });
    const noteInput = $('.add-note textarea', host);
    noteInput.value = noteDrafts.get(ticket.id) || '';
    noteInput.addEventListener('input', () => noteDrafts.set(ticket.id, noteInput.value));
    $('.add-note form', host).addEventListener('submit', event => {
      event.preventDefault();
      const input = $('textarea', event.currentTarget);
      const text = input.value.trim();
      if (!text) return;
      void perform($('button', event.currentTarget), async () => {
        await ctx.action('addNote', { text }, { expectedRevision: ctx.state.revision });
        if ((noteDrafts.get(ticket.id) || '').trim() === text) { noteDrafts.delete(ticket.id); if (input.isConnected) input.value = ''; }
        if (input.isConnected) $('.add-note', host).open = false;
        toast('Internal note saved.');
      });
    });
    host.addEventListener('click', onClick);
  }
  function onClick(event) {
    const button = event.target.closest('[data-ticket-action]');
    if (!button) return;
    if (button.dataset.ticketAction === 'assist') { openDrawer('assistant'); void runWorkflow(ctx.pane.id); return; }
    void perform(button, () => action(ctx.pane.id, button.dataset.ticketAction === 'context' ? 'openCustomer' : 'prepareReply', {}));
  }
  function render() {
    const ticket = ticketForPane(ctx);
    if (ticket?.id !== currentId) { host.removeEventListener('click', onClick); build(); }
    if (!ticket) return;
    const account = accountForTicket(ctx.state, ticket);
    $('.account-name', host).textContent = `${account?.name || 'Customer'} · ${account?.plan || 'Member'}`;
    const select = $('.status-select select', host);
    if (document.activeElement !== select) select.value = ticket.status === 'draft' ? 'open' : ticket.status;
    $('.status-select', host).dataset.status = ticket.status;
    const draft = ctx.state.app?.drafts?.[ticket.id];
    $('.draft-button span', host).textContent = draft ? 'Open draft' : 'Draft reply';
    const nextThreadSignature = JSON.stringify(ticket.thread || []);
    if (nextThreadSignature !== threadSignature) {
      threadSignature = nextThreadSignature;
      $('.conversation-thread', host).innerHTML = (ticket.thread || []).map(message => message.kind === 'system' ? `<div class="system-message"><span></span>${escapeHTML(message.body)}</div>` : `<section class="thread-message ${message.kind === 'agent' ? 'agent-message' : ''}"><header><span class="avatar avatar-message">${escapeHTML(message.kind === 'customer' ? ticket.customer?.initials || 'C' : message.author?.slice(0, 1) || 'A')}</span><strong>${escapeHTML(message.author)}</strong><time datetime="${escapeHTML(message.createdAt)}">${shortDate(message.createdAt)} · ${time(message.createdAt)}</time></header><div class="message-body">${escapeHTML(message.body)}</div></section>`).join('');
    }
    const nextNotesSignature = JSON.stringify(ticket.notes || []);
    if (notesSignature !== nextNotesSignature) {
      notesSignature = nextNotesSignature;
      $('.internal-notes', host).hidden = !(ticket.notes?.length);
      $('.notes-list', host).innerHTML = (ticket.notes || []).map(note => `<div class="note-item"><div><strong>${escapeHTML(note.author)}</strong><time>${time(note.createdAt)}</time></div><p>${escapeHTML(note.body)}</p></div>`).join('');
    }
  }
  build(); render();
  return { update(nextCtx) { ctx = nextCtx; render(); }, destroy() { host.removeEventListener('click', onClick); } };
}

function mountCustomer(host, initialCtx) {
  let ctx = initialCtx;
  let signature;
  function render() {
    const ticket = ticketForPane(ctx);
    const account = accountForTicket(ctx.state, ticket);
    const nextSignature = JSON.stringify([ticket?.id, account, ctx.state.app?.policies]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    if (!ticket || !account) { host.innerHTML = '<div class="panel-empty"><h2>Customer unavailable</h2></div>'; return; }
    const charges = account.billing?.charges || [];
    const invoices = account.billing?.invoices || [];
    const duplicate = charges.find(charge => charge.kind === 'duplicate');
    const policy = ctx.state.app?.policies?.duplicateCharge;
    host.innerHTML = `<section class="relay-context"><header class="sidecar-heading"><span class="eyebrow">Customer context</span><h2>${escapeHTML(account.name)}</h2><p>${escapeHTML(account.domain || ticket.customer?.email)}</p></header><div class="context-scroll"><div class="customer-card"><span class="avatar avatar-lg">${escapeHTML(ticket.customer?.initials || 'C')}</span><div><strong>${escapeHTML(ticket.customer?.name)}</strong><span>${escapeHTML(ticket.customer?.email)}</span></div></div><dl class="account-facts"><div><dt>Plan</dt><dd>${escapeHTML(account.plan)}</dd></div><div><dt>Subscription</dt><dd><span class="inline-status"><i></i>${escapeHTML(account.subscription?.status || 'Active')}</span></dd></div><div><dt>Monthly amount</dt><dd>${money(account.subscription?.amount, account.subscription?.currency)}</dd></div><div><dt>Customer since</dt><dd>${shortDate(account.since)}</dd></div></dl><section class="billing-section"><div class="section-heading"><h3>Recent charges</h3><span>${charges.length} records</span></div>${charges.map(charge => `<div class="charge-row ${charge.kind === 'duplicate' ? 'charge-duplicate' : ''}"><span class="charge-icon">${icon('card')}</span><div><strong>${charge.kind === 'duplicate' ? 'Duplicate charge' : charge.kind === 'renewal' ? 'Monthly renewal' : escapeHTML(charge.kind || 'Payment')}</strong><span>${shortDate(charge.createdAt)} · ${time(charge.createdAt)}${charge.cardLast4 ? ` · •••• ${escapeHTML(charge.cardLast4)}` : ''}</span><span class="charge-evidence">${charge.invoiceId ? `Linked to ${escapeHTML(charge.invoiceId)}` : 'No matching invoice'}</span></div><div class="charge-amount"><strong>${money(charge.amount, charge.currency)}</strong><span>${escapeHTML(charge.status)}</span></div></div>`).join('') || '<p class="context-muted">No recent charges.</p>'}</section>${invoices.length ? `<div class="invoice-evidence">${icon('check')}<span>${invoices.length} paid invoice${invoices.length === 1 ? '' : 's'} for this billing period</span></div>` : ''}${duplicate && policy ? `<section class="policy-card"><span class="eyebrow">${escapeHTML(policy.title)}</span><h3>${money(duplicate.amount, duplicate.currency)} eligible for refund</h3><p>${escapeHTML(policy.summary)}</p><span class="policy-footnote">No refund has been executed.</span></section>` : `<section class="policy-card"><span class="eyebrow">A little context goes a long way</span><p>Review the account details before writing your reply.</p></section>`}</div><footer class="sidecar-footer"><button class="button button-primary" type="button" data-context-draft>${icon('edit')}Prepare reply${icon('arrow')}</button></footer></section>`;
  }
  host.addEventListener('click', event => {
    const button = event.target.closest('[data-context-draft]');
    const ticketPane = findPane(ctx.state, 'ticket', ctx.pane.data?.ticketId);
    if (button && ticketPane) void perform(button, () => action(ticketPane.id, 'prepareReply'));
  });
  render();
  return { update(nextCtx) { ctx = nextCtx; render(); } };
}

function mountComposer(host, initialCtx) {
  let ctx = initialCtx;
  let ticketId = ctx.pane.data?.ticketId;
  let baseBody = ctx.state.app?.drafts?.[ticketId]?.body || '';
  let body = baseBody;
  let dirty = false;
  let saving = false;
  let reviewing = false;
  let savePromise;
  let timer;
  let disposed = false;
  let conflict = false;
  host.innerHTML = `<section class="relay-composer"><header class="sidecar-heading"><span class="eyebrow">Reply draft</span><h2>Review your reply</h2><p>Review the details and make it yours.</p></header><div class="composer-scroll"><div class="composer-recipient"><span>To</span><strong></strong></div><label class="sr-only" for="reply-${escapeHTML(ctx.pane.id)}">Reply to customer</label><textarea id="reply-${escapeHTML(ctx.pane.id)}" class="reply-editor" aria-describedby="draft-safety-${escapeHTML(ctx.pane.id)}" spellcheck="true" maxlength="30000"></textarea><div class="draft-state"><span class="draft-save-status" role="status"></span><span class="draft-word-count"></span></div><div class="draft-conflict" hidden><strong>Your draft is still here.</strong><p>Another session changed the saved reply. Choose which version to keep.</p><div><button class="button button-small" type="button" data-draft-choice="mine">Keep my draft</button><button class="button button-small button-quiet" type="button" data-draft-choice="latest">Load saved reply</button></div></div><div class="draft-reviewed" hidden>${icon('check')}<div><strong>Reviewed and ready</strong><p>The ticket is now pending. No email has been sent.</p></div></div><div class="draft-safety" id="draft-safety-${escapeHTML(ctx.pane.id)}">${icon('lock')}<p>A review step, not a send button.<br>No email or refund is executed in this example.</p></div></div><footer class="composer-footer"><button class="button button-quiet discard-draft" type="button">Discard</button><button class="button button-primary approve-draft" type="button">${icon('check')}<span>Approve draft</span></button></footer></section>`;
  const input = $('.reply-editor', host);
  const saveStatus = $('.draft-save-status', host);
  const approve = $('.approve-draft', host);
  input.value = body;

  function paint() {
    const ticket = ctx.state.app?.tickets?.[ticketId];
    const draft = ctx.state.app?.drafts?.[ticketId];
    $('.composer-recipient strong', host).textContent = ticket?.customer?.email || '';
    const reviewed = draft?.status === 'reviewed' && !dirty;
    $('.draft-reviewed', host).hidden = !reviewed;
    $('.draft-conflict', host).hidden = !conflict;
    saveStatus.textContent = conflict ? 'Unsaved changes' : saving ? 'Saving…' : dirty ? 'Unsaved changes' : reviewed ? 'Reviewed' : 'Saved to this workspace';
    saveStatus.classList.toggle('has-changes', dirty || conflict);
    $('.draft-word-count', host).textContent = `${body.trim() ? body.trim().split(/\s+/).length : 0} words`;
    approve.disabled = saving || reviewing || conflict || !body.trim() || reviewed;
    input.disabled = reviewing;
    $('span', approve).textContent = reviewed ? 'Approved' : 'Approve draft';
  }

  async function save({ overwrite = false } = {}) {
    clearTimeout(timer);
    if (disposed) return false;
    if (savePromise) { await savePromise; if (dirty && !conflict) return save({ overwrite }); return !dirty; }
    if (!dirty) return true;
    const saved = ctx.state.app?.drafts?.[ticketId]?.body || '';
    if (saved !== baseBody && !overwrite) { conflict = true; paint(); return false; }
    const sentBody = body;
    const previousBody = baseBody;
    saving = true;
    conflict = false;
    paint();
    savePromise = (async () => {
      try {
        const response = await ctx.action('update', { body: sentBody }, { expectedRevision: ctx.state.revision });
        baseBody = sentBody;
        if (body === sentBody) dirty = false;
        const authoritative = newestState(ctx.state, client.state, response?.state);
        ctx = { ...ctx, state: authoritative, pane: authoritative.panes[ctx.pane.id] || ctx.pane };
        const authoritativeBody = authoritative.app?.drafts?.[ticketId]?.body || '';
        if (authoritativeBody !== sentBody) {
          if (authoritativeBody === body) { baseBody = body; dirty = false; }
          else { dirty = true; conflict = true; }
        }
        return true;
      } catch (error) {
        if (error?.code === 'revision_conflict') {
          const latest = await client.snapshot();
          ctx = { ...ctx, state: latest, pane: latest.panes[ctx.pane.id] || ctx.pane };
          if ((latest.app?.drafts?.[ticketId]?.body || '') !== previousBody) conflict = true;
          else timer = setTimeout(() => { void save(); }, 100);
        } else { toast(readableError(error), true); }
        return false;
      } finally { saving = false; savePromise = undefined; if (!disposed) paint(); }
    })();
    const savedSuccessfully = await savePromise;
    if (savedSuccessfully && dirty && !conflict && !disposed) return save({ overwrite });
    return savedSuccessfully && !dirty;
  }

  input.addEventListener('input', () => { body = input.value; dirty = body !== baseBody; conflict = false; paint(); clearTimeout(timer); timer = setTimeout(() => { void save(); }, 650); });
  input.addEventListener('blur', () => { if (dirty && !conflict) void save(); });
  approve.addEventListener('click', () => {
    void perform(approve, async () => {
      reviewing = true; paint();
      try {
        if (!await save()) return;
        const reviewedRevision = ctx.state.revision;
        await ctx.action('approve', {}, { expectedRevision: reviewedRevision });
        toast('Draft reviewed. The ticket is now pending.');
      } catch (error) {
        if (error?.code === 'revision_conflict') {
          const latest = newestState(ctx.state, error.state, client.state || await client.snapshot());
          ctx = { ...ctx, state: latest, pane: latest.panes[ctx.pane.id] || ctx.pane };
          if ((latest.app?.drafts?.[ticketId]?.body || '') !== body) { dirty = true; conflict = true; }
        }
        throw error;
      } finally { reviewing = false; }
    }).finally(paint);
  });
  $('.discard-draft', host).addEventListener('click', event => { clearTimeout(timer); void perform(event.currentTarget, async () => { if (savePromise) await savePromise; await ctx.action('discard', {}); toast('Draft discarded.'); }); });
  host.addEventListener('click', event => {
    const choice = event.target.closest('[data-draft-choice]');
    if (!choice) return;
    if (choice.dataset.draftChoice === 'mine') void perform(choice, () => save({ overwrite: true }));
    else { body = ctx.state.app?.drafts?.[ticketId]?.body || ''; baseBody = body; input.value = body; dirty = false; conflict = false; paint(); }
  });
  draftGuards.set(ctx.pane.id, save);
  paint();
  return {
    update(nextCtx) {
      ctx = nextCtx;
      const saved = ctx.state.app?.drafts?.[ticketId]?.body || '';
      if (!dirty && !saving && !reviewing) { baseBody = saved; body = saved; if (input.value !== body) input.value = body; }
      else if (!saving && !reviewing && saved !== baseBody) conflict = true;
      paint();
    },
    destroy() { draftGuards.delete(ctx.pane.id); disposed = true; clearTimeout(timer); },
  };
}

function syncDrawerMode() {
  if (!currentDrawer) return;
  const modal = currentDrawer === 'integration' || window.innerWidth < 720;
  $('#drawer-shade').hidden = !modal;
  $('.relay-app').inert = modal;
  $('#assistant-drawer').setAttribute('aria-modal', String(modal));
}

function openDrawer(type) {
  if (!currentDrawer) drawerReturnFocus = document.activeElement;
  currentDrawer = type;
  $('#assistant-drawer').hidden = type !== 'assistant';
  $('#integration-drawer').hidden = type !== 'integration';
  syncDrawerMode();
  document.body.classList.toggle('assist-open', type === 'assistant');
  const drawer = type === 'assistant' ? $('#assistant-drawer') : $('#integration-drawer');
  $('.drawer-close', drawer).focus();
}

function closeDrawer() {
  currentDrawer = undefined;
  $('#assistant-drawer').hidden = true;
  $('#integration-drawer').hidden = true;
  $('#drawer-shade').hidden = true;
  $('.relay-app').inert = false;
  document.body.classList.remove('assist-open');
  if (drawerReturnFocus?.isConnected) drawerReturnFocus.focus();
}

function paintWorkflow() {
  $('#workflow-steps').hidden = !workflowSteps.length;
  $('#workflow-steps').innerHTML = workflowSteps.map((step, index) => `<li class="workflow-step step-${step.status}"><span class="step-marker">${step.status === 'done' ? icon('check') : index + 1}</span><div><strong>${escapeHTML(step.title)}</strong><p>${escapeHTML(step.detail)}</p></div></li>`).join('');
  $('#workflow-details').hidden = !workflowCalls.length;
  $('#workflow-calls').innerHTML = workflowCalls.map(call => `<div class="sdk-call"><span>${escapeHTML(call.action)}</span><code>panel.action · ${escapeHTML(call.paneId)}</code><small>Revision ${escapeHTML(call.revision)} · ${escapeHTML(call.requestId)}</small></div>`).join('');
  $('#workflow-start').disabled = workflowRunning || !findPane(state, 'ticket');
  $('#workflow-start').classList.toggle('is-busy', workflowRunning);
  $('#workflow-start').innerHTML = workflowRunning ? `${icon('sparkle')}Working in your workspace…` : `${icon('sparkle')}Review context & draft`;
  $('.assist-running').hidden = !workflowRunning;
}

const wait = duration => new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? Math.min(duration, 150) : duration));

async function runWorkflow(ticketPaneId) {
  if (workflowRunning) return;
  const pane = state.panes[ticketPaneId] || findPane(state, 'ticket');
  if (!pane) return;
  const ticketId = pane.data.ticketId;
  const ticket = state.app.tickets[ticketId];
  const run = ++workflowRun;
  workflowRunning = true;
  workflowCalls = [];
  workflowSteps = [
    { title: 'Open the customer context', detail: 'Bring account details into the workspace.', status: 'working' },
    { title: 'Check the billing evidence', detail: 'Compare charges with the customer’s invoice.', status: 'waiting' },
    { title: 'Prepare a considered reply', detail: 'Replace context with an editable reply draft.', status: 'waiting' },
  ];
  $('#assist-subject').textContent = `Let’s help ${ticket.customer?.name?.split(' ')[0] || 'this customer'}.`;
  $('#workflow-result').hidden = true;
  paintWorkflow();
  async function tracedAction(paneId, name, args = {}) {
    const response = await action(paneId, name, args);
    if (run !== workflowRun) throw new Error('This workflow was stopped.');
    workflowCalls.push({ paneId, action: name, revision: response.revision, requestId: response.requestId });
    paintWorkflow();
    return response;
  }
  try {
    await tracedAction(pane.id, 'openCustomer');
    await wait(1000);
    workflowSteps[0].status = 'done';
    workflowSteps[1].status = 'working';
    const fresh = await client.snapshot();
    const account = accountForTicket(fresh, fresh.app.tickets[ticketId]);
    const charges = account?.billing?.charges || [];
    const duplicate = charges.find(charge => charge.kind === 'duplicate');
    workflowSteps[1].detail = duplicate ? `Two ${money(duplicate.amount, duplicate.currency)} charges, one invoice. A verified duplicate needs billing approval.` : 'Account and subscription details are ready to use.';
    paintWorkflow();
    await wait(1200);
    workflowSteps[1].status = 'done';
    workflowSteps[2].status = 'working';
    paintWorkflow();
    if (state.panes[pane.id]?.data?.ticketId !== ticketId) throw new Error('The selected ticket changed. Start again on the current conversation.');
    await tracedAction(pane.id, 'prepareReply');
    await wait(650);
    workflowSteps[2].status = 'done';
    workflowSteps[2].detail = 'The reply is saved. You decide what happens next.';
    $('#workflow-result').innerHTML = `${icon('check')}<div><strong>Your draft is ready.</strong><p>Review it, adjust the wording, and approve when you’re comfortable. Nothing has been sent.</p><button type="button" class="button button-small" id="review-workflow-draft">Review the draft${icon('arrow')}</button></div>`;
    $('#workflow-result').hidden = false;
    $('#review-workflow-draft').addEventListener('click', () => { closeDrawer(); const composerPane = findPane(state, 'composer', ticketId); if (composerPane) void client.call('pane.focus', { paneId: composerPane.id }).then(() => { setTimeout(() => { document.querySelector(`[data-pane-id="${CSS.escape(composerPane.id)}"] .reply-editor`)?.focus(); }, 80); }).catch(error => toast(readableError(error), true)); });
  } catch (error) {
    const working = workflowSteps.find(step => step.status === 'working');
    if (working) { working.status = 'error'; working.detail = readableError(error); }
    $('#workflow-result').innerHTML = `<div><strong>We paused here.</strong><p>${escapeHTML(readableError(error))}</p><span>Your workspace changes are saved.</span></div>`;
    $('#workflow-result').hidden = false;
  } finally { workflowRunning = false; paintWorkflow(); }
}

async function start() {
  const startup = $('#startup');
  $('#startup-retry').hidden = true;
  $('#startup-message').textContent = 'Connecting to Relay…';
  try {
    workspace?.destroy();
    client?.destroy();
    client = createClient({ baseUrl: '/webdr', sessionId: 'support-desk', onConnection: setConnection });
    state = await client.snapshot();
    if (!findPane(state, 'ticket')) {
      const inbox = findPane(state, 'inbox');
      if (inbox && state.app?.tickets?.['SUP-1042']) await action(inbox.id, 'open', { ticketId: 'SUP-1042' });
      state = client.state || await client.snapshot();
    }
    workspace = mountWorkspace($('#workspace'), {
      client,
      panels: { inbox: { mount: mountInbox }, ticket: { mount: mountTicket }, customer: { mount: mountCustomer }, composer: { mount: mountComposer } },
      tabBar: false,
      async onPaneClose(pane) {
        if (pane.view === 'inbox') { toast('The inbox keeps your support workspace together.'); return; }
        const save = draftGuards.get(pane.id);
        if (save && !await save()) { toast('Resolve your reply draft before closing it.', true); return; }
        await client.call('pane.close', { paneId: pane.id });
      },
    });
    client.subscribe(syncGlobal);
    syncGlobal(state);
    startup.hidden = true;
  } catch (error) {
    $('#startup-message').textContent = readableError(error);
    $('#startup-retry').hidden = false;
    startup.hidden = false;
    setConnection('closed');
  }
}

$('#startup-retry').addEventListener('click', () => { void start(); });
$('#assist-button').addEventListener('click', () => openDrawer('assistant'));
$('#integration-button').addEventListener('click', () => openDrawer('integration'));
$('#sdk-nav').addEventListener('click', () => openDrawer('integration'));
$('#inbox-nav').addEventListener('click', () => { const pane = findPane(state, 'inbox'); if (pane) void client.call('pane.focus', { paneId: pane.id }).catch(error => toast(readableError(error), true)); });
$('#workflow-start').addEventListener('click', () => { const pane = findPane(state, 'ticket'); if (pane) void runWorkflow(pane.id); });
$('#drawer-shade').addEventListener('click', closeDrawer);
document.querySelectorAll('.drawer-close').forEach(button => button.addEventListener('click', closeDrawer));
$('#reset-button').addEventListener('click', event => {
  if (workflowRunning) { toast('Let the sample workflow finish before resetting.'); return; }
  const pane = findPane(state, 'inbox');
  if (pane) void perform(event.currentTarget, async () => {
    await action(pane.id, 'reset');
    noteDrafts.clear();
    await action(pane.id, 'open', { ticketId: 'SUP-1042' });
    workflowCalls = []; workflowSteps = [];
    $('#workflow-result').hidden = true;
    paintWorkflow();
    toast('Sample workspace reset.');
  });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && currentDrawer) { event.preventDefault(); closeDrawer(); return; }
  if (event.key === 'Tab' && currentDrawer && (currentDrawer === 'integration' || window.innerWidth < 720)) {
    const drawer = currentDrawer === 'assistant' ? $('#assistant-drawer') : $('#integration-drawer');
    const focusable = [...drawer.querySelectorAll('button:not(:disabled), a[href], summary, input, textarea, select')].filter(element => !element.hidden && element.getClientRects().length);
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    return;
  }
  if (currentDrawer || event.ctrlKey || event.metaKey || event.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
  if (event.key === '/') { event.preventDefault(); const pane = findPane(state, 'inbox'); if (pane) void client.call('pane.focus', { paneId: pane.id }).then(() => $('.inbox-search input')?.focus()).catch(error => toast(readableError(error), true)); }
});
window.addEventListener('resize', syncDrawerMode);
window.addEventListener('pagehide', () => { workspace?.destroy(); client?.destroy(); });
void start();
