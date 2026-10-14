import { el } from "./ui.js";

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = el("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function svgToPng(svg, width, height) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error(
        "This browser cannot create PNG images. Download the SVG instead.",
      );
    context.drawImage(image, 0, 0, width, height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("PNG export failed. Download the SVG instead.")),
        "image/png",
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function normalizePhoto(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  if (file.size > 15 * 1024 * 1024)
    throw new Error("Choose a product image smaller than 15 MB.");
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    let size = 1000;
    let quality = 0.85;
    for (let attempt = 0; attempt < 10; attempt++) {
      const scale = Math.min(
        1,
        size / Math.max(image.naturalWidth, image.naturalHeight),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser cannot prepare the image.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const src = canvas.toDataURL("image/webp", quality);
      if (src.length <= 120000 && src.startsWith("data:image/")) return src;
      if (quality > 0.45) quality -= 0.15;
      else {
        size = Math.round(size * 0.75);
        quality = 0.7;
      }
    }
    throw new Error(
      "This image is too detailed. Choose a smaller product photo.",
    );
  } catch (error) {
    if (error instanceof DOMException)
      throw new Error("This image could not be opened. Choose another photo.");
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}
