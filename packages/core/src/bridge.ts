import type { ErrorObject } from "ajv";

import type {
  ExecutionLimits,
  CodeModeProgress,
  ProviderToolResult,
  SandboxToolCall,
  SandboxToolResult,
  ToolContentBlock,
  ToolPolicy,
} from "./contracts.js";
import { CodeModeError, ProviderToolError } from "./errors.js";
import { stringifyJson, utf8Bytes, type JsonObject, type JsonValue } from "./json.js";
import { Semaphore } from "./semaphore.js";
import type { ToolCatalog } from "./catalog.js";

export class ExecutionToolBridge {
  readonly #catalog: ToolCatalog;
  readonly #executionId: string;
  readonly #limits: ExecutionLimits;
  readonly #policy: ToolPolicy;
  readonly #rootSignal: AbortSignal;
  readonly #semaphore: Semaphore;
  readonly #onProgress: ((event: Omit<CodeModeProgress, "sequence">) => void) | undefined;

  #callCount = 0;
  #bridgeBytes = 0;

  constructor(options: {
    readonly catalog: ToolCatalog;
    readonly executionId: string;
    readonly limits: ExecutionLimits;
    readonly policy: ToolPolicy;
    readonly signal: AbortSignal;
    readonly onProgress?: (event: Omit<CodeModeProgress, "sequence">) => void;
  }) {
    this.#catalog = options.catalog;
    this.#executionId = options.executionId;
    this.#limits = options.limits;
    this.#policy = options.policy;
    this.#rootSignal = options.signal;
    this.#onProgress = options.onProgress;
    this.#semaphore = new Semaphore(options.limits.maxConcurrentToolCalls);
  }

  async call(call: SandboxToolCall): Promise<SandboxToolResult> {
    this.#throwIfCancelled();

    const entry = this.#catalog.get(call.source, call.tool);
    if (entry === undefined) {
      const sourceStatus = this.#catalog.sourceStatus(call.source);
      const rejected = this.#catalog.rejected(call.source, call.tool);
      throw new CodeModeError({
        code:
          sourceStatus === "unavailable"
            ? "SOURCE_UNAVAILABLE"
            : rejected !== undefined
              ? "TOOL_SCHEMA_UNSUPPORTED"
              : sourceStatus === "healthy"
                ? "TOOL_NOT_FOUND"
                : "SOURCE_NOT_FOUND",
        phase: "tool",
        message:
          sourceStatus === "unavailable"
            ? `Tool source ${call.source} is temporarily unavailable`
            : rejected !== undefined
              ? rejected.message
              : sourceStatus === "healthy"
                ? `Tool ${call.source}.${call.tool} is not available`
                : `Tool source ${call.source} was not configured`,
        source: call.source,
        tool: call.tool,
      });
    }

    let inputJson: string;
    try {
      inputJson = stringifyJson(call.input);
    } catch {
      throw this.#toolError(
        "TOOL_INPUT_INVALID",
        "Tool input must be a JSON-serializable object",
        call,
      );
    }

    if (!entry.validateInput(call.input)) {
      throw new CodeModeError({
        code: "TOOL_INPUT_INVALID",
        phase: "tool",
        message: `Input for ${call.source}.${call.tool} does not match its schema`,
        source: call.source,
        tool: call.tool,
        validation: cloneValidationErrors(entry.validateInput.errors),
      });
    }

    const callNumber = ++this.#callCount;
    if (callNumber > this.#limits.maxToolCalls) {
      throw this.#toolError(
        "TOOL_CALL_LIMIT",
        `Execution exceeded the ${this.#limits.maxToolCalls} tool-call limit`,
        call,
      );
    }

    const callId = `${this.#executionId}:tool:${callNumber}`;
    this.#onProgress?.({
      phase: "tool_queued",
      message: `${call.source}.${call.tool}: queued`,
      source: call.source,
      tool: call.tool,
      callId,
    });

    this.#addBridgeBytes(utf8Bytes(inputJson), call);

    let release: () => void;
    try {
      release = await this.#semaphore.acquire(this.#rootSignal);
    } catch {
      this.#throwIfCancelled();
      throw this.#toolError(
        "TOOL_EXECUTION_FAILED",
        "Tool call could not enter the execution queue",
        call,
      );
    }

    try {
      let decision;
      try {
        decision = await this.#policy({
          executionId: this.#executionId,
          callId,
          source: call.source,
          tool: call.tool,
          input: call.input,
          ...(entry.definition.annotations === undefined
            ? {}
            : { annotations: entry.definition.annotations }),
          signal: this.#rootSignal,
        });
      } catch {
        this.#throwIfCancelled();
        throw this.#toolError(
          "TOOL_APPROVAL_DENIED",
          `Authorization failed closed for ${call.source}.${call.tool}`,
          call,
          "policy",
        );
      }

      if (!isPolicyDecision(decision)) {
        throw this.#toolError(
          "TOOL_APPROVAL_DENIED",
          `Authorization failed closed for ${call.source}.${call.tool}`,
          call,
          "policy",
        );
      }

      if (decision.decision !== "allow") {
        const suffix =
          decision.reason === undefined
            ? ""
            : `: ${decision.reason.slice(0, 256)}`;
        throw this.#toolError(
          "TOOL_APPROVAL_DENIED",
          `Tool call was denied${suffix}`,
          call,
          "policy",
        );
      }

      this.#onProgress?.({
        phase: "tool_started",
        message: `${call.source}.${call.tool}: started`,
        source: call.source,
        tool: call.tool,
        callId,
      });

      const result = await this.#invokeWithTimeout(
        (signal) =>
          entry.provider.call({
            executionId: this.#executionId,
            callId,
            tool: call.tool,
            input: call.input,
            signal,
          }),
        call,
      );
      const sandboxResult = validateProviderResult(result, call);

      if (
        entry.validateOutput !== undefined &&
        !entry.validateOutput(sandboxResult.structuredContent)
      ) {
        throw new CodeModeError({
          code: "TOOL_RESULT_INVALID",
          phase: "tool",
          message: `Structured result from ${call.source}.${call.tool} does not match its schema`,
          source: call.source,
          tool: call.tool,
          validation: cloneValidationErrors(entry.validateOutput.errors),
        });
      }

      const resultJson = stringifyJson(sandboxResult);
      const resultBytes = utf8Bytes(resultJson);
      if (resultBytes > this.#limits.toolResultBytes) {
        throw this.#toolError(
          "TOOL_RESULT_TOO_LARGE",
          `Tool result exceeds the ${this.#limits.toolResultBytes}-byte limit`,
          call,
        );
      }
      this.#addBridgeBytes(resultBytes, call);
      this.#onProgress?.({
        phase: "tool_completed",
        message: `${call.source}.${call.tool}: completed`,
        source: call.source,
        tool: call.tool,
        callId,
      });
      return sandboxResult;
    } finally {
      release();
    }
  }

  async #invokeWithTimeout(
    invoke: (signal: AbortSignal) => Promise<ProviderToolResult>,
    call: SandboxToolCall,
  ): Promise<ProviderToolResult> {
    let timedOut = false;
    const callController = new AbortController();
    const onRootAbort = (): void => callController.abort(this.#rootSignal.reason);
    if (this.#rootSignal.aborted) {
      onRootAbort();
    } else {
      this.#rootSignal.addEventListener("abort", onRootAbort, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      callController.abort(new Error("tool timeout"));
    }, this.#limits.toolCallTimeMs);
    const invocation = Promise.resolve().then(() => invoke(callController.signal));

    try {
      return await raceWithAbort(invocation, callController.signal);
    } catch (error) {
      if (timedOut) {
        throw this.#toolError(
          "TOOL_TIMEOUT",
          `Tool call exceeded ${this.#limits.toolCallTimeMs}ms`,
          call,
        );
      }
      this.#throwIfCancelled();
      if (error instanceof CodeModeError) {
        throw error;
      }
      if (error instanceof ProviderToolError) {
        throw this.#toolError(
          "TOOL_EXECUTION_FAILED",
          error.message.slice(0, 1_024),
          call,
        );
      }
      throw this.#toolError(
        "TOOL_EXECUTION_FAILED",
        `Tool ${call.source}.${call.tool} failed`,
        call,
      );
    } finally {
      clearTimeout(timeout);
      this.#rootSignal.removeEventListener("abort", onRootAbort);
    }
  }

  #addBridgeBytes(bytes: number, call: SandboxToolCall): void {
    this.#bridgeBytes += bytes;
    if (this.#bridgeBytes > this.#limits.totalBridgeBytes) {
      throw this.#toolError(
        "TOOL_RESULT_TOO_LARGE",
        `Execution exceeded the ${this.#limits.totalBridgeBytes}-byte bridge limit`,
        call,
      );
    }
  }

  #throwIfCancelled(): void {
    if (this.#rootSignal.aborted) {
      throw new CodeModeError({
        code: "EXECUTION_CANCELLED",
        phase: "host",
        message: "Execution was cancelled",
      });
    }
  }

  #toolError(
    code:
      | "TOOL_APPROVAL_DENIED"
      | "TOOL_CALL_LIMIT"
      | "TOOL_EXECUTION_FAILED"
      | "TOOL_INPUT_INVALID"
      | "TOOL_RESULT_TOO_LARGE"
      | "TOOL_TIMEOUT",
    message: string,
    call: SandboxToolCall,
    phase: "tool" | "policy" = "tool",
  ): CodeModeError {
    return new CodeModeError({
      code,
      phase,
      message,
      source: call.source,
      tool: call.tool,
    });
  }
}

function validateProviderResult(
  result: ProviderToolResult,
  call: SandboxToolCall,
): SandboxToolResult {
  if (typeof result !== "object" || result === null || !Array.isArray(result.content)) {
    throw invalidResult(call);
  }

  const content: ToolContentBlock[] = [];
  for (const candidate of result.content) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.type !== "string"
    ) {
      throw invalidResult(call);
    }
    content.push(candidate);
  }

  const normalized =
    result.structuredContent === undefined
      ? { content }
      : { content, structuredContent: result.structuredContent };

  try {
    stringifyJson(normalized);
  } catch {
    throw invalidResult(call);
  }
  return normalized;
}

function invalidResult(call: SandboxToolCall): CodeModeError {
  return new CodeModeError({
    code: "TOOL_RESULT_INVALID",
    phase: "tool",
    message: `Tool ${call.source}.${call.tool} returned an invalid result`,
    source: call.source,
    tool: call.tool,
  });
}

function cloneValidationErrors(
  errors: readonly ErrorObject[] | null | undefined,
): readonly ErrorObject[] {
  return errors?.map((error) => ({ ...error, params: { ...error.params } })) ?? [];
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isPolicyDecision(
  value: unknown,
): value is { readonly decision: "allow" } | {
  readonly decision: "deny";
  readonly reason?: string;
} {
  if (typeof value !== "object" || value === null || !("decision" in value)) {
    return false;
  }
  const decision = (value as { readonly decision?: unknown }).decision;
  if (decision === "allow") {
    return true;
  }
  const reason = (value as { readonly reason?: unknown }).reason;
  return decision === "deny" && (reason === undefined || typeof reason === "string");
}
