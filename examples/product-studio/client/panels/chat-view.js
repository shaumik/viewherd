import { el, button, icon } from "../ui.js";

// This file only builds and updates the chat DOM. The panel owns the agent request.
export function createChatView(host, onSend) {
  let disposed = false;
  let scheduledScroll = null;
  let assetSrc = null;
  const turnNodes = new Map();
  const root = el("section", "studio chat-studio");
  root.setAttribute("aria-label", "Studio chat");
  const head = el("div", "chat-header");
  const avatar = el("span", "assistant-avatar");
  avatar.append(icon("sparkle"));
  const heading = el("div", "chat-heading");
  heading.append(el("h1", "", "Forma assistant"));
  const modeLabel = el("p", "chat-mode", "Connecting to the agent…");
  heading.append(modeLabel);
  head.append(avatar, heading, el("span", "chat-server-badge", "SERVER"));
  const scroll = el("div", "chat-scroll");
  const introduction = el("div", "chat-intro");
  const asset = el("div", "chat-attachment");
  const img = el("img");
  img.alt = "FORMA One headphones";
  const metadata = el("div", "chat-attachment-meta");
  const assetName = el("strong");
  const assetCaption = el("span", "", "Product photo · ready to use");
  metadata.append(assetName, assetCaption);
  const file = el("input");
  file.type = "file";
  file.accept = "image/png,image/jpeg,image/webp";
  file.hidden = true;
  const upload = button("Replace", "chat-replace", null, () => file.click());
  upload.setAttribute("aria-label", "Replace the product photo");
  asset.append(img, metadata, upload, file);
  introduction.append(
    asset,
    el(
      "p",
      "chat-welcome",
      "I've got your product photo. Tell me what you want to make — I'll build it in the workspace beside us.",
    ),
  );
  const transcript = el("div", "chat-transcript");
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-label", "Conversation with Forma assistant");
  transcript.setAttribute("aria-live", "polite");
  transcript.setAttribute("aria-relevant", "additions text");
  const starters = el("div", "chat-starters");
  const starterLabel = el("p", "", "TRY ASKING");
  starters.append(starterLabel);
  const create = button(
    "Create two launch directions",
    "chat-starter",
    "arrow",
    () => onSend("Create two launch directions for this product."),
  );
  const dark = button(
    "Make it midnight. Less noise. More you.",
    "chat-starter",
    "arrow",
    () =>
      onSend(
        'Make it midnight and change the headline to "Less noise. More you."',
      ),
  );
  starters.append(create, dark);
  const recovery = el("div", "draft-recovery");
  recovery.hidden = true;
  scroll.append(introduction, transcript, starters, recovery);
  const bottom = el("div", "chat-bottom");
  const error = el("p", "chat-error");
  error.hidden = true;
  error.setAttribute("role", "alert");
  const form = el("form", "chat-composer");
  const input = el("textarea");
  input.rows = 2;
  input.maxLength = 2000;
  input.placeholder = "Ask the agent to change your workspace…";
  input.setAttribute("aria-label", "Message the assistant");
  const composeRow = el("div", "chat-composer-row");
  const hint = el("span", "chat-compose-hint", "Enter to send");
  const sendButton = button("", "chat-send", "arrow");
  sendButton.type = "submit";
  sendButton.setAttribute("aria-label", "Send message");
  composeRow.append(hint, sendButton);
  form.append(input, composeRow);
  const footnote = el("p", "chat-footnote");
  footnote.append(
    document.createTextNode("The agent calls Viewherd on the server. "),
  );
  const sdkLink = el("a", "", "Connect your own agent");
  sdkLink.href = "https://github.com/shaumik/viewherd/blob/main/docs/SDK.md";
  sdkLink.target = "_blank";
  sdkLink.rel = "noopener noreferrer";
  footnote.append(sdkLink);
  bottom.append(error, form, footnote);
  root.append(head, scroll, bottom);
  host.append(root);

  function nearBottom() {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 72;
  }
  function scrollToLatest(force = false) {
    if (!force && !nearBottom()) return;
    if (scheduledScroll !== null) cancelAnimationFrame(scheduledScroll);
    scheduledScroll = requestAnimationFrame(() => {
      scheduledScroll = null;
      if (!disposed) scroll.scrollTop = scroll.scrollHeight;
    });
  }
  function makeTurn(turn) {
    const node = el("article", "chat-turn");
    const user = el("div", "chat-user-message");
    const reply = el("div", "chat-assistant-message");
    const response = el("p", "chat-response");
    const steps = el("div", "chat-tool-steps");
    const status = el("p", "chat-turn-status");
    reply.append(response, steps, status);
    node.append(user, reply);
    const entry = { node, user, response, steps, status, stepNodes: new Map() };
    turnNodes.set(turn.id, entry);
    return entry;
  }
  function paintTurn(turn) {
    const entry = turnNodes.get(turn.id) || makeTurn(turn);
    entry.user.textContent = turn.message || "";
    entry.response.textContent = turn.reply || "";
    entry.response.hidden = !turn.reply;
    const seen = new Set();
    for (const step of turn.steps || []) {
      if (!step || typeof step.id !== "string") continue;
      seen.add(step.id);
      let row = entry.stepNodes.get(step.id);
      if (!row) {
        row = el("div", "chat-tool-step");
        row.append(el("span", "chat-step-icon"), el("span", "chat-step-label"));
        entry.stepNodes.set(step.id, row);
        entry.steps.append(row);
      }
      row.dataset.status = step.status;
      row.querySelector(".chat-step-icon").textContent =
        step.status === "done" ? "✓" : step.status === "failed" ? "!" : "·";
      row.querySelector(".chat-step-label").textContent =
        step.label || "Update workspace";
      if (step.error) row.title = step.error;
      else row.removeAttribute("title");
    }
    for (const [id, row] of entry.stepNodes)
      if (!seen.has(id)) {
        row.remove();
        entry.stepNodes.delete(id);
      }
    entry.steps.hidden = !turn.steps?.length;
    entry.status.hidden =
      turn.status === "completed" || (!!turn.reply && turn.status !== "failed");
    entry.status.textContent =
      turn.status === "failed"
        ? "This turn could not finish. Your changes are still in the workspace."
        : turn.steps?.length
          ? "Working in your workspace…"
          : "Thinking…";
    entry.status.dataset.status = turn.status;
    return entry.node;
  }
  function renderTurns(turns, { streamError = null, force = false } = {}) {
    const follow = force || nearBottom();
    const seen = new Set();
    for (const turn of turns) {
      if (!turn || typeof turn.id !== "string") continue;
      seen.add(turn.id);
      const node = paintTurn(turn);
      // Keep existing message nodes connected while streaming text and tool results.
      const previous = transcript.children[seen.size - 1];
      if (previous !== node) transcript.insertBefore(node, previous || null);
    }
    for (const [id, entry] of turnNodes)
      if (!seen.has(id)) {
        entry.node.remove();
        turnNodes.delete(id);
      }
    starters.hidden = turns.length > 0;
    introduction.classList.toggle("has-conversation", turns.length > 0);
    error.hidden = !streamError;
    error.textContent = streamError || "";
    if (follow) scrollToLatest(true);
  }

  return {
    root,
    input,
    form,
    file,
    upload,
    create,
    dark,
    sendButton,
    recovery,
    renderTurns,
    renameTurn(from, to) {
      const entry = turnNodes.get(from);
      if (!entry) return;
      turnNodes.delete(from);
      turnNodes.set(to, entry);
    },
    setMode(mode, model) {
      modeLabel.textContent =
        mode === "openai"
          ? `${model || "OpenAI agent"} · runs on server`
          : "Demo agent · runs on server";
    },
    unavailable() {
      modeLabel.textContent = "Agent connection unavailable";
    },
    setBusy({ locked, sending }) {
      input.disabled = locked;
      sendButton.disabled = locked || !input.value.trim();
      upload.disabled = locked;
      create.disabled = dark.disabled = locked;
      hint.textContent = !locked
        ? "Enter to send"
        : sending
          ? "Agent is working…"
          : "Another agent is working…";
      form.dataset.busy = String(locked);
    },
    setAsset(asset) {
      if (assetSrc !== asset.src) {
        img.src = asset.src;
        assetSrc = asset.src;
      }
      img.alt = asset.name;
      assetName.textContent = asset.name;
    },
    destroy() {
      disposed = true;
      if (scheduledScroll !== null) cancelAnimationFrame(scheduledScroll);
    },
  };
}
