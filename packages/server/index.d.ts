import type { Command, JSONValue, PanelRegistry, Principal, ViewherdState } from '@viewherd/core';

export interface Receipt { requestId: string; hash: string; result: JSONValue }
export interface SessionRecord { state: ViewherdState; receipts: Receipt[]; storageRevision: number }
export interface CommandResponse { version: 1; requestId: string; sessionId: string; result: JSONValue; revision: number; state: ViewherdState; replayed?: boolean }
export interface ErrorResponse { version: 1; requestId: string | null; sessionId: string | null; error: { code: string; message: string }; state?: ViewherdState }
export interface TransactionOutcome<T = unknown> { record: SessionRecord; response: T; changed: boolean }
export type Transaction<T = unknown> = (record: SessionRecord) => TransactionOutcome<T> | Promise<TransactionOutcome<T>>;
export interface SessionStore {
  readonly kind: string;
  read(sessionId: string): Promise<SessionRecord>;
  /** Return response; committing changes requires storageRevision = original storageRevision + 1. */
  transact<T>(sessionId: string, transaction: Transaction<T>): Promise<T>;
}
export interface AuthorizationContext { sessionId: string; method: string; params: Record<string, unknown> }
/** A trusted server identity, resolved before every operation. null/false denies access. */
export type ControllerPrincipal = Principal | ((context: AuthorizationContext) => Principal | null | false | Promise<Principal | null | false>);
export interface ControllerOptions {
  registry: PanelRegistry;
  store: SessionStore;
  sessionId: string;
  /** Authenticate the caller and check session access in your host before granting this capability. */
  principal: ControllerPrincipal;
}
export interface ControllerCallOptions { requestId?: string; expectedRevision?: number; signal?: AbortSignal }
export interface ViewherdController {
  readonly sessionId: string;
  /** Latest state observed by this controller; reads return detached copies. */
  readonly state: ViewherdState | null;
  snapshot(): Promise<ViewherdState>;
  schema(): Promise<Record<string, JSONValue>>;
  call(method: string, params?: Record<string, JSONValue>, options?: ControllerCallOptions): Promise<CommandResponse>;
  destroy(): void;
}
/** null/false means unauthenticated (401). Throw {code:'forbidden'} or {status:403} for forbidden access. */
export type Authorize = (request: Request, context: AuthorizationContext) => Principal | null | false | Promise<Principal | null | false>;
export interface HandlerOptions {
  registry: PanelRegistry;
  store: SessionStore;
  authorize: Authorize;
  basePath?: string;
  mcpPath?: string;
  /** If configured, reject access to every other session. Also supplies MCP discovery's default session. */
  sessionId?: string;
  /** Only set when an upstream authenticated service dispatch validates MCP origins. Does not bypass authorize. */
  trustedMcpOrigin?: boolean;
  stream?: { pollIntervalMs?: number; lifetimeMs?: number; heartbeatMs?: number };
}
export interface StateFactoryOptions { createState?: (sessionId: string) => ViewherdState | Promise<ViewherdState> }
export interface D1DatabaseLike {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first(): Promise<{ payload: string } | null>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}
export function createMemoryStore(options?: StateFactoryOptions & { maxSessions?: number }): SessionStore;
export function createD1Store(database: D1DatabaseLike, options?: StateFactoryOptions & { retries?: number }): SessionStore;
export function createController(options: ControllerOptions): ViewherdController;
export function createViewherdHandler(options: HandlerOptions): (request: Request) => Promise<Response>;
export type { Command };

/** Compatibility alias; new applications should use createViewherdHandler. */
export { createViewherdHandler as createWebdrHandler };
