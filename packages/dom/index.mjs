/** A stable DOM workspace shell. Renderers and application state belong to the host. */
const wdDomSvgNs = 'http://www.w3.org/2000/svg';
let wdDomMountSequence = 0;
const wdDomLeaves = layout => layout.type === 'pane' ? [layout.paneId] : [...wdDomLeaves(layout.first), ...wdDomLeaves(layout.second)];
const wdDomClamp = value => Math.min(0.9, Math.max(0.1, value));
function wdDomNode(document, tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function wdDomIcon(document, type) {
  const svg = document.createElementNS(wdDomSvgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(wdDomSvgNs, 'path');
  path.setAttribute('d', type === 'close' ? 'm5 5 10 10M15 5 5 15' : 'M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4');
  svg.append(path);
  return svg;
}

/** Mount without moving existing pane hosts as tabs, splits, or zoom state change. */
export function mountWorkspace(element, { client, panels, tabBar = true, onPaneFocus, onPaneClose } = {}) {
  if (!element?.ownerDocument || typeof element.append !== 'function') throw new TypeError('mountWorkspace requires a DOM element.');
  if (!client?.subscribe || !client?.call || !client?.snapshot) throw new TypeError('mountWorkspace requires a Viewherd client.');
  if (!panels || typeof panels !== 'object') throw new TypeError('panels must be a renderer map.');
  const document = element.ownerDocument;
  const view = document.defaultView;
  const instanceId = `wd-workspace-${++wdDomMountSequence}`;
  const shell = wdDomNode(document, 'div', 'wd-workspace');
  const tabs = wdDomNode(document, 'div', 'wd-tabs');
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Workspace tabs');
  const paneSwitch = wdDomNode(document, 'div', 'wd-pane-switcher');
  paneSwitch.setAttribute('role', 'tablist'); paneSwitch.setAttribute('aria-label', 'Visible panels');
  const canvas = wdDomNode(document, 'div', 'wd-canvas');
  const status = wdDomNode(document, 'div', 'wd-status');
  status.setAttribute('role', 'status'); status.hidden = true;
  tabs.hidden = !tabBar;
  paneSwitch.hidden = true;
  shell.append(tabs, paneSwitch, canvas, status);
  element.append(shell);
  const panes = new Map(), splitters = new Map(), tabButtons = new Map(), switchButtons = new Map();
  let state = null, disposed = false, resizeObserver = null, unsubscribe = null, dragging = null;
  let statusTimer = null, focusIntent = null, focusTask = null;

  function context(pane) {
    return {
      pane, state, client,
      action: (name, args = {}, options = {}) => client.call('panel.action', { paneId: pane.id, action: name, args }, options),
    };
  }
  function report(error) {
    if (disposed) return;
    status.textContent = error?.message || 'This workspace operation failed.';
    status.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.hidden = true; }, 7000);
  }
  function perform(method, params, options) {
    return client.call(method, params, options).catch(error => { report(error); throw error; });
  }
  function handled(promise) { Promise.resolve(promise).catch(report); }
  function active() {
    const workspace = state?.workspaces?.find(item => item.id === state.activeWorkspaceId);
    const tab = workspace?.tabs.find(item => item.id === workspace.activeTabId);
    return { workspace, tab };
  }
  function scheduleFocus() {
    if (focusTask || disposed || !focusIntent) return;
    focusTask = (async () => {
      while (focusIntent && !disposed) {
        const paneId = focusIntent;
        focusIntent = null;
        const { tab } = active();
        if (state.panes[paneId] && tab?.focusedPaneId !== paneId) await perform('pane.focus', { paneId });
      }
    })().catch(report).finally(() => {
      focusTask = null;
      if (focusIntent && !disposed) scheduleFocus();
    });
  }
  function focusPane(paneId) {
    if (!state || disposed || focusIntent === paneId) return;
    const { tab } = active();
    if (tab?.focusedPaneId === paneId && !focusTask) return;
    const pane = state.panes[paneId];
    if (!pane) return;
    focusIntent = paneId;
    try { onPaneFocus?.(pane, context(pane)); } catch (error) { report(error); }
    scheduleFocus();
  }
  function mountPane(pane) {
    const section = wdDomNode(document, 'section', 'wd-pane');
    section.dataset.paneId = pane.id;
    section.setAttribute('role', 'region');
    const header = wdDomNode(document, 'header', 'wd-pane-header');
    const title = wdDomNode(document, 'span', 'wd-pane-title', pane.title);
    title.id = `${instanceId}-title-${pane.id}`;
    section.setAttribute('aria-labelledby', title.id);
    const actions = wdDomNode(document, 'div', 'wd-pane-actions');
    const zoom = wdDomNode(document, 'button', 'wd-pane-zoom'); zoom.type = 'button'; zoom.append(wdDomIcon(document, 'zoom'));
    const close = wdDomNode(document, 'button', 'wd-pane-close'); close.type = 'button'; close.append(wdDomIcon(document, 'close'));
    actions.append(zoom, close); header.append(title, actions);
    const host = wdDomNode(document, 'div', 'wd-pane-body');
    section.append(header, host);
    // This is the only append of this section: never reparent a live renderer.
    canvas.append(section);
    const item = { section, header, title, zoom, close, host, view: null, renderer: null, pane };
    section.addEventListener('pointerdown', () => focusPane(item.pane.id));
    section.addEventListener('focusin', () => focusPane(item.pane.id));
    zoom.addEventListener('click', () => handled(perform('pane.zoom', { paneId: item.pane.id })));
    close.addEventListener('click', () => {
      const ctx = context(item.pane);
      if (onPaneClose) {
        try { handled(onPaneClose(item.pane, ctx)); } catch (error) { report(error); }
      } else handled(perform('pane.close', { paneId: item.pane.id }));
    });
    panes.set(pane.id, item);
    return item;
  }
  function renderPane(item, pane) {
    item.pane = pane;
    item.title.textContent = pane.title;
    item.section.dataset.view = pane.view;
    item.zoom.setAttribute('aria-label', `Expand or restore ${pane.title}`);
    item.close.setAttribute('aria-label', `Close ${pane.title}`);
    const ctx = context(pane);
    if (item.view !== pane.view) {
      try { item.renderer?.destroy?.(); } catch (error) { report(error); }
      item.renderer = null;
      item.host.replaceChildren();
      item.view = pane.view;
      const definition = panels[pane.view];
      if (typeof definition?.mount !== 'function') {
        item.host.append(wdDomNode(document, 'p', 'wd-renderer-missing', `No renderer registered for “${pane.view}”.`));
      } else {
        try {
          const renderer = definition.mount(item.host, ctx);
          if (renderer && typeof renderer.then === 'function') throw new TypeError('Panel mount must return its lifecycle synchronously.');
          item.renderer = renderer || {};
        } catch (error) { report(error); }
      }
    } else {
      try { item.renderer?.update?.(ctx); } catch (error) { report(error); }
    }
  }
  function destroyPane(item) {
    try { item.renderer?.destroy?.(); } catch (error) { report(error); }
    item.section.remove();
  }
  function renderTabs(workspace) {
    const known = new Set();
    for (const tab of workspace?.tabs || []) {
      known.add(tab.id);
      let button = tabButtons.get(tab.id);
      if (!button) {
        button = wdDomNode(document, 'button', 'wd-tab'); button.type = 'button'; button.setAttribute('role', 'tab');
        button.addEventListener('click', () => handled(perform('tab.focus', { tabId: tab.id })));
        tabs.append(button); tabButtons.set(tab.id, button);
      }
      button.textContent = tab.label;
      button.setAttribute('aria-selected', String(tab.id === workspace.activeTabId));
      button.tabIndex = tab.id === workspace.activeTabId ? 0 : -1;
    }
    for (const [id, button] of tabButtons) if (!known.has(id)) { button.remove(); tabButtons.delete(id); }
  }
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const { workspace } = active();
    if (!workspace?.tabs.length) return;
    const index = workspace.tabs.findIndex(tab => tab.id === workspace.activeTabId);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? workspace.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + workspace.tabs.length) % workspace.tabs.length;
    event.preventDefault();
    const id = workspace.tabs[next].id;
    handled(perform('tab.focus', { tabId: id }).then(() => tabButtons.get(id)?.focus()));
  });
  function renderSwitch(ids, focused) {
    const known = new Set(ids);
    for (const id of ids) {
      let button = switchButtons.get(id);
      if (!button) {
        button = wdDomNode(document, 'button', 'wd-pane-switch'); button.type = 'button'; button.setAttribute('role', 'tab');
        button.addEventListener('click', () => focusPane(id));
        paneSwitch.append(button); switchButtons.set(id, button);
      }
      button.textContent = state.panes[id]?.title || 'Panel';
      button.setAttribute('aria-selected', String(id === focused));
      button.tabIndex = 0;
    }
    for (const [id, button] of switchButtons) if (!known.has(id)) { button.remove(); switchButtons.delete(id); }
  }
  function position(node, rect) {
    node.style.left = `${Math.round(rect.x)}px`; node.style.top = `${Math.round(rect.y)}px`;
    node.style.width = `${Math.max(0, Math.round(rect.width))}px`; node.style.height = `${Math.max(0, Math.round(rect.height))}px`;
  }
  function makeSplitter(split) {
    const node = wdDomNode(document, 'div', 'wd-splitter');
    node.setAttribute('role', 'separator'); node.setAttribute('aria-label', 'Resize panels'); node.tabIndex = 0;
    node.setAttribute('aria-valuemin', '10'); node.setAttribute('aria-valuemax', '90');
    const item = { node, split, rect: null };
    node.addEventListener('keydown', event => {
      const horizontal = item.split.direction === 'right';
      const decrement = horizontal ? 'ArrowLeft' : 'ArrowUp', increment = horizontal ? 'ArrowRight' : 'ArrowDown';
      if (![decrement, increment, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const ratio = event.key === 'Home' ? 0.1 : event.key === 'End' ? 0.9 : wdDomClamp(item.split.ratio + (event.key === increment ? 0.05 : -0.05));
      handled(perform('pane.resize', { splitId: item.split.id, ratio }));
    });
    node.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !item.rect || dragging) return;
      event.preventDefault();
      dragging = { id: item.split.id, direction: item.split.direction, rect: item.rect, ratio: item.split.ratio, revision: state.revision, pointerId: event.pointerId };
      node.setPointerCapture?.(event.pointerId);
      shell.classList.add('wd-is-resizing');
      document.addEventListener('pointermove', moveResize);
      document.addEventListener('pointerup', endResize);
      document.addEventListener('pointercancel', cancelResize);
      view.addEventListener('blur', cancelResize);
    });
    node.addEventListener('lostpointercapture', () => { if (dragging?.id === item.split.id) cancelResize(); });
    canvas.append(node); splitters.set(split.id, item);
    return item;
  }
  function moveResize(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const bounds = canvas.getBoundingClientRect();
    const horizontal = dragging.direction === 'right';
    const point = horizontal ? event.clientX - bounds.left - dragging.rect.x : event.clientY - bounds.top - dragging.rect.y;
    const length = horizontal ? dragging.rect.width : dragging.rect.height;
    dragging.ratio = wdDomClamp(point / length);
    layout();
  }
  function releaseResize() {
    document.removeEventListener('pointermove', moveResize);
    document.removeEventListener('pointerup', endResize);
    document.removeEventListener('pointercancel', cancelResize);
    view.removeEventListener('blur', cancelResize);
    shell.classList.remove('wd-is-resizing');
    const old = dragging; dragging = null;
    return old;
  }
  function endResize(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const old = releaseResize();
    layout();
    handled(perform('pane.resize', { splitId: old.id, ratio: old.ratio }, { expectedRevision: old.revision }));
  }
  function cancelResize() { if (dragging) { releaseResize(); layout(); } }
  function layout() {
    if (!state || disposed) return;
    const { tab } = active();
    if (!tab) {
      for (const item of panes.values()) if (!item.section.hidden) item.section.hidden = true;
      for (const item of splitters.values()) if (!item.node.hidden) item.node.hidden = true;
      return;
    }
    const ids = wdDomLeaves(tab.layout);
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const compact = width < 640 || (ids.length > 2 && width < 980);
    const focus = ids.includes(tab.focusedPaneId) ? tab.focusedPaneId : ids[0];
    paneSwitch.hidden = !compact || ids.length < 2 || Boolean(tab.zoomedPaneId);
    shell.classList.toggle('wd-compact', compact);
    renderSwitch(ids, focus);
    const selected = tab.zoomedPaneId || (compact ? focus : null);
    const gap = Math.max(0, parseFloat(view.getComputedStyle(shell).getPropertyValue('--wd-pane-gap')) || 8);
    const visible = selected ? [selected] : ids;
    for (const [id, item] of panes) {
      const hidden = !visible.includes(id);
      if (item.section.hidden !== hidden) item.section.hidden = hidden;
    }
    for (const id of ids) {
      const item = panes.get(id);
      if (!item) continue;
      item.section.classList.toggle('wd-pane-focused', id === focus);
      item.zoom.setAttribute('aria-pressed', String(id === tab.zoomedPaneId));
      item.close.disabled = ids.length < 2 && !onPaneClose;
    }
    if (selected) {
      for (const item of splitters.values()) if (!item.node.hidden) item.node.hidden = true;
      const item = panes.get(selected);
      if (item) position(item.section, { x: 0, y: 0, width, height });
      return;
    }
    const visibleSplits = new Set();
    function place(node, rect) {
      if (node.type === 'pane') {
        const item = panes.get(node.paneId);
        if (item) position(item.section, rect);
        return;
      }
      const horizontal = node.direction === 'right';
      const ratio = dragging?.id === node.id ? dragging.ratio : node.ratio;
      const available = Math.max(0, (horizontal ? rect.width : rect.height) - gap);
      const firstLength = available * ratio, secondLength = available - firstLength;
      const first = { ...rect, ...(horizontal ? { width: firstLength } : { height: firstLength }) };
      const second = { ...rect, ...(horizontal ? { x: rect.x + firstLength + gap, width: secondLength } : { y: rect.y + firstLength + gap, height: secondLength }) };
      place(node.first, first); place(node.second, second);
      const item = splitters.get(node.id) || makeSplitter(node);
      visibleSplits.add(node.id);
      item.split = node; item.rect = rect;
      if (item.node.hidden) item.node.hidden = false;
      item.node.dataset.direction = node.direction;
      item.node.setAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
      item.node.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      position(item.node, horizontal ? { x: rect.x + firstLength, y: rect.y, width: gap, height: rect.height } : { x: rect.x, y: rect.y + firstLength, width: rect.width, height: gap });
    }
    place(tab.layout, { x: 0, y: 0, width, height });
    for (const [id, item] of splitters) if (!visibleSplits.has(id) && !item.node.hidden) item.node.hidden = true;
  }
  function render(next) {
    if (disposed) return;
    state = next;
    const { workspace, tab } = active();
    const activeIds = new Set(tab ? wdDomLeaves(tab.layout) : []);
    for (const [id, item] of panes) if (!state.panes[id]) { destroyPane(item); panes.delete(id); }
    for (const [id, pane] of Object.entries(state.panes)) {
      // Mount lazily, then retain connected hosts even while their tab is hidden.
      const item = panes.get(id) || (activeIds.has(id) ? mountPane(pane) : null);
      if (item) renderPane(item, pane);
    }
    const knownSplits = new Set();
    function collect(node) { if (node.type === 'split') { knownSplits.add(node.id); collect(node.first); collect(node.second); } }
    for (const ws of state.workspaces) for (const item of ws.tabs) collect(item.layout);
    for (const [id, item] of splitters) if (!knownSplits.has(id)) { item.node.remove(); splitters.delete(id); }
    renderTabs(workspace);
    layout();
  }
  unsubscribe = client.subscribe(render);
  if (!client.state) client.snapshot().catch(report);
  if (typeof view.ResizeObserver === 'function') {
    resizeObserver = new view.ResizeObserver(layout);
    resizeObserver.observe(canvas);
  } else view.addEventListener('resize', layout);
  return {
    destroy() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.(); resizeObserver?.disconnect(); view.removeEventListener('resize', layout);
      if (dragging) releaseResize();
      clearTimeout(statusTimer);
      for (const item of panes.values()) destroyPane(item);
      panes.clear(); splitters.clear(); shell.remove();
    },
  };
}
