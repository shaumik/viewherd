const iconPaths = {
  arrow: "M3 8h10M9 4l4 4-4 4",
  sparkle: "m8 1 1.6 4.9L14 8l-4.4 2.1L8 15l-1.6-4.9L2 8l4.4-2.1Z",
  check: "m3 8 3 3 7-7",
  edit: "m3 11 1 2 2-1 7-7-3-3-7 7ZM9 3l3 3",
  download: "M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3",
  panels: "M2 3h12v10H2ZM7 3v10",
  image: "M2 2h12v12H2Zm1 10 4-5 3 3 2-2 2 4M11 5h.01",
};
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.25");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", iconPaths[name] || iconPaths.arrow);
  svg.append(path);
  return svg;
}
export function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
export function button(label, className, iconName, callback) {
  const node = el("button", className);
  node.type = "button";
  if (iconName) node.append(icon(iconName));
  node.append(el("span", "", label));
  if (callback) node.addEventListener("click", callback);
  return node;
}

// Give each app its own notification timer and cleanup.
export function createNotifications(node) {
  let timer;
  function notify(message, error = false) {
    node.textContent = message;
    node.dataset.error = String(error);
    node.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        node.hidden = true;
      },
      error ? 6500 : 3800,
    );
  }
  return {
    notify,
    destroy() {
      clearTimeout(timer);
    },
  };
}

// Event handlers have already surfaced failures to the user.
export function handled(promise) {
  Promise.resolve(promise).catch(() => {});
}
