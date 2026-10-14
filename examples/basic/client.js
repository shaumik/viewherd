import { createClient } from "/sdk/client/index.mjs";
import { mountWorkspace } from "/sdk/dom/index.mjs";

const client = createClient({ sessionId: "basic" });
await client.snapshot();

// Each renderer owns its DOM and local drafts; the SDK owns shared panel state.
function mountNote(host, context) {
  host.innerHTML = `
    <form class="note">
      <label>Note text<textarea maxlength="1000"></textarea></label>
      <footer>
        <span role="status"></span>
        <button type="button" class="reload" hidden>Load latest note</button>
        <button>Save note</button>
      </footer>
    </form>`;
  const form = host.querySelector("form");
  const input = host.querySelector("textarea");
  const status = host.querySelector('[role="status"]');
  const reload = host.querySelector(".reload");
  const listeners = new AbortController();
  let dirty = false;
  let editRevision = context.state.revision;
  const update = (next) => {
    context = next;
    if (!dirty) {
      input.value = next.pane.data.text;
      editRevision = next.state.revision;
    }
  };
  reload.addEventListener(
    "click",
    () => {
      dirty = false;
      update(context);
      reload.hidden = true;
      status.textContent = "Loaded the latest note.";
    },
    { signal: listeners.signal },
  );
  input.addEventListener(
    "input",
    () => {
      if (!dirty) editRevision = context.state.revision;
      dirty = true;
      status.textContent = "Unsaved";
    },
    { signal: listeners.signal },
  );
  form.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      const text = input.value;
      try {
        const result = await context.action(
          "update",
          { text },
          { expectedRevision: editRevision },
        );
        editRevision = result.revision;
        dirty = input.value !== text;
        status.textContent = dirty ? "Unsaved" : "Saved";
      } catch (error) {
        status.textContent = error.message;
        if (error.code === "revision_conflict" && error.response?.state) {
          status.textContent =
            "Workspace changed. Copy your draft, or load the latest note.";
          reload.hidden = false;
        }
      }
    },
    { signal: listeners.signal },
  );
  update(context);
  return { update, destroy: () => listeners.abort() };
}

const workspace = mountWorkspace(document.querySelector("#workspace"), {
  client,
  panels: { note: { mount: mountNote } },
});
const chat = document.querySelector("#chat");
const messages = document.querySelector("#messages");
const field = document.querySelector("#message");
const send = document.querySelector("#send");

function addMessage(role, text) {
  const item = document.createElement("p");
  item.className = role;
  item.textContent = text;
  messages.append(item);
  item.scrollIntoView({ block: "nearest" });
}

chat.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = field.value.trim();
  if (!message || send.disabled) return;
  addMessage("user", message);
  send.disabled = true;
  try {
    const response = await fetch("/assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        requestId: crypto.randomUUID(),
        expectedRevision: client.state.revision,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    addMessage("assistant", result.reply);
    field.value = "";
    // The backend has committed; refresh before accepting another chat request.
    await client.snapshot();
  } catch (error) {
    addMessage("assistant", error.message);
  } finally {
    send.disabled = false;
    field.focus();
  }
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    field.value = button.dataset.prompt;
    chat.requestSubmit();
  });
});
window.addEventListener(
  "pagehide",
  () => {
    workspace.destroy();
    client.destroy();
  },
  { once: true },
);
