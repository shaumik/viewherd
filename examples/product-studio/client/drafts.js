// Drafts belong to this workspace, so closing a panel never loses someone's copy.
const editableFields = ["theme", "headline", "subhead", "cta", "format"];

export function designKey(design) {
  return JSON.stringify(editableFields.map((field) => design?.[field]));
}

export function pickDesign(design) {
  return Object.fromEntries(
    editableFields.map((field) => [
      field,
      design?.[field] ||
        (field === "theme" ? "sand" : field === "format" ? "square" : ""),
    ]),
  );
}

export function currentDesign(context) {
  return context.state.app.designs[context.pane.data.designId];
}

export function createDrafts() {
  const drafts = new Map();
  const editors = new Map();
  const listeners = new Set();

  function changed() {
    for (const listener of listeners) listener();
  }

  return {
    get: (id) => drafts.get(id),
    set: (id, draft) => drafts.set(id, draft),
    remove(id) {
      drafts.delete(id);
      changed();
    },
    clear() {
      drafts.clear();
      changed();
    },
    changed,
    hasUnsaved: () => [...drafts.values()].some((draft) => draft.dirty),
    recoverable: () =>
      [...drafts].find(([id, draft]) => draft.dirty && !editors.has(id)),
    editor: (id) => editors.get(id),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    registerEditor(id, editor) {
      editors.set(id, editor);
      changed();
      return () => {
        if (editors.get(id) === editor) editors.delete(id);
        const draft = drafts.get(id);
        if (draft && !draft.dirty && !draft.saving) drafts.delete(id);
        changed();
      };
    },

    async saveOpenEditors(recoverDesignId) {
      for (const [id, draft] of drafts) {
        if (!draft.dirty) continue;
        const editor = editors.get(id);
        if (!editor && id === recoverDesignId) continue;
        if (!editor) {
          throw new Error(
            "Your unsaved copy is safe. Recover or discard it in Studio chat before continuing.",
          );
        }
        await editor.save();
      }
    },
  };
}
