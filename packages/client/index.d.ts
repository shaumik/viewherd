export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export interface Pane { id: string; title: string; view: string; data: Record<string, JSONValue>; }
export type Layout = { type: 'pane'; paneId: string } | { type: 'split'; id: string; direction: 'right' | 'down'; ratio: number; first: Layout; second: Layout };
export interface Tab { id: string; label: string; focusedPaneId: string; zoomedPaneId: string | null; layout: Layout; }
export interface Workspace { id: string; label: string; activeTabId: string; tabs: Tab[]; }
export interface SessionState { version: 1; sessionId: string; revision: number; activeWorkspaceId: string; workspaces: Workspace[]; panes: Record<string, Pane>; app?: Record<string, JSONValue>; agents: Array<Record<string, JSONValue>>; events: Array<Record<string, JSONValue>>; }
export interface ClientEvent { type: 'snapshot' | 'state.changed' | 'resync_required'; source: 'http' | 'rpc' | 'stream' | 'cache' | 'error'; sessionId: string; revision: number; requestId?: string; }
export interface CallOptions { requestId?: string; expectedRevision?: number; signal?: AbortSignal; }
export interface ResponseEnvelope<T = JSONValue> { version: 1; requestId: string; sessionId: string; result: T; revision: number; state: SessionState; replayed?: boolean; }
export interface ConnectionEvent { status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'; attempt: number; error?: unknown; }
export interface ViewherdClient {
  readonly sessionId: string;
  readonly state: SessionState | null;
  readonly connection: ConnectionEvent['status'];
  snapshot(): Promise<SessionState>;
  schema(): Promise<Record<string, JSONValue>>;
  call<T = JSONValue>(method: string, params?: Record<string, JSONValue>, options?: CallOptions): Promise<ResponseEnvelope<T>>;
  subscribe(listener: (state: SessionState, event: ClientEvent) => void): () => void;
  destroy(): void;
}
export interface ClientOptions { baseUrl?: string; sessionId: string; fetch?: typeof globalThis.fetch; headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>); onConnection?: (event: ConnectionEvent) => void; }
export class ViewherdError extends Error { readonly code: string; readonly status: number; readonly response?: unknown; readonly state?: SessionState; constructor(code: string, message: string, options?: { status?: number; response?: unknown; cause?: unknown }); }
export function createClient(options: ClientOptions): ViewherdClient;

/** Compatibility aliases for the previous project name. */
export type WebdrClient = ViewherdClient;
export { ViewherdError as WebdrError };
