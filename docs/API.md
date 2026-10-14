# Legacy Viewherd lab API

This document describes the original standalone lab at `/lab`. For embedding applications and the current `/mcp` endpoint, see [the SDK guide](SDK.md).

The web UI, CLI, and MCP bridge operate the same workspace runtime. Use structured actions and returned IDs; no screen coordinates or DOM selectors are needed for built-in views.

## HTTP protocol

| Endpoint | Purpose |
| --- | --- |
| `GET /api/state` | Current full state, including its revision |
| `GET /api/schema` | Method descriptors and parameter schemas |
| `GET /api/events?after=REVISION` | Events newer than the supplied revision |
| `POST /api/rpc` | Read or mutate the workspace through a named method |
| `GET /api/preview/PANE_ID` | Sandboxed HTML preview content |
| `POST /lab/mcp` | HTTP MCP JSON-RPC endpoint with the same tools |

RPC request:

```json
{
  "id": "agent-run-001-step-1",
  "method": "workspace.create",
  "params": {
    "actor": "agent:release-review",
    "label": "Release review",
    "view": "document",
    "title": "Summary",
    "data": { "content": "Review in progress." }
  }
}
```

Successful response:

```json
{
  "id": "agent-run-001-step-1",
  "revision": 1,
  "result": {
    "workspaceId": "ws_…",
    "tabId": "tab_…",
    "paneId": "pane_…",
    "workspace": {}
  },
  "state": {}
}
```

The empty objects above abbreviate full objects. Use `result` IDs instead of guessing them. `state` is the server's current snapshot. Every successful change increases `revision` and appends an actor-attributed event. Read-only operations and no-op mutations do not advance the revision.

Use a unique request `id` for each intended operation. Retry an uncertain response with the same ID, method, and params. The transport retains the last 24 request receipts; it is not a permanent deduplication ledger. Inspect current state after a long disconnection. An optional top-level `expectedRevision` applies a compare-and-set check to reject stale mutations.

The schema endpoint is authoritative for the running version. The `api.schema` RPC additionally returns view types and limits. Send JSON objects as `params`. `actor` is optional and records attribution; it does not grant access. The UI uses a human actor and the CLI defaults to `agent:cli`.

## Workspace and layout methods

| Method | Main params | Result |
| --- | --- | --- |
| `session.snapshot` | None | Full state |
| `api.schema` | None | `methods`, `views`, `limits` |
| `workspace.list` | None | `workspaces` |
| `workspace.create` | `label`, optional `view`, `title`, `data` | `workspaceId`, `tabId`, `paneId`, `workspace` |
| `workspace.focus` | `workspaceId` | `workspaceId` |
| `workspace.rename` | `label`, optional `workspaceId` | Workspace |
| `workspace.close` | `workspaceId` | Closed ID |
| `tab.list` | Optional `workspaceId` | `workspaceId`, `tabs` |
| `tab.create` | `label`, optional `workspaceId`, `view`, `title`, `data` | `workspaceId`, `tabId`, `paneId`, `tab` |
| `tab.focus` | `tabId` | Workspace and tab IDs |
| `tab.rename` | `label`, optional `tabId` | Tab |
| `tab.close` | `tabId` | Closed tab ID |
| `pane.list` | Optional `tabId` | Workspace/tab IDs and `panes` |
| `pane.get` | Optional `paneId` | Workspace/tab IDs and `pane` |
| `pane.split` | Optional `paneId`, `direction`, `ratio`, `view`, `title`, `data` | New `paneId`, `splitId`, `pane` |
| `pane.resize` | `splitId`, `ratio` | Split ID and ratio |
| `pane.focus` | `paneId` | Workspace/tab/pane IDs |
| `pane.move` | `paneId`, `targetPaneId`, optional `direction` | Moved pane and new split IDs |
| `pane.zoom` | Optional `paneId`, `enabled` | Pane ID and enabled state |
| `pane.close` | `paneId` | Closed pane ID |

Omitted location IDs target the active workspace, tab, or focused pane. For agent workflows, explicit IDs avoid relying on a person's current selection.

Split directions are `right` and `down`. The ratio is the fraction assigned to the first child, between `0.1` and `0.9`. Layouts are binary trees: a pane leaf has `{type:"pane",paneId}`, while a split has `{type:"split",id,direction,ratio,first,second}`. Use split IDs for resizing; use pane IDs for content and focus.

Pane moves may cross tabs in the same workspace. The final workspace, tab, or pane cannot be closed. Moving the final pane out of a tab is rejected. These constraints keep the workspace usable.

## Views and data

| View | Data | Structured actions |
| --- | --- | --- |
| `document` | `{content: string}` | `set`, `append` with `args.content` |
| `tasks` | `{items: [{id,text,done}]}` | `add`, `toggle`, `remove` |
| `preview` | `{html: string}` | `set_html` with `args.html` |
| `activity` | `{}` | Read the session event log |
| `api` | `{targetPaneId?: string}` | A controller that sends workspace RPC operations to other panels |

`view.open` replaces the existing view: `{paneId,view,title?,data?}`. `view.update` merges data into a view: `{paneId,title?,data}`. `view.action` applies a structured action: `{paneId,action,args}`.

Example task addition:

```json
{
  "id": "review-add-task-1",
  "method": "view.action",
  "params": {
    "paneId": "pane_…",
    "action": "add",
    "args": { "id": "check-accessibility", "text": "Review keyboard access" }
  }
}
```

For `add`, `args.text` is required; `args.id` and `args.done` are optional. The response includes `taskId`. For `toggle`, send `args.id` and optionally `args.done`; omitting `done` toggles the task. For `remove`, send `args.id`. Use an explicit `done` value for idempotent completion.

Example preview update:

```json
{
  "id": "preview-update-1",
  "method": "view.action",
  "params": {
    "paneId": "pane_…",
    "action": "set_html",
    "args": { "html": "<!doctype html><h1>Hello from the agent</h1>" }
  }
}
```

Preview HTML runs in a sandboxed frame. This operation supplies HTML; it does not navigate or automate unrelated websites. Preview-local interactions are separate from the structured workspace state unless an integration explicitly connects them.

### Cross-panel control

A controller pane uses its own ID for attribution and the target pane's ID for the operation. For example, this request from `pane_controller` appends text to `pane_target`:

```json
{
  "id": "controller-step-1",
  "method": "view.action",
  "params": {
    "actor": "panel:pane_controller",
    "paneId": "pane_target",
    "action": "append",
    "args": { "content": "\n\nWritten from another panel." }
  }
}
```

To create a sibling, call `pane.split` with the controller ID. To remove the target, call `pane.close` with the target ID. No special cross-panel transport is needed: both panels use the same authoritative workspace API.

## Agent reporting

```json
{
  "id": "agent-status-1",
  "method": "agent.report",
  "params": {
    "actor": "agent:release-review",
    "id": "release-review",
    "name": "Release review agent",
    "status": "working",
    "paneId": "pane_…",
    "message": "Checking the release checklist."
  }
}
```

The outer `id` identifies the RPC request. `params.id` identifies the agent. Status is `idle`, `working`, `blocked`, or `done`. An optional pane association communicates where the agent is working; it is not an exclusive lock or authorization boundary.

## Events and limits

Events contain `id`, `revision`, `time`, `method`, `actor`, and `summary`. Poll `/api/events?after=REVISION` or use `viewherd watch`. The response has `{revision,events,resetRequired}`. Keep the highest observed revision as the cursor. Take another snapshot when `resetRequired` is true. The CLI emits event objects as JSON lines.

Current limits are 16 workspaces per session, 16 tabs per workspace, 32 panes per session, 100,000 characters per document or preview, 1,000 tasks per task board, 32 agent records, and 150 recent events. Call `api.schema` for limits in your deployed version.

## MCP bridge

Run `node bin/viewherd.mjs --mcp-stdio`. The bridge supports `initialize`, `ping`, `tools/list`, and `tools/call` over newline-delimited JSON-RPC. It exposes:

| Tool | Arguments |
| --- | --- |
| `viewherd_schema` | `{}` |
| `viewherd_snapshot` | `{}` |
| `viewherd_call` | `{method,params?,id?,expectedRevision?}` |

Tool failures return `isError: true`. Standard output contains only protocol messages. Configure `VIEWHERD_URL` and optional credentials in the MCP client's environment. An MCP client controls model choice and task execution; the bridge does not create or run an AI model.

The HTTP lab at `POST /lab/mcp` retains the legacy names `webdr_schema`, `webdr_snapshot`, and `webdr_call`. Its call tool accepts `id` or `requestId`. Both transports accept `expectedRevision`; inspect `tools/list` on the transport you use. Hosted access requires authorized service access.
