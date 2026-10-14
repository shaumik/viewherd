import { failure, errorMessage, isObject } from "./http.mjs";
import { projectStudioSnapshot, projectToolResult } from "./projection.mjs";

// This is the complete set of app actions an agent may use.
export const allowedActions = [
  "createDirections",
  "refine",
  "select",
  "compare",
  "inspect",
  "export",
  "remove",
  "reset",
];

export function studioPaneId(state) {
  const pane = Object.values(state.panes ?? {}).find(
    (item) => item.view === "studio",
  );
  if (!pane) throw failure("studio_not_found", "Open the studio panel first.");
  return pane.id;
}

export function throwIfAborted(signal) {
  if (signal.aborted) {
    throw (
      signal.reason ||
      failure("assistant_cancelled", "The request was interrupted.")
    );
  }
}

// Conversation metadata uses the same SDK as design actions. It has its own
// request IDs so retrying a chat request never duplicates a saved update.
export async function writeConversation(
  client,
  turnId,
  action,
  args,
  suffix,
  expectedRevision,
) {
  const state = await client.snapshot();
  return client.call(
    "panel.action",
    { paneId: studioPaneId(state), action, args: { turnId, ...args } },
    {
      requestId: `chat:${turnId}:${suffix}`,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    },
  );
}

function validateCommand(command) {
  if (
    !isObject(command) ||
    !allowedActions.includes(command.action) ||
    !isObject(command.args ?? {}) ||
    Object.keys(command).some(
      (key) => !["action", "args", "label"].includes(key),
    )
  ) {
    throw failure(
      "unsupported_action",
      "That action is not available in this studio.",
    );
  }
}

/**
 * Give a backend agent two tools: read the workspace, or call an allowed action.
 * The client is already authenticated by the host. Nothing runs in the browser.
 */
export function createAgentTools({
  client,
  turnId,
  initialRevision,
  signal,
  send,
  getReply,
}) {
  let observedRevision = initialRevision;
  let actionCount = 0;
  let actionRunning = false;
  const verifiedSteps = new Map();
  const active = () => throwIfAborted(signal);
  const recordStep = (step, suffix, revision) =>
    writeConversation(
      client,
      turnId,
      "updateTurn",
      { reply: getReply(), step },
      suffix,
      revision,
    );

  async function snapshot() {
    active();
    const state = await client.snapshot();
    active();
    observedRevision = state.revision;
    return projectStudioSnapshot(state);
  }

  async function call(command) {
    active();
    validateCommand(command);
    if (actionRunning)
      throw failure(
        "unsupported_action",
        "Studio actions must run one at a time.",
      );
    if (++actionCount > 10) {
      throw failure(
        "tool_limit",
        "This request needs more than ten actions. Ask for the next step in another message.",
      );
    }

    const id = `step_${actionCount}`;
    const label =
      typeof command.label === "string" && command.label.trim()
        ? command.label.trim().slice(0, 120)
        : command.action;
    const step = { id, label, status: "running", action: command.action };
    verifiedSteps.set(id, step);
    let completed = false;
    actionRunning = true;

    try {
      const before = await client.snapshot();
      if (before.revision !== observedRevision) {
        throw failure(
          "revision_conflict",
          "The studio changed after the agent read it.",
          409,
        );
      }
      const started = await recordStep(step, `${id}:running`, observedRevision);
      active();
      send({ type: "tool", step });

      const state = await client.snapshot();
      active();
      if (state.revision !== started.revision) {
        throw failure(
          "revision_conflict",
          "The studio changed while this action was starting.",
          409,
        );
      }

      // This is how an agent controls the UI. The SDK runs a registered action,
      // saves its result, and streams the resulting panels to the frontend.
      // requestId makes retries safe; expectedRevision protects newer human edits.
      const result = await client.call(
        "panel.action",
        {
          paneId: studioPaneId(state),
          action: command.action,
          args: command.args || {},
        },
        {
          requestId: `chat:${turnId}:${id}:action`,
          expectedRevision: state.revision,
          signal,
        },
      );

      const done = { ...step, status: "done", revision: result.revision };
      completed = true;
      verifiedSteps.set(id, done);
      send({ type: "tool", step: done });
      const recorded = await recordStep(done, `${id}:done`);

      // Our transcript write adds one revision. Any extra revision came from
      // another writer and requires a fresh snapshot before the next mutation.
      observedRevision =
        recorded.revision === result.revision + 1
          ? recorded.revision
          : result.revision;
      active();
      return {
        revision: result.revision,
        result: projectToolResult(result.result),
      };
    } catch (error) {
      if (!completed) {
        const failed = {
          ...step,
          status: "failed",
          error: errorMessage(error),
        };
        verifiedSteps.set(id, failed);
        try {
          await recordStep(failed, `${id}:failed`);
        } catch {}
        send({ type: "tool", step: failed });
      }
      // A verified action stays done even if its transcript update fails.
      throw error;
    } finally {
      actionRunning = false;
    }
  }

  return { snapshot, call, steps: () => [...verifiedSteps.values()] };
}
