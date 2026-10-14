export type JSONValue = null | boolean | number | string | JSONValue[] | JSONObject;
export interface JSONObject { [key: string]: JSONValue }

/** Supported JSON Schema subset. Unknown keywords are rejected at registration. */
export interface JSONSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | Array<'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'>;
  title?: string;
  description?: string;
  default?: JSONValue;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
  items?: JSONSchema;
  enum?: JSONValue[];
  const?: JSONValue;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  maxProperties?: number;
}

export interface Pane {
  id: string;
  title: string;
  view: string;
  data: JSONObject;
}
export type Layout = { type: 'pane'; paneId: string } | { type: 'split'; id: string; direction: 'right' | 'down'; ratio: number; first: Layout; second: Layout };
export interface Tab { id: string; label: string; focusedPaneId: string; zoomedPaneId: string | null; layout: Layout }
export interface Workspace { id: string; label: string; activeTabId: string; tabs: Tab[] }
export interface ViewherdEvent { id: string; revision: number; time: string; method: string; actor: string; summary: string; requestId?: string; paneId?: string; action?: string }
export interface Agent { id: string; name: string; status: 'idle' | 'working' | 'blocked' | 'done'; paneId?: string; message?: string }
export interface ViewherdState { version: 1; sessionId: string; revision: number; activeWorkspaceId: string; workspaces: Workspace[]; panes: Record<string, Pane>; app: JSONObject; agents: Agent[]; events: ViewherdEvent[] }
export interface Principal { id: string; actor?: string; name?: string; [key: string]: JSONValue | undefined }

export interface ActionContext {
  /** Private mutable application-state clone. Changes commit only if the action succeeds. */
  readonly app: JSONObject;
  /** Live target pane; undefined if the handler closed it. */
  readonly pane: Pane | undefined;
  /** Private draft. Session identity, revisions and event history cannot be changed. */
  readonly state: ViewherdState;
  readonly principal: Readonly<Principal> | null;
  readonly requestId: string;
  /** Synchronous layout/data call. Returns the operation result; panel.action nesting is rejected. */
  call(method: string, params?: JSONObject): JSONValue;
}
export interface PanelAction {
  description?: string;
  inputSchema?: JSONSchema;
  outputSchema?: JSONSchema;
  /** Must perform deterministic state changes only; external side effects are not supported. */
  run(context: ActionContext, args: JSONObject): JSONValue | Promise<JSONValue>;
}
export interface PanelDefinition { type: string; title?: string; description?: string; dataSchema?: JSONSchema; actions?: Record<string, PanelAction> }
export interface RegisteredPanel { readonly type: string; readonly title: string; readonly description: string; readonly dataSchema: JSONSchema; readonly actions: Readonly<Record<string, PanelAction>> }
export interface WirePanel { type: string; title: string; description: string; dataSchema: JSONSchema; actions: Array<{ name: string; description: string; inputSchema: JSONSchema; outputSchema?: JSONSchema }> }
export interface PanelRegistry {
  get(type: string): RegisteredPanel | undefined;
  has(type: string): boolean;
  /** Serializable discovery definitions, without handler functions. */
  schema(): WirePanel[];
  validateData(type: string, data: JSONObject): void;
}

export interface SessionOptions { id: string; label?: string; view?: string; title?: string; data?: JSONObject; app?: JSONObject; registry?: PanelRegistry }
export interface Command { version: 1; requestId: string; sessionId: string; method: string; params?: JSONObject; expectedRevision?: number }
export interface CommandOutcome { state: ViewherdState; result: JSONValue; changed: boolean }

export function definePanel(definition: PanelDefinition): RegisteredPanel;
export function createRegistry(definitions?: Array<PanelDefinition | RegisteredPanel>): PanelRegistry;
/** Custom initial data validates eagerly if registry is provided, otherwise on first dispatch. */
export function createSession(options: SessionOptions): ViewherdState;
export function executeCommand(state: ViewherdState, command: Command, options?: { registry?: PanelRegistry; principal?: Principal }): Promise<CommandOutcome>;

/** Compatibility aliases for the previous project name. */
export type WebdrState = ViewherdState;
export type WebdrEvent = ViewherdEvent;
