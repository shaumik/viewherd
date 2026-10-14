# Relay support desk

A reference application built with the Viewherd SDK. It demonstrates a useful workflow: investigate a duplicate charge, inspect the account and invoice evidence, prepare a factual draft, then let a person edit and review it.

## Run

From the repository root:

```sh
npm install --offline --ignore-scripts
npm run example
```

Open <http://localhost:4317>. The example uses the `support-desk` session. The local server persists state; a second browser client sees the same authoritative state through the SDK subscription.

The server listens on loopback. `PORT` changes its port; `WEBDR_SUPPORT_DATA_FILE` changes the support state file. Optional `WEBDR_TOKEN` protects access with a token, which the browser connection form accepts and API clients supply as a bearer header. The default local policy allows its one fictional session; replace it before exposing real data. Hosted access relies on the private deployment's platform authentication.

## Try the workflow

1. Open **SUP-1042**, Maya Chen's duplicate-charge ticket.
2. Open the customer context to inspect the plan and invoices.
3. Prepare a reply. The context panel closes and a composer opens beside the ticket.
4. Edit the draft, then mark it reviewed. The ticket becomes pending.
5. Open another ticket, search the inbox, add an internal note, or change its status.

The optional assistance walkthrough invokes these same SDK actions. It is a scripted sample workflow using fictional records. “Reviewed” records a local review decision; it does not send an email, refund money, or contact a customer.

## Where the integration lives

| File | Purpose |
| --- | --- |
| `domain.mjs` | Registered panel definitions, input schemas, action handlers, seeded application state |
| `app.js` | SDK client, panel renderers, workspace mounting, user interactions |
| `styles.css` | Application presentation; SDK shell styles stay in `packages/dom/styles.css` |
| `index.html` | Browser entry point |

The example stores tickets, accounts, notes, and drafts in `state.app`. Pane data identifies the ticket or filter displayed by that pane. Every domain change goes through `panel.action`; panel creation and removal use the same core layout engine as other Viewherd applications.

## Adapt it

Replace the seeded domain and panel action handlers with your application's validated state transitions, and replace the browser renderers with your own UI. Mount the server handler inside your authenticated application and authorize each session using your tenant policy. The example session policy is deliberately narrow; it is not a general user or tenant management system.

Handlers execute inside a state transaction and must be deterministic. Do not send mail, issue refunds, or call an external service from a handler: a storage conflict can retry it. For external effects, record an intent in application state and process it through your application's own reliable delivery mechanism.

See [the SDK guide](../../docs/SDK.md) for package adoption, authentication, the command contract, streaming, and replay limits.
