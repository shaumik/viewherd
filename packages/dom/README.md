# @viewherd/dom

Dependency-free ESM workspace shell for your panel renderers. This local package is not yet published to npm. Load `@viewherd/dom/styles.css` in your app's stylesheet or serve it as a browser asset.

```js
import { mountWorkspace } from '@viewherd/dom';

const workspace = mountWorkspace(document.querySelector('#workspace'), {
  client,
  panels: {
    ticket: {
      mount(host, context) {
        const title = document.createElement('h2');
        host.append(title);
        const update = ctx => { title.textContent = ctx.pane.title; };
        update(context);
        return { update, destroy() { /* Remove renderer-owned listeners. */ } };
      }
    }
  }
});
// Before removing this application's workspace:
workspace.destroy();
```

The mount context is `{pane, state, client, action}`. `action(name, args, options)` calls `panel.action` with this pane's explicit ID. `mount` returns its lifecycle synchronously. `update` receives each accepted authoritative snapshot. Keep local input drafts inside your renderer and use `expectedRevision` when committing edits.

The shell supplies tabs, pane titles, focus, close/zoom controls, and pointer/keyboard split resizing. It automatically subscribes and fetches a snapshot if the client does not have one. Await `client.snapshot()` before mounting when the host wants to handle initial authentication/loading errors itself. Destroying the shell unsubscribes and destroys renderers; it does not destroy a shared client.

Pane hosts remain connected in the same DOM parent across splits, moves, tab switches, and zoom changes. A renderer is destroyed when its pane is deleted or its view type changes. Hidden tabs retain mounted renderer state. New, inactive panes mount lazily on their first visible tab. Compact layouts display the focused panel plus a panel switcher below 640px canvas width, or below 980px with three or more panels. Set `compactBreakpoint` and `multiPaneBreakpoint` to customize these widths in pixels. Both accept finite nonnegative numbers; `0` disables that rule. For example, `multiPaneBreakpoint: 0` keeps a chat panel and two previews visible together on smaller desktops while preserving the default phone layout.

All structural classes use the `wd-` prefix; styles live below `.wd-workspace`. Customize `--wd-pane-gap`, `--wd-pane-radius`, `--wd-pane-border`, `--wd-pane-background`, `--wd-pane-header-background`, and `--wd-pane-header-height`. The header-height variable can be set per pane using `[data-view="ticket"]`. Render your own application toolbar inside the panel when appropriate. `onPaneClose(pane, context)` overrides the standard close command; `onPaneFocus` is a notification before the focus command.
