/** Protocol version implemented by this SDK. */
export declare const PROTOCOL_VERSION: 1;
/** Default line limit; the host announces its own in `initialize`. */
export declare const MAX_MESSAGE_BYTES: number;

/** Error reported to the host as a failed node. */
export declare class PluginError extends Error {
  constructor(message: string, options?: { kind?: string; retryable?: boolean; retryAfterMs?: number });
  kind: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface Resume {
  /** State returned with `pause(...)`. */
  state: unknown;
  /** Host-supplied input (e.g. a submitted form), or null. */
  input: unknown;
}

export interface RunRequest {
  requestId: string;
  kind: string;
  nodeId: string;
  attempt: number;
  /** Node config with variables resolved by the host. */
  config: Record<string, any>;
  resume: Resume | null;
}

export interface RunResult {
  outputs: Record<string, unknown>;
  branch?: string | null;
  writes?: Array<{ selector: string[] | string; value: unknown }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  metadata?: Record<string, unknown>;
}

export interface PauseResult {
  pause: { kind: string; data: unknown; state: unknown };
}

export declare function pause(kind: string, data?: unknown, state?: unknown): PauseResult;

export declare class RunContext {
  readonly requestId: string;
  /** Stream text for output `field`. */
  chunk(field: string, text: string): void;
  /** Report structured progress. */
  progress(name: string, data?: unknown): void;
  /** Send a log line to the host. */
  log(message: string, level?: "debug" | "info" | "warn" | "error"): void;
  /** Fired when the host cancels this request. */
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
}

export interface ToolSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type ToolResult = string | { text: string; data?: unknown; is_error?: boolean };

export type NodeHandler = (
  ctx: RunContext,
  req: RunRequest,
) => RunResult | PauseResult | Record<string, unknown> | void | Promise<RunResult | PauseResult | Record<string, unknown> | void>;

export declare class Plugin {
  constructor(name: string);
  readonly name: string;
  node(kind: string, handler: NodeHandler, descriptor?: Record<string, unknown>): this;
  tool(spec: ToolSpec, handler: (args: Record<string, any>) => ToolResult | Promise<ToolResult>): this;
  run(options?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): Promise<void>;
}
