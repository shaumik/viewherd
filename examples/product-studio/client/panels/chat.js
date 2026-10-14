import { el, button, handled } from "../ui.js";
import { normalizePhoto } from "../images.js";
import { getAgentInfo, sendMessage, applyTurnEvent } from "../chat-stream.js";
import { createChatView } from "./chat-view.js";

export function mountChat(
  host,
  initialContext,
  { client, actions, drafts, notify },
) {
  let context = initialContext;
  let disposed = false;
  let sending = false;
  let localTurn = null;
  let streamController = null;
  let agentMode = "demo";
  let model = null;
  let streamError = null;
  let expiryTimer = null;
  const infoController = new AbortController();
  const view = createChatView(host, (message) => handled(send(message)));
  const {
    root,
    input,
    form,
    file,
    upload,
    create,
    dark,
    sendButton,
    recovery,
  } = view;

  function activeTurn() {
    const chat = context.state.app.chat;
    return chat?.turns?.find(
      (turn) =>
        turn.id === chat.activeTurnId &&
        turn.status === "running" &&
        Number.isFinite(turn.expiresAt) &&
        turn.expiresAt > Date.now(),
    );
  }
  function setBusy(value) {
    sending = value;
    const remote = activeTurn();
    const locked = value || !!remote;
    actions.setAgentBusy(root, locked);
    clearTimeout(expiryTimer);
    expiryTimer = null;
    if (remote)
      expiryTimer = setTimeout(
        () => {
          if (!disposed) {
            setBusy(sending);
            paintConversation();
          }
        },
        Math.min(2147483647, Math.max(1, remote.expiresAt - Date.now() + 1)),
      );
    view.setBusy({ locked, sending: value });
  }
  function paintConversation(force = false) {
    const remote = context.state.app.chat?.turns || [];
    const turns = remote.filter(
      (turn) => !localTurn || turn.id !== localTurn.id,
    );
    if (localTurn) turns.push(localTurn);
    view.renderTurns(turns, { streamError, force });
  }

  function reconcileTurn() {
    const persisted = client.state?.app?.chat?.turns?.find(
      (turn) => turn.id === localTurn?.id,
    );
    if (persisted && persisted.status !== "running") localTurn = null;
  }

  function paintRecovery() {
    if (disposed) return;
    const orphan = drafts.recoverable();
    recovery.hidden = !orphan;
    recovery.replaceChildren();
    if (!orphan) return;
    const [id, draft] = orphan;
    const exists = !!context.state.app.designs[id];
    recovery.append(
      el("p", "brief-label", "Your unsaved copy is safe."),
      el(
        "p",
        "recovery-note",
        exists
          ? "The editor closed elsewhere. Resume your draft before continuing."
          : "The original design was removed elsewhere. Copy your draft or discard it to continue.",
      ),
    );
    const copy = el("textarea", "recovery-copy");
    copy.readOnly = true;
    copy.rows = 4;
    copy.setAttribute("aria-label", "Preserved unsaved campaign copy");
    copy.value = [
      draft.values.headline,
      draft.values.subhead,
      draft.values.cta,
    ].join("\n\n");
    recovery.append(copy);
    const resume = button("Resume editing", "secondary-button", null, () =>
      handled(
        actions.run(
          async () => {
            await actions.call("select", { designId: id });
            return actions.call("inspect");
          },
          "Your unsaved draft is back.",
          { recoverDesignId: id },
        ),
      ),
    );
    resume.hidden = !exists;
    const discard = button(
      "Discard local draft",
      "secondary-button",
      null,
      () => {
        drafts.remove(id);
        notify("Local draft discarded. The studio is ready.");
      },
    );
    const row = el("div", "recovery-actions");
    row.append(resume, discard);
    recovery.append(row);
  }
  const unsubscribeRecovery = drafts.subscribe(paintRecovery);
  async function send(value) {
    const message = (typeof value === "string" ? value : input.value).trim();
    if (!message || sending || activeTurn() || actions.busy()) return;
    if (message.length > 2000) {
      streamError = "Keep your request under 2,000 characters.";
      paintConversation();
      return;
    }
    streamError = null;
    setBusy(true);
    input.value = "";
    paintConversation();
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    streamController = controller;
    const timeout = setTimeout(() => controller.abort(), 180000);
    let completed = false;
    let failed = false;
    try {
      await drafts.saveOpenEditors();
      if (disposed) return;
      localTurn = {
        id: requestId,
        message,
        mode: agentMode,
        status: "running",
        reply: "",
        steps: [],
      };
      paintConversation(true);
      await sendMessage({
        requestId,
        message,
        signal: controller.signal,
        onEvent(event) {
          if (disposed) return;
          const previousId = localTurn.id;
          localTurn = applyTurnEvent(localTurn, event);
          if (event.type === "start") {
            view.renameTurn(previousId, localTurn.id);
            if (["demo", "openai"].includes(event.mode)) {
              agentMode = event.mode;
              view.setMode(agentMode, model);
            }
          }
          if (event.type === "done") {
            completed = true;
            failed = localTurn.status === "failed";
          }
          if (event.type === "error") {
            streamError =
              typeof event.message === "string"
                ? event.message
                : "The assistant could not finish this turn.";
          }
          paintConversation();
        },
      });
      // Read the latest authoritative workspace immediately; SSE remains subscribed.
      try {
        await client.snapshot();
      } catch {
        notify("The agent finished. Reconnecting to your live workspace…");
      }
      reconcileTurn();
      if (failed) input.value = message;
    } catch (failure) {
      if (disposed) return;
      streamError =
        failure.name === "AbortError"
          ? "The assistant connection timed out. Your workspace is safe. Try again."
          : failure.message ||
            "The assistant connection was interrupted. Try again.";
      input.value = message;
      if (localTurn) localTurn.status = "failed";
      try {
        await client.snapshot();
      } catch {}
      reconcileTurn();
    } finally {
      clearTimeout(timeout);
      if (streamController === controller) streamController = null;
      if (!disposed) {
        setBusy(false);
        paintConversation();
        const focused = document.activeElement;
        if (
          completed &&
          !failed &&
          input.offsetParent !== null &&
          (focused === document.body ||
            form.contains(focused) ||
            focused === create ||
            focused === dark)
        )
          input.focus({ preventScroll: true });
      } else actions.setAgentBusy(root, false);
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handled(send());
  });
  input.addEventListener("input", () => {
    sendButton.disabled = sending || !!activeTurn() || !input.value.trim();
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      handled(send());
    }
  });
  file.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    if (!chosen || sending) return;
    streamError = null;
    upload.disabled = true;
    try {
      const src = await normalizePhoto(chosen);
      await actions.run(
        () =>
          context.action("upload", {
            src,
            name: chosen.name.trim().slice(0, 80) || "Product photo",
          }),
        "Your product photo is now in every direction.",
      );
    } catch (failure) {
      streamError = failure.message;
      paintConversation();
    } finally {
      file.value = "";
      if (!disposed) upload.disabled = sending || !!activeTurn();
    }
  });
  getAgentInfo(infoController.signal)
    .then((info) => {
      if (disposed) return;
      agentMode = info.mode === "openai" ? "openai" : "demo";
      model = typeof info.model === "string" ? info.model : null;
      view.setMode(agentMode, model);
    })
    .catch(() => {
      if (!disposed) view.unavailable();
    });
  function update(next) {
    context = next;
    const app = context.state.app;
    view.setAsset(app.asset);
    if (!sending && localTurn) {
      reconcileTurn();
    }
    setBusy(sending);
    paintConversation();
    queueMicrotask(paintRecovery);
  }
  update(context);
  return {
    update,
    destroy() {
      disposed = true;
      infoController.abort();
      streamController?.abort();
      clearTimeout(expiryTimer);
      view.destroy();
      unsubscribeRecovery();
      actions.setAgentBusy(root, false);
    },
  };
}
