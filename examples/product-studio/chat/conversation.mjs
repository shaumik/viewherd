const turnIdSchema = { type: "string", minLength: 1, maxLength: 128 };
const replySchema = { type: "string", maxLength: 4000 };
const stepSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label", "status", "action"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    label: { type: "string", minLength: 1, maxLength: 200 },
    status: { type: "string", enum: ["running", "done", "failed"] },
    action: { type: "string", minLength: 1, maxLength: 120 },
    revision: { type: "integer", minimum: 0 },
    error: { type: "string", maxLength: 800 },
  },
};

function fail(code, message) {
  throw Object.assign(new Error(message), {
    code,
    ...(code === "agent_forbidden" ? { status: 403 } : {}),
  });
}

export function ensureConversation(ctx) {
  // Older saved sessions gain conversation state only when a turn is started.
  ctx.app.chat ??= { turns: [], activeTurnId: null };
  return ctx.app.chat;
}

function trustedAgent(ctx, turnId) {
  const principal = ctx.principal;
  if (
    !Array.isArray(principal?.roles) ||
    !principal.roles.includes("studio-agent") ||
    typeof principal.id !== "string" ||
    !principal.id ||
    principal.turnId !== turnId ||
    !Number.isSafeInteger(principal.serverTime) ||
    principal.serverTime < 0
  ) {
    fail(
      "agent_forbidden",
      "Only the trusted studio agent can update a conversation.",
    );
  }
  return principal;
}

function ownedTurn(ctx, turnId) {
  const principal = trustedAgent(ctx, turnId);
  const chat = ensureConversation(ctx);
  const turn = chat.turns.find((item) => item.id === turnId);
  if (!turn || turn.ownerId !== principal.id) {
    fail("agent_cancelled", "This request was cancelled.");
  }
  return { chat, turn, principal };
}

function runningTurn(
  ctx,
  turnId = ctx.principal?.turnId,
  allowExpired = false,
) {
  const owned = ownedTurn(ctx, turnId);
  if (
    owned.chat.activeTurnId !== turnId ||
    owned.turn.status !== "running" ||
    (!allowExpired && owned.turn.expiresAt <= owned.principal.serverTime)
  ) {
    fail("agent_cancelled", "This request is no longer active.");
  }
  return owned;
}

function beginTurn(ctx, args) {
  const principal = trustedAgent(ctx, args.turnId);
  const chat = ensureConversation(ctx);
  const previous = chat.turns.find((item) => item.id === args.turnId);
  if (previous) {
    if (
      previous.ownerId !== principal.id ||
      previous.message !== args.message ||
      previous.mode !== args.mode
    ) {
      fail(
        "turn_conflict",
        "That request ID has already been used for another message.",
      );
    }
    return { turn: structuredClone(previous), replayed: true };
  }
  if (!args.message.trim()) {
    fail("empty_message", "Enter a message for the studio.");
  }
  if (
    !Number.isSafeInteger(args.expiresAt) ||
    args.expiresAt <= principal.serverTime
  ) {
    fail("invalid_lease", "The agent request must have a future expiry.");
  }
  const active = chat.turns.find((item) => item.id === chat.activeTurnId);
  if (active?.status === "running") {
    if (active.expiresAt > principal.serverTime) {
      fail("turn_in_progress", "Wait for the current request to finish.");
    }
    active.status = "failed";
    active.reply = active.reply || "This request expired. Try again.";
    for (const step of active.steps) {
      if (step.status === "running") {
        step.status = "failed";
        step.error = "This request expired.";
      }
    }
  }
  if (ctx.pane.title === "Creative brief") {
    ctx.call("view.update", {
      paneId: ctx.pane.id,
      title: "Studio chat",
      data: {},
    });
  }
  const turn = {
    id: args.turnId,
    ownerId: principal.id,
    message: args.message,
    mode: args.mode,
    status: "running",
    reply: "",
    steps: [],
    expiresAt: args.expiresAt,
  };
  chat.turns.push(turn);
  chat.turns = chat.turns.slice(-12);
  chat.activeTurnId = turn.id;
  return { turn: structuredClone(turn) };
}

function saveStep(turn, step) {
  const index = turn.steps.findIndex((item) => item.id === step.id);
  if (index === -1) {
    if (turn.steps.length >= 12) {
      fail("step_limit", "A studio request can take up to 12 actions.");
    }
    turn.steps.push(structuredClone(step));
  } else {
    // A repeated start notification cannot regress an already finished step.
    const previous = turn.steps[index];
    if (previous.status === "running" || step.status !== "running") {
      turn.steps[index] = { ...previous, ...step };
    }
  }
}

function updateTurn(ctx, { turnId, reply, step }) {
  const { turn } = runningTurn(ctx, turnId);
  if (reply !== undefined) turn.reply = reply;
  if (step) saveStep(turn, step);
  return { turn: structuredClone(turn) };
}

function finishTurn(ctx, { turnId, status, reply, steps }) {
  const { chat, turn } = ownedTurn(ctx, turnId);
  if (turn.status !== "running") {
    return { turn: structuredClone(turn), replayed: true };
  }
  runningTurn(ctx, turnId, true);
  if (steps) {
    if (new Set(steps.map((step) => step.id)).size !== steps.length) {
      fail("invalid_steps", "Final action steps must have unique IDs.");
    }
    // A tool can commit before its progress write fails. Reconcile the server's
    // verified outcomes so ending the request does not report that action failed.
    for (const step of steps) saveStep(turn, step);
  }
  turn.status = status;
  turn.reply = reply;
  chat.activeTurnId = null;
  for (const step of turn.steps) {
    if (step.status === "running") {
      step.status = "failed";
      step.error ??= "The request ended before this action finished.";
    }
  }
  return { turn: structuredClone(turn) };
}

export const conversationActions = {
  beginTurn: {
    description:
      "Restricted server action: begin an agent conversation with a bounded lease. Requires a host-verified studio-agent role and matching turn owner.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["turnId", "message", "mode", "expiresAt"],
      properties: {
        turnId: turnIdSchema,
        message: { type: "string", minLength: 1, maxLength: 2000 },
        mode: { type: "string", enum: ["demo", "openai"] },
        expiresAt: { type: "integer", minimum: 0 },
      },
    },
    run: beginTurn,
  },
  updateTurn: {
    description:
      "Restricted server action: publish reply text and the current agent tool step. Requires a host-verified studio-agent role and matching active turn owner.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["turnId"],
      properties: {
        turnId: turnIdSchema,
        reply: replySchema,
        step: stepSchema,
      },
    },
    run: updateTurn,
  },
  finishTurn: {
    description:
      "Restricted server action: finish an agent conversation and release its lease. Requires a host-verified studio-agent role and matching turn owner.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["turnId", "status", "reply"],
      properties: {
        turnId: turnIdSchema,
        status: { type: "string", enum: ["completed", "failed"] },
        reply: replySchema,
        steps: { type: "array", items: stepSchema, maxItems: 12 },
      },
    },
    run: finishTurn,
  },
};

// Agent actions must still belong to a live conversation when the transaction
// runs. Human edits have no turnId and use the same registered actions.
export function guardAgentActions(actions) {
  return Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [
      name,
      {
        ...action,
        run(ctx, args) {
          if (ctx.principal?.turnId !== undefined) runningTurn(ctx);
          return action.run(ctx, args);
        },
      },
    ]),
  );
}
