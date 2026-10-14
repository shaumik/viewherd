import { definePanel, createSession } from '../../packages/core/index.mjs';

/** Fictional, deterministic application data. Amounts are decimal USD, never cents. */
const SUPPORT_SEED_TIME = '2026-10-13T10:30:00.000Z';
const SUPPORT_EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false };
const SUPPORT_TICKET_ID = { type: 'string', minLength: 1, maxLength: 40 };
const SUPPORT_TICKET_DATA = {
  type: 'object', properties: { ticketId: SUPPORT_TICKET_ID }, required: ['ticketId'], additionalProperties: false,
};

function supportSeedApp() {
  return {
    name: 'Relay',
    sample: true,
    clock: { base: SUPPORT_SEED_TIME, tick: 0 },
    tickets: {
      'SUP-1042': {
        id: 'SUP-1042', accountId: 'acct_northstar', customer: { name: 'Maya Chen', email: 'maya@northstar.example', initials: 'MC', role: 'Workspace owner' },
        subject: 'Charged twice for our monthly plan', preview: 'Two $79 charges appeared this morning. Could you take a look?',
        status: 'open', priority: 'high', category: 'Billing', createdAt: '2026-10-13T09:12:00Z', updatedAt: '2026-10-13T09:26:00Z',
        assignee: 'Alex Morgan',
        thread: [
          { id: 'msg_1042_1', kind: 'customer', author: 'Maya Chen', body: 'Hi team — our Northstar workspace renewed this morning, but I can see two $79 charges on the same card. We only have one workspace and didn’t change plans. Could you check before I report it to our finance team?', createdAt: '2026-10-13T09:12:00Z' },
          { id: 'msg_1042_2', kind: 'agent', author: 'Alex Morgan', body: 'Hi Maya, thanks for flagging this. I’m checking the renewal and payment records now. Could you confirm the last four digits of the card?', createdAt: '2026-10-13T09:18:00Z' },
          { id: 'msg_1042_3', kind: 'customer', author: 'Maya Chen', body: 'It’s the card ending in 4242. Both charges are posted, not pending. I’ve attached the two transaction references: ch_ns_renewal and ch_ns_duplicate. Thanks for looking into it.', createdAt: '2026-10-13T09:26:00Z' },
        ],
        notes: [{ id: 'note_1042_seed', author: 'Alex Morgan', body: 'Renewal invoice INV-1087 is paid. Check the second payment against the same billing period before requesting a refund.', createdAt: '2026-10-13T09:28:00Z' }],
      },
      'SUP-1041': {
        id: 'SUP-1041', accountId: 'acct_studio', customer: { name: 'James Okafor', email: 'james@studioco.example', initials: 'JO', role: 'Admin' },
        subject: 'CSV export missing custom fields', preview: 'Our account owner field is missing from the export.', status: 'open', priority: 'normal', category: 'Product',
        createdAt: '2026-10-13T08:41:00Z', updatedAt: '2026-10-13T08:41:00Z', assignee: 'Alex Morgan',
        thread: [{ id: 'msg_1041_1', kind: 'customer', author: 'James Okafor', body: 'We’re exporting the October project list for our weekly review. The CSV includes the standard fields, but the custom “Account owner” field is missing. Is there a way to include it?', createdAt: '2026-10-13T08:41:00Z' }], notes: [],
      },
      'SUP-1040': {
        id: 'SUP-1040', accountId: 'acct_fieldwork', customer: { name: 'Sofia Rivera', email: 'sofia@fieldwork.example', initials: 'SR', role: 'Workspace owner' },
        subject: 'New teammate hasn’t received an invite', preview: 'We checked spam and resent the invitation yesterday.', status: 'pending', priority: 'normal', category: 'Access',
        createdAt: '2026-10-12T16:09:00Z', updatedAt: '2026-10-13T08:14:00Z', assignee: 'Jamie Park',
        thread: [
          { id: 'msg_1040_1', kind: 'customer', author: 'Sofia Rivera', body: 'Our new designer hasn’t received their invitation. We checked spam and resent it yesterday. The address is eli@fieldwork.example.', createdAt: '2026-10-12T16:09:00Z' },
          { id: 'msg_1040_2', kind: 'agent', author: 'Jamie Park', body: 'The invitation is still active. Please ask your email administrator to check whether mail from our notifications address is being held. I’ll keep this ticket open while you check.', createdAt: '2026-10-13T08:14:00Z' },
        ], notes: [],
      },
      'SUP-1039': {
        id: 'SUP-1039', accountId: 'acct_arc', customer: { name: 'Leo Bennett', email: 'leo@arcdesign.example', initials: 'LB', role: 'Admin' },
        subject: 'Linear sync stopped updating issues', preview: 'The last successful sync was Monday afternoon.', status: 'open', priority: 'high', category: 'Integrations',
        createdAt: '2026-10-13T07:36:00Z', updatedAt: '2026-10-13T07:36:00Z', assignee: 'Alex Morgan',
        thread: [{ id: 'msg_1039_1', kind: 'customer', author: 'Leo Bennett', body: 'Our Linear integration shows Connected, but issue updates have stopped appearing in Relay. The last successful sync was Monday afternoon. We haven’t changed permissions or our API key.', createdAt: '2026-10-13T07:36:00Z' }], notes: [],
      },
      'SUP-1038': {
        id: 'SUP-1038', accountId: 'acct_northstar', customer: { name: 'Maya Chen', email: 'maya@northstar.example', initials: 'MC', role: 'Workspace owner' },
        subject: 'Can we move a project to another workspace?', preview: 'We’re splitting our client and internal work.', status: 'resolved', priority: 'normal', category: 'Product',
        createdAt: '2026-10-11T14:22:00Z', updatedAt: '2026-10-12T09:48:00Z', assignee: 'Jamie Park',
        thread: [
          { id: 'msg_1038_1', kind: 'customer', author: 'Maya Chen', body: 'We’re separating client and internal projects. Can I move a project to our other workspace without losing comments?', createdAt: '2026-10-11T14:22:00Z' },
          { id: 'msg_1038_2', kind: 'agent', author: 'Jamie Park', body: 'Yes. A workspace owner can use Project settings → Move project. Comments and files move with the project; members need access to the destination workspace.', createdAt: '2026-10-12T09:40:00Z' },
          { id: 'msg_1038_3', kind: 'customer', author: 'Maya Chen', body: 'That worked perfectly. Thank you!', createdAt: '2026-10-12T09:48:00Z' },
        ], notes: [],
      },
      'SUP-1037': {
        id: 'SUP-1037', accountId: 'acct_lumen', customer: { name: 'Aisha Patel', email: 'aisha@lumenlabs.example', initials: 'AP', role: 'Workspace owner' },
        subject: 'Need a copy of September’s invoice', preview: 'Our finance team needs the invoice with our billing address.', status: 'open', priority: 'normal', category: 'Billing',
        createdAt: '2026-10-13T06:54:00Z', updatedAt: '2026-10-13T06:54:00Z', assignee: 'Alex Morgan',
        thread: [{ id: 'msg_1037_1', kind: 'customer', author: 'Aisha Patel', body: 'Could you help me find our September invoice? Finance needs the PDF with our company billing address before they can close the month.', createdAt: '2026-10-13T06:54:00Z' }], notes: [],
      },
      'SUP-1036': {
        id: 'SUP-1036', accountId: 'acct_studio', customer: { name: 'Nina Flores', email: 'nina@studioco.example', initials: 'NF', role: 'Member' },
        subject: 'Notification preferences keep resetting', preview: 'I’m getting daily digests after turning them off.', status: 'pending', priority: 'normal', category: 'Product',
        createdAt: '2026-10-12T13:12:00Z', updatedAt: '2026-10-12T15:46:00Z', assignee: 'Jamie Park',
        thread: [
          { id: 'msg_1036_1', kind: 'customer', author: 'Nina Flores', body: 'I switched off the daily email digest last week, but I’m still receiving it. When I reopen preferences, the toggle is back on.', createdAt: '2026-10-12T13:12:00Z' },
          { id: 'msg_1036_2', kind: 'agent', author: 'Jamie Park', body: 'Thanks, Nina. Could you share the browser and version you’re using, and whether this happens in a private window too?', createdAt: '2026-10-12T15:46:00Z' },
        ], notes: [],
      },
    },
    accounts: {
      acct_northstar: {
        id: 'acct_northstar', name: 'Northstar', domain: 'northstar.example', plan: 'Team', members: 12, since: '2025-04-18',
        subscription: { id: 'sub_northstar', status: 'active', billingCycle: 'monthly', amount: 79, currency: 'USD', nextBillingAt: '2026-11-13' },
        billing: {
          invoices: [{ id: 'INV-1087', number: '1087', amount: 79, currency: 'USD', status: 'paid', periodStart: '2026-10-13', periodEnd: '2026-11-13', createdAt: '2026-10-13T08:02:00Z', chargeId: 'ch_ns_renewal' }],
          charges: [
            { id: 'ch_ns_renewal', amount: 79, currency: 'USD', status: 'settled', createdAt: '2026-10-13T08:02:00Z', invoiceId: 'INV-1087', cardLast4: '4242', kind: 'renewal' },
            { id: 'ch_ns_duplicate', amount: 79, currency: 'USD', status: 'settled', createdAt: '2026-10-13T08:04:00Z', invoiceId: null, cardLast4: '4242', kind: 'duplicate' },
          ],
        },
      },
      acct_studio: supportAccount('acct_studio', 'Studio & Co.', 'studioco.example', 'Team', 79, 8, '2025-11-06'),
      acct_fieldwork: supportAccount('acct_fieldwork', 'Fieldwork', 'fieldwork.example', 'Team', 79, 9, '2026-02-09'),
      acct_arc: supportAccount('acct_arc', 'Arc Design', 'arcdesign.example', 'Business', 199, 28, '2024-08-22'),
      acct_lumen: {
        ...supportAccount('acct_lumen', 'Lumen Labs', 'lumenlabs.example', 'Business', 199, 34, '2025-01-15'),
        billing: { invoices: [{ id: 'INV-0973', number: '0973', amount: 199, currency: 'USD', status: 'paid', periodStart: '2026-09-15', periodEnd: '2026-10-15', createdAt: '2026-09-15T08:00:00Z', chargeId: 'ch_lumen_sep' }], charges: [{ id: 'ch_lumen_sep', amount: 199, currency: 'USD', status: 'settled', createdAt: '2026-09-15T08:00:00Z', invoiceId: 'INV-0973', cardLast4: '8091', kind: 'renewal' }] },
      },
    },
    drafts: {},
    policies: {
      duplicateCharge: { title: 'Duplicate-charge policy', summary: 'Verified duplicate charges are eligible for a full refund. Approval and execution happen in your billing system.', requiresBillingApproval: true, refundTiming: '5–10 business days after processing' },
      invoices: { title: 'Invoice access', summary: 'Workspace owners can download paid invoices from Settings → Billing → Invoice history.' },
      invitations: { title: 'Workspace invitations', summary: 'Invitations remain valid for 7 days. Resending an invitation does not create another seat.' },
      exports: { title: 'CSV export', summary: 'Choose All fields in the export dialog to include custom fields. Exports respect the current filtered view.' },
    },
  };
}

function supportAccount(id, name, domain, plan, amount, members, since) {
  return { id, name, domain, plan, members, since, subscription: { id: `sub_${id.slice(5)}`, status: 'active', billingCycle: 'monthly', amount, currency: 'USD', nextBillingAt: '2026-11-15' }, billing: { invoices: [], charges: [] } };
}

function supportError(code, message) { const error = new Error(message); error.code = code; throw error; }
function supportTicket(ctx, ticketId = ctx.pane.data.ticketId) {
  const ticket = Object.hasOwn(ctx.app.tickets, ticketId) ? ctx.app.tickets[ticketId] : null;
  if (!ticket) supportError('ticket_not_found', `Ticket ${ticketId} does not exist.`);
  return ticket;
}
function supportAccountFor(ctx, ticket) {
  const account = Object.hasOwn(ctx.app.accounts, ticket.accountId) ? ctx.app.accounts[ticket.accountId] : null;
  if (!account) supportError('account_not_found', `Account ${ticket.accountId} does not exist.`);
  return account;
}
function supportStamp(app) {
  app.clock.tick += 1;
  return new Date(Date.parse(app.clock.base) + app.clock.tick * 60000).toISOString();
}
function supportActor(ctx) {
  const value = ctx.principal?.name ?? ctx.principal?.id ?? 'Support team';
  return typeof value === 'string' && value.trim() ? value.slice(0, 80) : 'Support team';
}
function supportLeaves(layout) { return layout.type === 'pane' ? [layout.paneId] : [...supportLeaves(layout.first), ...supportLeaves(layout.second)]; }
function supportTabPanes(ctx) {
  for (const workspace of ctx.state.workspaces) for (const tab of workspace.tabs) {
    const ids = supportLeaves(tab.layout);
    if (ids.includes(ctx.pane.id)) return ids.map(id => ctx.state.panes[id]);
  }
  supportError('pane_not_found', 'The support panel is no longer attached to a tab.');
}
function supportCloseSidecars(ctx, { keepView, ticketId } = {}) {
  const remove = supportTabPanes(ctx).filter(pane => ['customer', 'composer'].includes(pane.view) && !(pane.view === keepView && pane.data.ticketId === ticketId));
  for (const pane of remove) ctx.call('pane.close', { paneId: pane.id });
}
function supportOpenSidecar(ctx, type, ticket, title) {
  const existing = supportTabPanes(ctx).find(pane => pane.view === type && pane.data.ticketId === ticket.id);
  if (existing) { ctx.call('pane.focus', { paneId: existing.id }); return { paneId: existing.id, reused: true }; }
  const opened = ctx.call('pane.split', { paneId: ctx.pane.id, direction: 'right', ratio: 0.57, view: type, title, data: { ticketId: ticket.id } });
  return { paneId: opened.paneId, reused: false };
}
function supportMoney(amount, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
}
function supportDraftBody(ctx, ticket, account) {
  const greeting = `Hi ${ticket.customer.name.split(' ')[0]},`;
  if (ticket.category === 'Billing') {
    const duplicate = account.billing.charges.find(charge => charge.kind === 'duplicate' && charge.status === 'settled');
    const renewal = account.billing.charges.find(charge => charge.kind === 'renewal' && charge.status === 'settled');
    const invoice = account.billing.invoices.find(item => item.id === renewal?.invoiceId);
    if (duplicate && renewal && invoice && duplicate.amount === renewal.amount && duplicate.currency === renewal.currency && duplicate.cardLast4 === renewal.cardLast4) {
      const renewalDate = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${invoice.periodStart}T00:00:00Z`));
      const subscriptionLine = account.subscription.status === 'active' ? 'Your subscription is active and your workspace access is unaffected.' : `Your subscription is currently ${account.subscription.status}; I’ll check that status with the billing team too.`;
      return `${greeting}\n\nThanks for sending the transaction references. I checked ${account.name}’s billing records: your ${account.plan} plan renewed for ${supportMoney(invoice.amount, invoice.currency)} on ${renewalDate}, and there are two settled ${supportMoney(duplicate.amount, duplicate.currency)} charges on the card ending in ${duplicate.cardLast4}. Only the renewal charge is linked to invoice ${invoice.id}; the second charge (${duplicate.id}) is a duplicate.\n\nThe duplicate is eligible for a full refund under our duplicate-charge policy. I’ll request approval from our billing team and follow up once it has been processed. Refunds usually appear within ${ctx.app.policies.duplicateCharge.refundTiming}. ${subscriptionLine}\n\nI’m sorry for the extra work this caused. We’ll keep you updated here.\n\n${supportActor(ctx)}`;
    }
    if (/invoice/i.test(ticket.subject) && account.billing.invoices.length) return `${greeting}\n\nYou can download your paid invoices from Settings → Billing → Invoice history. The latest invoice in our records is ${account.billing.invoices.at(-1).id}. Please let me know if the billing address needs updating before you share it with your finance team.\n\n${supportActor(ctx)}`;
    return `${greeting}\n\nThanks for sharing the billing details. I’m checking the transaction references against ${account.name}’s invoice and payment records. I’ll confirm the payment status and any appropriate next step after that review.\n\n${supportActor(ctx)}`;
  }
  if (ticket.category === 'Access') return `${greeting}\n\nThanks for checking. Invitations remain valid for 7 days, and resending one does not create an extra seat. Please confirm the invited email address and ask your email administrator whether the invitation is being held by a mail rule. We can investigate further with that information.\n\n${supportActor(ctx)}`;
  if (ticket.id === 'SUP-1041') return `${greeting}\n\nYou can include your custom fields by choosing All fields in the CSV export dialog. The export will use your current filtered view. Please try that option with the October project list and let me know if “Account owner” is still missing.\n\n${supportActor(ctx)}`;
  return `${greeting}\n\nThanks for the details about ${ticket.subject.toLowerCase()}. I’m reviewing this with the team. Could you share the steps you followed and any error message you’re seeing? That will help us narrow down what’s happening.\n\n${supportActor(ctx)}`;
}

export const supportPanels = [
  definePanel({
    type: 'inbox', title: 'Inbox', description: 'Browse and filter the host application’s fictional support tickets.',
    dataSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, status: { type: 'string', enum: ['all', 'open', 'draft', 'pending', 'resolved'] } }, required: ['query', 'status'], additionalProperties: false },
    actions: {
      open: {
        description: 'Open or reuse a ticket panel. Remove sidecars belonging to the previous ticket.',
        inputSchema: { type: 'object', properties: { ticketId: SUPPORT_TICKET_ID }, required: ['ticketId'], additionalProperties: false },
        run(ctx, { ticketId }) {
          const ticket = supportTicket(ctx, ticketId);
          for (const pane of supportTabPanes(ctx).filter(pane => ['customer', 'composer'].includes(pane.view) && pane.data.ticketId !== ticketId)) ctx.call('pane.close', { paneId: pane.id });
          const existing = supportTabPanes(ctx).find(pane => pane.view === 'ticket');
          if (existing) {
            if (existing.data.ticketId !== ticketId) ctx.call('view.open', { paneId: existing.id, view: 'ticket', title: ticket.customer.name, data: { ticketId } });
            ctx.call('pane.focus', { paneId: existing.id });
            return { paneId: existing.id, ticketId, reused: true };
          }
          const opened = ctx.call('pane.split', { paneId: ctx.pane.id, direction: 'right', ratio: 0.28, view: 'ticket', title: ticket.customer.name, data: { ticketId } });
          return { paneId: opened.paneId, ticketId, reused: false };
        },
      },
      filter: {
        description: 'Persist the inbox search query or status filter without changing tickets.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, status: { type: 'string', enum: ['all', 'open', 'draft', 'pending', 'resolved'] } }, additionalProperties: false },
        run(ctx, args) { ctx.call('view.update', { paneId: ctx.pane.id, data: args }); return { ...ctx.pane.data }; },
      },
      reset: {
        description: 'Explicitly reset fictional support data and close the other panels in this inbox’s tab.', inputSchema: SUPPORT_EMPTY_INPUT,
        run(ctx) {
          const inboxId = ctx.pane.id;
          for (const pane of supportTabPanes(ctx).filter(pane => pane.id !== inboxId)) ctx.call('pane.close', { paneId: pane.id });
          for (const key of Object.keys(ctx.app)) delete ctx.app[key];
          Object.assign(ctx.app, supportSeedApp());
          ctx.call('view.update', { paneId: inboxId, data: { query: '', status: 'all' } });
          ctx.call('pane.focus', { paneId: inboxId });
          return { reset: true, paneId: inboxId };
        },
      },
    },
  }),
  definePanel({
    type: 'ticket', title: 'Conversation', description: 'A support conversation backed by host-owned application state.', dataSchema: SUPPORT_TICKET_DATA,
    actions: {
      openCustomer: {
        description: 'Open the customer and billing context, replacing a reply sidecar while preserving its saved draft.', inputSchema: SUPPORT_EMPTY_INPUT,
        run(ctx) {
          const ticket = supportTicket(ctx); supportAccountFor(ctx, ticket);
          supportCloseSidecars(ctx, { keepView: 'customer', ticketId: ticket.id });
          return { ...supportOpenSidecar(ctx, 'customer', ticket, 'Customer context'), ticketId: ticket.id, accountId: ticket.accountId };
        },
      },
      prepareReply: {
        description: 'Create a deterministic sample reply from current records, or reopen an existing draft while preserving its body, review and ticket status. No model or external service is called.', inputSchema: SUPPORT_EMPTY_INPUT,
        run(ctx) {
          const ticket = supportTicket(ctx);
          const previous = ctx.app.drafts[ticket.id];
          if (!previous) {
            const account = supportAccountFor(ctx, ticket), time = supportStamp(ctx.app);
            ctx.app.drafts[ticket.id] = { ticketId: ticket.id, body: supportDraftBody(ctx, ticket, account), status: 'draft', source: 'sample-workflow', createdAt: time, updatedAt: time };
            ticket.status = 'draft'; ticket.updatedAt = time;
          }
          supportCloseSidecars(ctx, { keepView: 'composer', ticketId: ticket.id });
          return { ...supportOpenSidecar(ctx, 'composer', ticket, 'Review reply'), ticketId: ticket.id, preservedDraft: Boolean(previous), status: ctx.app.drafts[ticket.id].status };
        },
      },
      setStatus: {
        description: 'Set an internal ticket status. This does not contact the customer.',
        inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'pending', 'resolved'] } }, required: ['status'], additionalProperties: false },
        run(ctx, { status }) { const ticket = supportTicket(ctx); if (ticket.status !== status) { ticket.status = status; ticket.updatedAt = supportStamp(ctx.app); } return { ticketId: ticket.id, status }; },
      },
      addNote: {
        description: 'Add an internal note attributed to the authenticated host principal.',
        inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 4000, pattern: '\\S' } }, required: ['text'], additionalProperties: false },
        run(ctx, { text }) {
          const ticket = supportTicket(ctx), time = supportStamp(ctx.app), noteId = `note_${ticket.id}_${ctx.app.clock.tick}`;
          if (ticket.notes.length >= 100) supportError('note_limit', 'A sample ticket supports at most 100 internal notes.');
          ticket.notes.push({ id: noteId, author: supportActor(ctx), body: text, createdAt: time }); ticket.updatedAt = time;
          return { ticketId: ticket.id, noteId };
        },
      },
    },
  }),
  definePanel({ type: 'customer', title: 'Customer context', description: 'Read-only account, subscription, invoice, payment and policy evidence.', dataSchema: SUPPORT_TICKET_DATA, actions: {} }),
  definePanel({
    type: 'composer', title: 'Review reply', description: 'A saved, human-editable reply draft. Approval records a review only: no email or refund is sent.', dataSchema: SUPPORT_TICKET_DATA,
    actions: {
      update: {
        description: 'Save exact draft text and clear any previous review. Use expectedRevision to protect against concurrent edits.',
        inputSchema: { type: 'object', properties: { body: { type: 'string', maxLength: 40000 } }, required: ['body'], additionalProperties: false },
        run(ctx, { body }) {
          const ticket = supportTicket(ctx), draft = ctx.app.drafts[ticket.id];
          if (!draft) supportError('draft_not_found', 'Prepare a reply before editing it.');
          if (draft.body !== body) { const time = supportStamp(ctx.app); draft.body = body; draft.status = 'draft'; draft.source = 'human'; draft.updatedAt = time; delete draft.reviewedAt; delete draft.reviewedBy; ticket.status = 'draft'; ticket.updatedAt = time; }
          return { ticketId: ticket.id, status: draft.status, saved: true };
        },
      },
      approve: {
        description: 'Record human review and mark the ticket pending. No email, refund or billing action is performed.', inputSchema: SUPPORT_EMPTY_INPUT,
        run(ctx) {
          const ticket = supportTicket(ctx), draft = ctx.app.drafts[ticket.id];
          if (!draft) supportError('draft_not_found', 'Prepare a reply before reviewing it.');
          if (!draft.body.trim()) supportError('empty_draft', 'A blank reply cannot be reviewed.');
          if (draft.status !== 'reviewed' || ticket.status !== 'pending') { const time = supportStamp(ctx.app); draft.status = 'reviewed'; draft.reviewedAt = time; draft.reviewedBy = supportActor(ctx); ticket.status = 'pending'; ticket.updatedAt = time; }
          return { ticketId: ticket.id, status: 'reviewed', ticketStatus: 'pending', emailSent: false, refundProcessed: false };
        },
      },
      discard: {
        description: 'Delete this ticket’s draft and close its composer. Preserve the conversation and billing records.', inputSchema: SUPPORT_EMPTY_INPUT,
        run(ctx) {
          const ticket = supportTicket(ctx), paneId = ctx.pane.id;
          delete ctx.app.drafts[ticket.id];
          if (ticket.status === 'draft') { ticket.status = 'open'; ticket.updatedAt = supportStamp(ctx.app); }
          const ticketId = ticket.id;
          ctx.call('pane.close', { paneId });
          return { ticketId, paneId, discarded: true };
        },
      },
    },
  }),
];

export function createSupportState(sessionId = 'support-desk') {
  return createSession({ id: sessionId, label: 'Relay support', view: 'inbox', title: 'Inbox', data: { query: '', status: 'all' }, app: supportSeedApp() });
}
