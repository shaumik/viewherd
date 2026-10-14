import { el, button, icon } from "../ui.js";
import { currentDesign } from "../drafts.js";
import { downloadBlob, svgToPng } from "../images.js";
import { renderDesign, dimensionsFor } from "../../render.mjs";

export function mountExports(host, initialContext, { actions }) {
  let context = initialContext;
  let signature = null;
  let disposed = false;
  const root = el("div", "deliverables");
  const symbol = el("div", "export-symbol");
  symbol.append(icon("download"));
  root.append(
    symbol,
    el("div", "overline", "Ready for the world"),
    el("h2", "deliverables-title", "Your next\nlaunch, sorted."),
    el(
      "p",
      "deliverables-description",
      "Real assets. Your product. Your copy. Take the design anywhere.",
    ),
  );
  const preview = el("div", "export-preview");
  root.append(preview);
  const buttons = [];
  function fileRow(type, title, info) {
    const row = el("div", "file-row");
    const description = el("div", "file-description");
    const name = el("div", "file-name", title);
    const detail = el("div", "file-info", info);
    description.append(name, detail);
    const download = button("", "download-button", "download", () =>
      performDownload(type),
    );
    download.setAttribute(
      "aria-label",
      `Download ${type.toUpperCase()} campaign`,
    );
    buttons.push(download);
    row.append(
      el("div", "file-icon", type.toUpperCase()),
      description,
      download,
    );
    root.append(row);
    return detail;
  }
  const pngInfo = fileRow(
    "png",
    "Campaign image",
    "1080 × 1080 · Ready to post",
  );
  fileRow("svg", "Editable artwork", "Vector · Product image included");
  root.append(
    el(
      "p",
      "deliverable-note",
      "Both files are self-contained. No account, extra fonts, or image links needed.",
    ),
  );
  const downloadAll = button(
    "Download campaign",
    "primary-button",
    "download",
    () => performDownload("png"),
  );
  buttons.push(downloadAll);
  root.append(downloadAll);
  const bottom = el("p", "deliverables-bottom");
  bottom.append(
    el("strong", "", "Built with Viewherd."),
    document.createTextNode(
      " The brief created panels, changed the design, and prepared the export. Your own agent can do the same.",
    ),
  );
  root.append(bottom);
  host.append(root);
  async function performDownload(type) {
    buttons.forEach((control) => {
      control.disabled = true;
    });
    try {
      await actions.run(async () => {
        const { result } = await context.action("export", {});
        if (type === "svg") {
          downloadBlob(
            new Blob([result.svg], { type: "image/svg+xml" }),
            result.filename,
          );
        } else {
          const png = await svgToPng(result.svg, result.width, result.height);
          downloadBlob(png, result.filename.replace(/\.svg$/, ".png"));
        }
      }, `${type.toUpperCase()} campaign downloaded.`);
    } catch {
      // The shared action runner has already shown the error.
    } finally {
      if (!disposed)
        buttons.forEach((control) => {
          control.disabled = false;
        });
    }
  }
  function update(next) {
    context = next;
    const design = currentDesign(context);
    const key = JSON.stringify(design) + context.state.app.asset.src;
    if (key !== signature) {
      preview.innerHTML = renderDesign(design, context.state.app.asset);
      signature = key;
    }
    const dimensions = dimensionsFor(design.format);
    pngInfo.textContent = `${dimensions.width} × ${dimensions.height} · Ready to post`;
  }
  update(context);
  return {
    update,
    destroy() {
      disposed = true;
    },
  };
}
