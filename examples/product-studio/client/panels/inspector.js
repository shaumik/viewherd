import { el, button, handled } from "../ui.js";
import { currentDesign, designKey, pickDesign } from "../drafts.js";
import { DESIGN_THEMES } from "../../render.mjs";

export function mountInspector(
  host,
  initialContext,
  { client, drafts, notify },
) {
  let context = initialContext;
  let disposed = false;
  let saving = false;
  const designId = initialContext.pane.data.designId;
  let draft = drafts.get(designId);
  if (!draft) {
    draft = {
      values: pickDesign(currentDesign(context)),
      base: designKey(currentDesign(context)),
      dirty: false,
    };
    drafts.set(designId, draft);
  }
  const root = el("form", "inspector");
  root.append(
    el("div", "overline", "Your creative control"),
    el("h2", "inspector-title", "Make it yours."),
    el(
      "p",
      "inspector-description",
      "The artboard stays live. Your draft stays yours until you save.",
    ),
  );
  const inputs = {};
  const themeField = el("div", "field");
  themeField.append(el("span", "field-label", "Color direction"));
  const themeOptions = el("div", "theme-options");
  const themeButtons = new Map();
  for (const theme of DESIGN_THEMES) {
    const control = button(theme.label, "theme-option", null, () => {
      draft.values.theme = theme.id;
      changed();
      paintThemes();
    });
    const swatch = el("span", "theme-swatch");
    swatch.style.background = theme.background;
    control.prepend(swatch);
    control.setAttribute("aria-label", `${theme.label} color direction`);
    themeButtons.set(theme.id, control);
    themeOptions.append(control);
  }
  themeField.append(themeOptions);
  root.append(themeField);
  function field(key, label, tag = "input", maxLength) {
    const wrapper = el("label", "field");
    wrapper.append(el("span", "field-label", label));
    const input = el(tag);
    input.name = key;
    if (maxLength) input.maxLength = maxLength;
    if (tag === "textarea") input.rows = key === "headline" ? 2 : 3;
    input.value = draft.values[key];
    inputs[key] = input;
    wrapper.append(input);
    root.append(wrapper);
    input.addEventListener("input", () => {
      draft.values[key] = input.value;
      changed();
    });
    return input;
  }
  field("headline", "Headline", "textarea", 80);
  field("subhead", "Supporting copy", "textarea", 140);
  field("cta", "Call to action", "input", 32);
  const size = field("format", "Canvas size", "select");
  for (const [value, label] of [
    ["square", "Social square · 1080 × 1080"],
    ["story", "Story · 1080 × 1920"],
  ]) {
    const option = el("option", "", label);
    option.value = value;
    size.append(option);
  }
  size.value = draft.values.format;
  size.addEventListener("change", () => {
    draft.values.format = size.value;
    changed();
  });
  const badge = el("span", "dirty-badge", "Unsaved changes");
  const row = el("div", "inspector-save-row");
  const saveButton = button("Save design", "primary-button", "check");
  saveButton.type = "submit";
  const discard = button("Use latest", "secondary-button", null, () => {
    draft.values = pickDesign(currentDesign(context));
    draft.base = designKey(currentDesign(context));
    draft.dirty = false;
    paintValues();
    status.textContent = "Latest saved design restored.";
    status.dataset.error = "false";
  });
  row.append(saveButton, discard);
  const status = el("p", "form-message");
  status.setAttribute("role", "status");
  root.append(badge, row, status);
  host.append(root);
  function changed() {
    draft.dirty = designKey(draft.values) !== draft.base;
    drafts.set(designId, draft);
    badge.hidden = !draft.dirty;
    saveButton.disabled = !draft.dirty || saving;
    status.textContent = draft.dirty
      ? "Changes are saved when you choose Save design."
      : "";
    status.dataset.error = "false";
  }
  function paintThemes() {
    for (const [id, control] of themeButtons)
      control.setAttribute("aria-pressed", String(id === draft.values.theme));
  }
  function paintValues() {
    for (const [key, input] of Object.entries(inputs))
      input.value = draft.values[key];
    paintThemes();
    changed();
  }
  function lock(value) {
    saving = value;
    draft.saving = value;
    for (const input of Object.values(inputs)) input.disabled = value;
    for (const control of themeButtons.values()) control.disabled = value;
    discard.disabled = value;
    saveButton.disabled = value || !draft.dirty;
    saveButton.querySelector("span").textContent = value
      ? "Saving…"
      : "Save design";
  }
  async function save() {
    if (!draft.dirty) return;
    if (saving || draft.saving)
      throw new Error("Your design is still saving. Try again in a moment.");
    if (designKey(currentDesign(context)) !== draft.base) {
      status.textContent =
        "This design changed elsewhere. Your draft is safe. Choose Use latest to review the new version.";
      status.dataset.error = "true";
      throw new Error(
        "This design changed elsewhere. Your unsaved copy is preserved in Edit design.",
      );
    }
    lock(true);
    try {
      // A pane-focus change can advance the revision without editing this design.
      // Retry harmless conflicts, but retain the draft when its saved design changed.
      for (let attempt = 0; ; attempt++) {
        try {
          await context.action(
            "update",
            { ...draft.values },
            { expectedRevision: context.state.revision },
          );
          break;
        } catch (error) {
          if (
            attempt >= 2 ||
            error.code !== "revision_conflict" ||
            designKey(currentDesign(context)) !== draft.base
          )
            throw error;
        }
      }
      const savedDesign = client.state?.app?.designs?.[designId];
      if (!savedDesign)
        throw new Error(
          "This design was removed while saving. Your copy is preserved in Studio chat.",
        );
      draft.values = pickDesign(savedDesign);
      draft.base = designKey(savedDesign);
      draft.dirty = false;
      if (!disposed) {
        paintValues();
        status.textContent = "Saved. Your live artboard has been updated.";
        status.dataset.error = "false";
      }
    } catch (error) {
      if (!disposed) {
        status.textContent =
          error.message || "Could not save. Your draft is still here.";
        status.dataset.error = "true";
      }
      throw error;
    } finally {
      draft.saving = false;
      if (!disposed) lock(false);
      else {
        const mounted = drafts.editor(designId);
        if (mounted) mounted.refresh();
        else if (!draft.dirty) drafts.remove(designId);
        drafts.changed();
      }
    }
  }
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    handled(
      save()
        .then(() => notify("Saved to your live artboard."))
        .catch((error) => {
          notify(error.message, true);
          throw error;
        }),
    );
  });
  const editor = {
    save,
    dirty: () => draft.dirty,
    refresh() {
      paintValues();
      lock(!!draft.saving);
    },
  };
  const unregisterEditor = drafts.registerEditor(designId, editor);
  function update(next) {
    context = next;
    const design = currentDesign(context);
    if (!design) {
      status.textContent =
        "This design was removed elsewhere. Your unsaved copy is preserved in Studio chat.";
      status.dataset.error = "true";
      saveButton.disabled = true;
      return;
    }
    if (!draft.dirty && !saving) {
      draft.values = pickDesign(design);
      draft.base = designKey(design);
      paintValues();
    }
  }
  paintValues();
  lock(!!draft.saving);
  return {
    update,
    destroy() {
      disposed = true;
      unregisterEditor();
    },
  };
}
