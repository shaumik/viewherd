import { createClient } from "/sdk/client/index.mjs";
import { mountWorkspace } from "/sdk/dom/index.mjs";
import { createActions } from "./actions.js";
import { createDrafts } from "./drafts.js";
import { createNotifications, handled } from "./ui.js";
import { mountChat } from "./panels/chat.js";
import { mountCanvas } from "./panels/canvas.js";
import { mountInspector } from "./panels/inspector.js";
import { mountExports } from "./panels/exports.js";

const client = createClient({
  baseUrl: "/viewherd",
  sessionId: "product-studio",
  onConnection({ status }) {
    document.querySelector(".connection").dataset.status = status;
    document.getElementById("connection-label").textContent =
      {
        connected: "Live workspace",
        connecting: "Connecting",
      }[status] || "Reconnecting";
  },
});

const notifications = createNotifications(document.getElementById("toast"));
const { notify } = notifications;
const drafts = createDrafts();
const actions = createActions({ client, drafts, notify });
const dependencies = { client, actions, drafts, notify };

// The host registers its own panel renderers. Viewherd manages their lifecycle.
const workspace = mountWorkspace(document.getElementById("workspace"), {
  client,
  tabBar: false,
  multiPaneBreakpoint: 0,
  panels: {
    studio: {
      mount: (host, context) => mountChat(host, context, dependencies),
    },
    canvas: {
      mount: (host, context) => mountCanvas(host, context, dependencies),
    },
    inspector: {
      mount: (host, context) => mountInspector(host, context, dependencies),
    },
    deliverables: {
      mount: (host, context) => mountExports(host, context, dependencies),
    },
  },
  onPaneClose(pane, context) {
    if (pane.view === "studio") return;
    if (pane.view === "inspector" && drafts.get(pane.data.designId)?.dirty) {
      notify(
        "Save your changes or choose Use latest before closing this editor.",
        true,
      );
      return;
    }
    return actions.run(() =>
      pane.view === "canvas"
        ? context.action("remove", {})
        : client.call("pane.close", { paneId: pane.id }),
    );
  },
});

const resetButton = document.getElementById("reset-demo");
const unsubscribeBusy = actions.subscribe((busy) => {
  resetButton.disabled = busy;
});
resetButton.addEventListener("click", () =>
  handled(
    actions.run(async () => {
      await actions.call("reset");
      drafts.clear();
    }, "A fresh brief. Make something good."),
  ),
);

document
  .getElementById("retry-connect")
  .addEventListener("click", () => location.reload());
window.addEventListener("beforeunload", (event) => {
  if (!drafts.hasUnsaved()) return;
  event.preventDefault();
  event.returnValue = "";
});

client.snapshot().catch((error) => {
  document.getElementById("boot-error").hidden = false;
  notify(error.message || "This studio could not connect.", true);
});

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  workspace.destroy();
  client.destroy();
  unsubscribeBusy();
  notifications.destroy();
});
