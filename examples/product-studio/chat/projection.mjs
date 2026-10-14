const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/** Keep photos, identity, authorization and raw export files out of model context. */
export function projectStudioSnapshot(state) {
  const app = state.app ?? {};
  return {
    sessionId: state.sessionId,
    revision: state.revision,
    selectedDesignId: app.selectedDesignId,
    designs: Object.values(app.designs ?? {}).map((design) =>
      Object.fromEntries(
        [
          "id",
          "name",
          "format",
          "theme",
          "headline",
          "subhead",
          "eyebrow",
          "cta",
        ]
          .filter((key) => hasOwn(design, key))
          .map((key) => [key, design[key]]),
      ),
    ),
    panels: Object.values(state.panes ?? {}).map((pane) => ({
      id: pane.id,
      type: pane.view,
      title: pane.title,
      ...(typeof pane.data?.designId === "string"
        ? { designId: pane.data.designId }
        : {}),
    })),
    asset: { name: app.asset?.name ?? "Product photo" },
    lastExport: app.lastExport
      ? {
          filename: app.lastExport.filename,
          designId: app.lastExport.designId,
          width: app.lastExport.width,
          height: app.lastExport.height,
        }
      : null,
  };
}

export function publicTurn(turn) {
  return {
    id: turn.id,
    message: turn.message,
    mode: turn.mode,
    status: turn.status,
    reply: turn.reply || "",
    steps: (turn.steps || []).map((step) => ({ ...step })),
    expiresAt: turn.expiresAt,
  };
}
export function projectToolResult(value, depth = 0) {
  if (depth > 6) return null;
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string")
    return value.startsWith("data:") ? "[image omitted]" : value.slice(0, 2000);
  if (Array.isArray(value))
    return value.slice(0, 32).map((item) => projectToolResult(item, depth + 1));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            ![
              "svg",
              "src",
              "asset",
              "dataURL",
              "state",
              "ownerId",
              "principal",
              "authorization",
            ].includes(key),
        )
        .slice(0, 32)
        .map(([key, item]) => [key, projectToolResult(item, depth + 1)]),
    );
  return null;
}
