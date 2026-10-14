import { el, button, icon, handled } from "../ui.js";
import { currentDesign } from "../drafts.js";
import { renderDesign, dimensionsFor, DESIGN_THEMES } from "../../render.mjs";

export function mountCanvas(host, initialContext, { actions }) {
  let context = initialContext;
  let signature = null;
  let busy = false;
  const root = el("div", "canvas-panel");
  const toolbar = el("div", "canvas-toolbar");
  const label = el("div", "canvas-label");
  const dot = el("span", "theme-indicator");
  const name = el("span");
  const format = el("span", "canvas-format");
  label.append(dot, name, format);
  const inspect = button("Edit design", "text-button", "edit", () =>
    act("inspect", "Open controls. Make it yours."),
  );
  toolbar.append(label, inspect);
  const stage = el("div", "canvas-stage");
  const art = el("div", "artboard");
  stage.append(art);
  const footer = el("div", "canvas-footer");
  const size = el("span", "canvas-size");
  const keep = button("Keep this direction", "canvas-keep", "check", () =>
    act("select", "One winning direction. The comparison panel is closed."),
  );
  const selected = el("span", "canvas-selected");
  selected.append(icon("check"), el("span", "", "Selected direction"));
  const exportButton = button("Export", "canvas-export", null, () => {
    handled(
      actions.run(async () => {
        await context.action("select", {});
        return actions.call("export");
      }, "Ready to take your campaign with you."),
    );
  });
  footer.append(size, keep, selected, exportButton);
  root.append(toolbar, stage, footer);
  host.append(root);
  async function act(action, message) {
    if (busy) return;
    busy = true;
    inspect.disabled = keep.disabled = true;
    try {
      await actions.run(() => context.action(action, {}), message);
    } catch {
    } finally {
      busy = false;
      inspect.disabled = keep.disabled = false;
    }
  }
  function update(next) {
    context = next;
    const design = currentDesign(context);
    if (!design) return;
    const app = context.state.app;
    const dimensions = dimensionsFor(design.format);
    const theme = DESIGN_THEMES.find((item) => item.id === design.theme);
    name.textContent = design.name;
    format.textContent = design.format === "story" ? "Story" : "Social";
    dot.style.background = theme?.background || "#eee";
    size.textContent = `${dimensions.width} × ${dimensions.height}`;
    const hasComparison =
      Object.values(context.state.panes).filter(
        (pane) => pane.view === "canvas",
      ).length > 1;
    keep.hidden = !hasComparison;
    selected.hidden = hasComparison;
    exportButton.hidden = hasComparison;
    const key = JSON.stringify(design) + app.asset.src;
    if (key !== signature) {
      art.innerHTML = renderDesign(design, app.asset);
      art.dataset.format = design.format;
      const svg = art.querySelector("svg");
      if (svg) {
        svg.setAttribute("role", "img");
        svg.setAttribute(
          "aria-label",
          `${design.name} campaign: ${design.headline.replace(/\n/g, " ")}`,
        );
      }
      if (signature !== null) {
        art.classList.remove("changed");
        void art.offsetWidth;
        art.classList.add("changed");
      }
      signature = key;
    }
  }
  update(context);
  return { update };
}
