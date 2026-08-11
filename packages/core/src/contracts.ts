import type { ErrorObject } from "ajv";

import type { JsonObject, JsonSchema, JsonValue } from "./json.js";

export interface ToolContentBlock {
  readonly type: string;
  readonly [key: string]: JsonValue;
}

export interface SandboxToolResult {
  readonly content: readonly ToolContentBlock[];
  readonly structuredContent?: JsonValue;
}

export interface ProviderToolResult extends SandboxToolResult {
  /** Trusted provider sideband. It never enters the sandbox result. */
  readonly sideband?: Readonly<Record<string, unknown>>;
}

export interface NormalizedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  /** Trusted definition metadata retained for later protocol projections. */
  readonly sideband?: Readonly<Record<string, unknown>>;
}

export interface ProviderStartContext {
  readonly signal: AbortSignal;
  /** Signals that a previously healthy provider lost its source connection. */
  readonly onUnavailable?: () => void;
  /** Replaces a healthy provider's complete tool contribution after refresh. */
  readonly onToolsChanged?: (tools: readonly NormalizedTool[]) => void;
}

export interface ProviderCallContext {
  readonly executionId: string;
  readonly callId: string;
  readonly tool: string;
  readonly input: JsonObject;
  readonly signal: AbortSignal;
}

/**
 * Experimental in v0.1. McpToolProvider is the only supported production
 * implementation until heterogeneous providers arrive in v2.
 */
export interface ToolProvider {
  readonly sourceName: string;
  start(context: ProviderStartContext): Promise<readonly NormalizedTool[]>;
  call(context: ProviderCallContext): Promise<ProviderToolResult>;
  close(): Promise<void>;
}

export interface ToolPolicyRequest {
  readonly executionId: string;
  readonly callId: string;
  readonly source: string;
  readonly tool: string;
  readonly input: JsonObject;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  readonly signal: AbortSignal;
}

export type ToolPolicyDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason?: string };

export type ToolPolicy = (
  request: ToolPolicyRequest,
) => ToolPolicyDecision | Promise<ToolPolicyDecision>;

export interface SandboxToolCall {
  readonly source: string;
  readonly tool: string;
  readonly input: JsonObject;
}

export interface SandboxLogEntry {
  readonly level: "debug" | "info" | "warn" | "error" | "log";
  readonly message: string;
}

export interface SandboxExecuteRequest {
  readonly javascript: string;
  readonly tools: Readonly<Record<string, readonly string[]>>;
  readonly limits: ExecutionLimits;
  readonly signal: AbortSignal;
  readonly callTool: (call: SandboxToolCall) => Promise<SandboxToolResult>;
}

export interface SandboxExecuteResult {
  readonly value?: JsonValue;
  readonly logs: readonly SandboxLogEntry[];
}

export interface CodeSandbox {
  execute(request: SandboxExecuteRequest): Promise<SandboxExecuteResult>;
}

export type CompileResult =
  | { readonly ok: true; readonly javascript: string }
  | { readonly ok: false; readonly diagnostic: ModelDiagnostic };

export interface CodeCompiler {
  compile(code: string): CompileResult;
}

export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

export type DiagnosticPhase = "compile" | "sandbox" | "tool" | "policy" | "host";

export type SdkErrorCode =
  | "CODE_COMPILE_FAILED"
  | "CODE_SOURCE_TOO_LARGE"
  | "CODE_UNSAFE_SYNTAX"
  | "EXECUTION_CANCELLED"
  | "EXECUTION_COMPUTE_LIMIT"
  | "EXECUTION_WALL_LIMIT"
  | "FINAL_RESULT_TOO_LARGE"
  | "SANDBOX_RUNTIME_FAILED"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_UNAVAILABLE"
  | "TOOL_APPROVAL_DENIED"
  | "TOOL_CALL_LIMIT"
  | "TOOL_EXECUTION_FAILED"
  | "TOOL_INPUT_INVALID"
  | "TOOL_NOT_FOUND"
  | "TOOL_RESULT_INVALID"
  | "TOOL_RESULT_TOO_LARGE"
  | "TOOL_SCHEMA_UNSUPPORTED"
  | "TOOL_TIMEOUT";

export interface ModelDiagnostic {
  readonly code: SdkErrorCode;
  readonly phase: DiagnosticPhase;
  readonly message: string;
  readonly location?: SourceLocation;
  readonly validation?: readonly ErrorObject[];
  readonly source?: string;
  readonly tool?: string;
}

export interface ExecutionLimits {
  readonly sourceBytes: number;
  readonly computeTimeMs: number;
  readonly wallTimeMs: number;
  readonly toolCallTimeMs: number;
  readonly memoryBytes: number;
  readonly maxToolCalls: number;
  readonly maxConcurrentToolCalls: number;
  readonly toolResultBytes: number;
  readonly totalBridgeBytes: number;
  readonly finalResultBytes: number;
  readonly logBytes: number;
  readonly logEntries: number;
}

export type CodeModeRunResult =
  | {
      readonly ok: true;
      readonly executionId: string;
      readonly value?: JsonValue;
      readonly logs: readonly SandboxLogEntry[];
    }
  | {
      readonly ok: false;
      readonly executionId: string;
      readonly diagnostic: ModelDiagnostic;
      readonly logs: readonly SandboxLogEntry[];
    };

export interface CodeModeRunRequest {
  readonly code: string;
  readonly signal?: AbortSignal;
  /** Best-effort provider-independent lifecycle updates. */
  readonly onProgress?: (event: CodeModeProgress) => void;
}

/**
 * Bounded host-side lifecycle metadata. Events intentionally exclude authored
 * code, tool inputs, tool results, logs, and diagnostic messages.
 */
export type CodeModeObservation =
  | {
      readonly type: "execution_started";
      readonly timestampMs: number;
      readonly executionId: string;
      readonly sourceBytes: number;
    }
  | {
      readonly type: "execution_completed";
      readonly timestampMs: number;
      readonly executionId: string;
      readonly ok: boolean;
      readonly durationMs: number;
      readonly logEntries: number;
      readonly errorCode?: SdkErrorCode;
      readonly phase?: DiagnosticPhase;
    }
  | {
      readonly type: "tool_call_queued";
      readonly timestampMs: number;
      readonly executionId: string;
      readonly callId: string;
      readonly source: string;
      readonly tool: string;
      readonly inputBytes: number;
    }
  | {
      readonly type: "tool_call_started";
      readonly timestampMs: number;
      readonly executionId: string;
      readonly callId: string;
      readonly source: string;
      readonly tool: string;
      readonly queuedDurationMs: number;
    }
  | {
      readonly type: "tool_call_completed";
      readonly timestampMs: number;
      readonly executionId: string;
      readonly callId: string;
      readonly source: string;
      readonly tool: string;
      readonly ok: boolean;
      readonly durationMs: number;
      readonly resultBytes?: number;
      readonly errorCode?: SdkErrorCode;
      readonly phase?: DiagnosticPhase;
    };

export type CodeModeObserver = (
  event: CodeModeObservation,
) => void | Promise<void>;

export interface CodeModeProgress {
  readonly sequence: number;
  readonly phase:
    | "compile_started"
    | "compile_completed"
    | "sandbox_started"
    | "tool_queued"
    | "tool_started"
    | "tool_completed"
    | "execution_completed";
  readonly message: string;
  readonly source?: string;
  readonly tool?: string;
  readonly callId?: string;
}

export interface StartupSourceReport {
  readonly source: string;
  readonly status: "healthy" | "unavailable";
  readonly toolCount: number;
  readonly message?: string;
  readonly rejectedToolCount?: number;
  readonly diagnostics?: readonly CatalogDiagnostic[];
  readonly diagnosticsTruncated?: boolean;
}

export interface StartupReport {
  readonly status: "ready" | "degraded";
  readonly catalogRevision: string;
  readonly sources: readonly StartupSourceReport[];
}

export interface TypeScriptCatalog {
  readonly catalogRevision: string;
  readonly declarations: string;
}

export interface CatalogDiagnostic {
  readonly code: "TOOL_SCHEMA_UNSUPPORTED";
  readonly severity: "error";
  readonly source: string;
  readonly tool: string;
  readonly schema: "input" | "output";
  readonly message: string;
}

export interface CatalogDiagnosticsRequest {
  readonly source?: string;
  readonly limit?: number;
}

export interface CatalogDiagnosticsResult {
  readonly catalogRevision: string;
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly diagnostics: readonly CatalogDiagnostic[];
}

export interface SearchToolsRequest {
  readonly query: string;
  readonly source?: string;
  readonly detail?: "summary" | "typescript";
  readonly limit?: number;
}

export interface SearchToolTypeScript {
  readonly inputType: string;
  readonly outputType: string;
  readonly declaration: string;
}

export interface SearchToolResultContract {
  readonly declaration: string;
  readonly guidance: readonly string[];
  readonly example: string;
}

export interface SearchToolMatch {
  readonly source: string;
  readonly tool: string;
  readonly address: readonly [source: string, tool: string];
  readonly callable: string;
  readonly description?: string;
  readonly typescript?: SearchToolTypeScript;
}

export interface SearchToolsResult {
  readonly catalogRevision: string;
  readonly query: string;
  readonly returned: number;
  readonly truncated: boolean;
  readonly results: readonly SearchToolMatch[];
  /** Present for `detail: "typescript"` so bounded discovery is self-contained. */
  readonly resultContract?: SearchToolResultContract;
  readonly diagnostic?: ModelDiagnostic;
  readonly suggestions?: readonly string[];
}

export interface ReconnectOptions {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly jitterRatio: number;
}
