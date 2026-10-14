import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, executeCommand } from '../packages/core/index.mjs';
import { supportPanels, createSupportState } from '../examples/support-desk/domain.mjs';

const supportTestRegistry = createRegistry(supportPanels);
function supportTestSession(id = 'support-desk') {
  let state = createSupportState(id), sequence = 0;
  return {
    get state() { return state; },
    async call(method, params, options = {}) {
      const outcome = await executeCommand(state, { version: 1, sessionId: id, requestId: `support-test-${++sequence}`, method, params, ...options }, { registry: supportTestRegistry, principal: { id: 'alex', name: 'Alex Morgan', actor: 'human:alex' } });
      state = outcome.state;
      return outcome;
    },
    async action(paneId, action, args = {}, options = {}) { return this.call('panel.action', { paneId, action, args }, options); },
    pane(type) { return Object.values(state.panes).find(pane => pane.view === type); },
  };
}

test('support fixture is isolated host-owned data with discoverable exact actions', () => {
  const state = createSupportState(), other = createSupportState('another-session');
  assert.equal(state.sessionId, 'support-desk');
  assert.equal(state.panes.pane_inbox.view, 'inbox');
  assert.equal(Object.keys(state.app.tickets).length, 7);
  const ticket = state.app.tickets['SUP-1042'], account = state.app.accounts[ticket.accountId];
  assert.equal(ticket.customer.name, 'Maya Chen');
  assert.equal(account.name, 'Northstar');
  assert.equal(account.billing.charges.length, 2);
  assert.deepEqual(account.billing.charges.map(charge => charge.amount), [79, 79]);
  assert.equal(account.billing.invoices.length, 1);
  assert.equal(account.billing.charges.filter(charge => charge.invoiceId === null).length, 1);
  state.app.tickets['SUP-1042'].subject = 'Changed locally';
  assert.notEqual(other.app.tickets['SUP-1042'].subject, state.app.tickets['SUP-1042'].subject);
  const schema = supportTestRegistry.schema();
  assert.deepEqual(schema.map(panel => panel.type), ['inbox', 'ticket', 'customer', 'composer']);
  assert.deepEqual(schema.find(panel => panel.type === 'ticket').actions.map(action => action.name), ['openCustomer', 'prepareReply', 'setStatus', 'addNote']);
  assert.ok(!JSON.stringify(schema).includes('"run"'));
});

test('context-to-draft workflow creates and removes real panels in one revision per action', async () => {
  const session = supportTestSession(), initial = session.state;
  const opened = await session.action('pane_inbox', 'open', { ticketId: 'SUP-1042' });
  const ticketId = opened.result.paneId;
  assert.equal(session.state.revision, 1);
  assert.equal(Object.keys(session.state.panes).length, 2);
  assert.equal(Object.keys(initial.panes).length, 1);
  const context = await session.action(ticketId, 'openCustomer');
  assert.equal(session.state.revision, 2);
  assert.equal(session.state.panes[context.result.paneId].view, 'customer');
  const drafted = await session.action(ticketId, 'prepareReply');
  assert.equal(session.state.revision, 3);
  assert.equal(session.state.panes[context.result.paneId], undefined);
  assert.equal(session.state.panes[drafted.result.paneId].view, 'composer');
  assert.equal(Object.keys(session.state.panes).length, 3);
  assert.equal(session.state.events.length, 3);
  assert.equal(session.state.app.tickets['SUP-1042'].status, 'draft');
  assert.match(session.state.app.drafts['SUP-1042'].body, /two settled \$79 charges/);
  assert.match(session.state.app.drafts['SUP-1042'].body, /INV-1087/);
  assert.match(session.state.app.drafts['SUP-1042'].body, /request approval/);
  assert.doesNotMatch(session.state.app.drafts['SUP-1042'].body, /have (issued|processed|sent)/);
});

test('reusing panels and switching tickets preserves human-written drafts', async () => {
  const session = supportTestSession();
  const opened = await session.action('pane_inbox', 'open', { ticketId: 'SUP-1042' });
  const ticketPaneId = opened.result.paneId;
  const prepared = await session.action(ticketPaneId, 'prepareReply');
  const humanBody = 'Hi Maya,\n\nI reviewed both payments with our finance lead. I will follow up after the billing review.\n\nAlex';
  await session.action(prepared.result.paneId, 'update', { body: humanBody });
  assert.equal(session.state.app.drafts['SUP-1042'].source, 'human');
  const context = await session.action(ticketPaneId, 'openCustomer');
  assert.equal(session.state.panes[prepared.result.paneId], undefined);
  const contextAgain = await session.action(ticketPaneId, 'openCustomer');
  assert.equal(contextAgain.result.paneId, context.result.paneId);
  const other = await session.action('pane_inbox', 'open', { ticketId: 'SUP-1041' });
  assert.equal(other.result.paneId, ticketPaneId);
  assert.equal(session.state.panes[context.result.paneId], undefined);
  assert.equal(Object.keys(session.state.panes).length, 2);
  await session.action('pane_inbox', 'open', { ticketId: 'SUP-1042' });
  const reopened = await session.action(ticketPaneId, 'prepareReply');
  assert.equal(reopened.result.preservedDraft, true);
  assert.equal(session.state.app.drafts['SUP-1042'].body, humanBody);
  assert.equal(session.state.app.drafts['SUP-1042'].source, 'human');
});

test('review is an internal state transition with no email, refund, or conversation side effect', async () => {
  const session = supportTestSession();
  const opened = await session.action('pane_inbox', 'open', { ticketId: 'SUP-1042' });
  const prepared = await session.action(opened.result.paneId, 'prepareReply');
  const beforeBilling = structuredClone(session.state.app.accounts.acct_northstar.billing);
  const beforeThread = structuredClone(session.state.app.tickets['SUP-1042'].thread);
  const approved = await session.action(prepared.result.paneId, 'approve');
  assert.equal(approved.result.emailSent, false);
  assert.equal(approved.result.refundProcessed, false);
  assert.equal(session.state.app.drafts['SUP-1042'].status, 'reviewed');
  assert.equal(session.state.app.drafts['SUP-1042'].reviewedBy, 'Alex Morgan');
  assert.equal(session.state.app.tickets['SUP-1042'].status, 'pending');
  assert.deepEqual(session.state.app.accounts.acct_northstar.billing, beforeBilling);
  assert.deepEqual(session.state.app.tickets['SUP-1042'].thread, beforeThread);
  await session.action(prepared.result.paneId, 'update', { body: 'A revised reply after review.' });
  assert.equal(session.state.app.drafts['SUP-1042'].status, 'draft');
  assert.equal(session.state.app.drafts['SUP-1042'].reviewedBy, undefined);
  assert.equal(session.state.app.tickets['SUP-1042'].status, 'draft');
});

test('opening a reviewed reply preserves its review, pending ticket, timestamps and application clock', async () => {
  const session = supportTestSession();
  const opened = await session.action('pane_inbox', 'open', { ticketId: 'SUP-1042' });
  const prepared = await session.action(opened.result.paneId, 'prepareReply');
  await session.action(prepared.result.paneId, 'update', { body: 'Hi Maya,\n\nBoth payments are verified. Billing approval is the next step.\n\nAlex' });
  await session.action(prepared.result.paneId, 'approve');
  const reviewedApp = structuredClone(session.state.app);
  const reopened = await session.action(opened.result.paneId, 'prepareReply');
  assert.equal(reopened.result.paneId, prepared.result.paneId);
  assert.equal(reopened.result.status, 'reviewed');
  assert.equal(reopened.result.preservedDraft, true);
  assert.deepEqual(session.state.app, reviewedApp);
  await session.action(opened.result.paneId, 'openCustomer');
  assert.equal(session.state.panes[prepared.result.paneId], undefined);
  const recreated = await session.action(opened.result.paneId, 'prepareReply');
  assert.notEqual(recreated.result.paneId, prepared.result.paneId);
  assert.equal(recreated.result.status, 'reviewed');
  assert.equal(session.state.panes[recreated.result.paneId].view, 'composer');
  assert.deepEqual(session.state.app, reviewedApp);
});

test('discard removes saved draft and composer while keeping conversation and inbox usable', async () => {
  const session = supportTestSession();
  const opened = await session.action('pane_inbox', 'open', { ticketId: 'SUP-1042' });
  const prepared = await session.action(opened.result.paneId, 'prepareReply');
  const discarded = await session.action(prepared.result.paneId, 'discard');
  assert.equal(discarded.result.discarded, true);
  assert.equal(session.state.app.drafts['SUP-1042'], undefined);
  assert.equal(session.state.panes[prepared.result.paneId], undefined);
  assert.equal(session.state.app.tickets['SUP-1042'].status, 'open');
  assert.equal(session.state.panes[opened.result.paneId].view, 'ticket');
  assert.equal(session.state.panes.pane_inbox.view, 'inbox');
});

test('concurrent draft edits reject stale revisions and leave both app and graph unchanged', async () => {
  const session = supportTestSession();
  const opened = await session.action('pane_inbox', 'open', { ticketId: 'SUP-1042' });
  const prepared = await session.action(opened.result.paneId, 'prepareReply');
  const readRevision = session.state.revision;
  await session.action(prepared.result.paneId, 'update', { body: 'Human changes already saved.' }, { expectedRevision: readRevision });
  const saved = structuredClone(session.state);
  await assert.rejects(session.action(prepared.result.paneId, 'update', { body: 'Stale agent replacement.' }, { expectedRevision: readRevision }), error => error.code === 'revision_conflict');
  assert.deepEqual(session.state, saved);
  assert.equal(session.state.app.drafts['SUP-1042'].body, 'Human changes already saved.');
});

test('invalid domain inputs and an empty review fail without partial mutations', async () => {
  const session = supportTestSession(), initial = structuredClone(session.state);
  await assert.rejects(session.action('pane_inbox', 'open', { ticketId: 'SUP-missing' }), error => error.code === 'ticket_not_found');
  assert.deepEqual(session.state, initial);
  await assert.rejects(session.action('pane_inbox', 'filter', { status: 'delivered' }), error => error.code === 'schema_validation');
  await assert.rejects(session.action('pane_inbox', 'open', { ticketId: 'SUP-1042', sendEmail: true }), error => error.code === 'schema_validation');
  const opened = await session.action('pane_inbox', 'open', { ticketId: 'SUP-1042' });
  await assert.rejects(session.action(opened.result.paneId, 'addNote', { text: '   ' }), error => error.code === 'schema_validation');
  const prepared = await session.action(opened.result.paneId, 'prepareReply');
  await session.action(prepared.result.paneId, 'update', { body: '' });
  const blank = structuredClone(session.state);
  await assert.rejects(session.action(prepared.result.paneId, 'approve'), error => error.code === 'empty_draft');
  assert.deepEqual(session.state, blank);
});

test('inbox filters, host-attributed notes and statuses persist; reset restores a fresh example', async () => {
  const session = supportTestSession();
  await session.action('pane_inbox', 'filter', { query: 'northstar', status: 'open' });
  assert.deepEqual(session.state.panes.pane_inbox.data, { query: 'northstar', status: 'open' });
  const opened = await session.action('pane_inbox', 'open', { ticketId: 'SUP-1042' });
  const note = await session.action(opened.result.paneId, 'addNote', { text: 'Billing review requested internally.' });
  assert.equal(session.state.app.tickets['SUP-1042'].notes.at(-1).id, note.result.noteId);
  assert.equal(session.state.app.tickets['SUP-1042'].notes.at(-1).author, 'Alex Morgan');
  await session.action(opened.result.paneId, 'setStatus', { status: 'resolved' });
  assert.equal(session.state.app.tickets['SUP-1042'].status, 'resolved');
  await session.action(opened.result.paneId, 'prepareReply');
  const revision = session.state.revision;
  await session.action('pane_inbox', 'reset');
  assert.equal(session.state.revision, revision + 1);
  assert.deepEqual(Object.keys(session.state.panes), ['pane_inbox']);
  assert.deepEqual(session.state.panes.pane_inbox.data, { query: '', status: 'all' });
  assert.equal(session.state.app.tickets['SUP-1042'].notes.length, 1);
  assert.equal(session.state.app.tickets['SUP-1042'].status, 'open');
  assert.deepEqual(session.state.app.drafts, {});
});

test('sample draft uses current payment evidence rather than claiming unsupported refunds', async () => {
  const state = createSupportState();
  state.app.accounts.acct_northstar.billing.charges[1].status = 'pending';
  const opened = await executeCommand(state, { version: 1, sessionId: state.sessionId, requestId: 'evidence-open', method: 'panel.action', params: { paneId: 'pane_inbox', action: 'open', args: { ticketId: 'SUP-1042' } } }, { registry: supportTestRegistry });
  const prepared = await executeCommand(opened.state, { version: 1, sessionId: state.sessionId, requestId: 'evidence-draft', method: 'panel.action', params: { paneId: opened.result.paneId, action: 'prepareReply', args: {} } }, { registry: supportTestRegistry });
  assert.doesNotMatch(prepared.state.app.drafts['SUP-1042'].body, /second charge.*duplicate/);
  assert.doesNotMatch(prepared.state.app.drafts['SUP-1042'].body, /eligible for a full refund/);
});

test('domain failure after changing the transaction clock rolls back the entire application draft', async () => {
  const session = supportTestSession();
  const opened = await session.action('pane_inbox', 'open', { ticketId: 'SUP-1042' });
  session.state.app.tickets['SUP-1042'].notes = Array.from({ length: 100 }, (_, index) => ({ id: `limit-note-${index}`, author: 'Alex Morgan', body: 'Existing internal note', createdAt: '2026-10-13T09:28:00Z' }));
  const before = structuredClone(session.state);
  await assert.rejects(session.action(opened.result.paneId, 'addNote', { text: 'Would exceed the note limit.' }), error => error.code === 'note_limit');
  assert.deepEqual(session.state, before);
});
