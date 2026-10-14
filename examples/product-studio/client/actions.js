// People and the agent share one mutation lock. Flush human drafts before changes.
export function createActions({ client, drafts, notify }) {
  let running = false;
  const agentLocks = new Set();
  const listeners = new Set();

  function busy() {
    return running || agentLocks.size > 0;
  }

  function changed() {
    for (const listener of listeners) listener(busy());
  }

  return {
    busy,
    subscribe(listener) {
      listeners.add(listener);
      listener(busy());
      return () => listeners.delete(listener);
    },

    setAgentBusy(owner, value) {
      if (value) agentLocks.add(owner);
      else agentLocks.delete(owner);
      changed();
    },

    async call(action, args = {}) {
      const pane = Object.values(client.state?.panes || {}).find(
        (pane) => pane.view === "studio",
      );
      if (!pane) throw new Error("Open Studio chat to continue.");
      return client.call("panel.action", { paneId: pane.id, action, args });
    },

    async run(task, message, { recoverDesignId } = {}) {
      if (busy()) {
        notify("Let the assistant finish this turn first.");
        return;
      }
      running = true;
      changed();
      try {
        await drafts.saveOpenEditors(recoverDesignId);
        const result = await task();
        if (message)
          notify(typeof message === "function" ? message(result) : message);
        return result;
      } catch (error) {
        notify(error.message || "That change could not be completed.", true);
        throw error;
      } finally {
        running = false;
        changed();
      }
    },
  };
}
