/** Structural types keep this package usable without a runtime dependency. */
export interface DomPane { id: string; title: string; view: string; data: Record<string, unknown>; }
export interface DomClient { readonly state: DomState | null; snapshot(): Promise<DomState>; call(method: string, params?: Record<string, unknown>, options?: DomCallOptions): Promise<any>; subscribe(listener: (state: DomState, event?: unknown) => void): () => void; }
export interface DomState { revision: number; activeWorkspaceId: string; workspaces: Array<{ id: string; activeTabId: string; tabs: Array<{ id: string; label: string; focusedPaneId: string; zoomedPaneId?: string | null; layout: unknown }> }>; panes: Record<string, DomPane>; app?: Record<string, unknown>; }
export interface DomCallOptions { requestId?: string; expectedRevision?: number; signal?: AbortSignal; }
export interface PanelContext { pane: DomPane; state: DomState; client: DomClient; action(name: string, args?: Record<string, unknown>, options?: DomCallOptions): Promise<any>; }
export interface PanelLifecycle { update?(context: PanelContext): void; destroy?(): void; }
export interface PanelRenderer { mount(host: HTMLElement, context: PanelContext): PanelLifecycle | void; }
export interface MountWorkspaceOptions {
  client: DomClient;
  panels: Record<string, PanelRenderer>;
  tabBar?: boolean;
  /** Canvas width in pixels below which only the focused pane is shown. Default 640; 0 disables this rule. */
  compactBreakpoint?: number;
  /** Canvas width in pixels below which three or more panes collapse to the focused pane. Default 980; 0 disables this rule. */
  multiPaneBreakpoint?: number;
  onPaneFocus?(pane: DomPane, context: PanelContext): void;
  /** Overrides the default pane.close command. */
  onPaneClose?(pane: DomPane, context: PanelContext): void | Promise<void>;
}
export function mountWorkspace(element: HTMLElement, options: MountWorkspaceOptions): { destroy(): void };
