import { performance } from "node:perf_hooks";

import {
  CodeModeError,
  SDK_ERROR_CODES,
  type JsonObject,
  type JsonValue,
  type ModelDiagnostic,
  type SandboxExecuteRequest,
  type SandboxExecuteResult,
  type SandboxLogEntry,
  type SdkErrorCode,
} from "@codemodekit/core";
import {
  DEBUG_SYNC,
  newQuickJSWASMModule,
  RELEASE_SYNC,
  isFail,
  type ExecutePendingJobsResult,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type VmCallResult,
} from "quickjs-emscripten";

const SAFE_GLOBALS = [
  "globalThis",
  "Infinity",
  "NaN",
  "undefined",
  "Object",
  "Array",
  "Number",
  "String",
  "Boolean",
  "BigInt",
  "Symbol",
  "Math",
  "JSON",
  "Reflect",
  "Promise",
  "Proxy",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Date",
  "RegExp",
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "ArrayBuffer",
  "DataView",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "BigUint64Array",
  "BigInt64Array",
  "Float32Array",
  "Float64Array",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
] as const;

const PRUNE_GLOBALS_SOURCE = `
(() => {
  "use strict";
  const functionPrototypes = [
    Object.getPrototypeOf(function () {}),
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ];
  for (const prototype of functionPrototypes) {
    try {
      Object.defineProperty(prototype, "constructor", {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {}
  }

  const allowed = new Set(${JSON.stringify(SAFE_GLOBALS)});
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!allowed.has(name)) {
      try { delete globalThis[name]; } catch {}
    }
  }
})();
`;

const TOOL_BOOTSTRAP_SOURCE = `
(() => {
  "use strict";
  const callHost = globalThis.__codeModeCallTool;
  const definitions = JSON.parse(globalThis.__codeModeToolDefinitions);
  delete globalThis.__codeModeCallTool;
  delete globalThis.__codeModeToolDefinitions;

  class ToolCallError extends Error {
    constructor(diagnostic) {
      super(diagnostic.message);
      this.name = "ToolCallError";
      this.code = diagnostic.code;
      this.phase = diagnostic.phase;
      if (diagnostic.source !== undefined) this.source = diagnostic.source;
      if (diagnostic.tool !== undefined) this.tool = diagnostic.tool;
    }
  }

  const createSourceTools = (source, names) => {
    const createInvoke = (name) => async (input = {}) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new ToolCallError({
          code: "TOOL_INPUT_INVALID",
          phase: "tool",
          message: "Tool input must be an object",
          source,
          tool: name,
        });
      }
      const raw = await callHost(source, name, JSON.stringify(input));
      const response = JSON.parse(raw);
      if (!response.ok) throw new ToolCallError(response.diagnostic);
      return response.result;
    };
    const sourceTarget = Object.create(null);
    for (const name of names) {
      Object.defineProperty(sourceTarget, name, {
        value: Object.freeze(createInvoke(name)),
        enumerable: true,
      });
    }
    Object.freeze(sourceTarget);
    const sourceTools = new Proxy(sourceTarget, {
      get(target, property, receiver) {
        if (typeof property !== "string" || Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        // Avoid turning the source namespace into a thenable: awaiting it
        // must resolve immediately instead of hanging until the wall limit.
        if (property === "then") return undefined;
        return Object.freeze(createInvoke(property));
      },
    });
    return sourceTools;
  };

  const toolsTarget = Object.create(null);
  for (const [source, names] of Object.entries(definitions)) {
    Object.defineProperty(toolsTarget, source, {
      value: createSourceTools(source, names),
      enumerable: true,
    });
  }
  Object.freeze(toolsTarget);
  const tools = new Proxy(toolsTarget, {
    get(target, property, receiver) {
      if (typeof property !== "string" || Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      // Avoid accidentally turning the entire namespace into a thenable.
      if (property === "then") return undefined;
      return createSourceTools(property, []);
    },
  });

  Object.defineProperty(globalThis, "ToolCallError", {
    value: ToolCallError,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(globalThis, "tools", {
    value: tools,
    writable: false,
    configurable: false,
  });
})();
`;

export class QuickJsSandbox {
  readonly #debug: boolean;

  constructor(options: { readonly debug?: boolean } = {}) {
    this.#debug = options.debug ?? false;
  }

  async execute(request: SandboxExecuteRequest): Promise<SandboxExecuteResult> {
    const module = await newQuickJSWASMModule(
      this.#debug ? DEBUG_SYNC : RELEASE_SYNC,
    );
    const runtime = module.newRuntime();
    const context = runtime.newContext();
    const cancellation = abortFailure(request.signal);
    const logs = new BoundedLogCollector(
      request.limits.logEntries,
      request.limits.logBytes,
    );
    const pendingCalls = new Set<Promise<void>>();
    const pendingDeferreds = new Set<QuickJSDeferredPromise>();
    const jobFailure = deferredFailure();
    let alive = true;
    let computeUsedMs = 0;
    let activeStartedAt: number | undefined;
    let computeExceeded = false;

    const runGuest = <T>(operation: () => T): T => {
      const startedAt = performance.now();
      activeStartedAt = startedAt;
      try {
        return operation();
      } finally {
        computeUsedMs += performance.now() - startedAt;
        activeStartedAt = undefined;
      }
    };

    const runPendingJobs = (): void => {
      if (!alive) {
        return;
      }
      const result = runGuest(() => runtime.executePendingJobs());
      if (isFail(result)) {
        const dumped = result.error.context.dump(result.error);
        result.error.dispose();
        jobFailure.reject(
          guestFailure(dumped, computeExceeded, request.signal.aborted, logs.values()),
        );
      }
    };

    try {
      runtime.setMemoryLimit(request.limits.memoryBytes);
      runtime.removeModuleLoader();

      unwrapImmediate(context, context.evalCode(PRUNE_GLOBALS_SOURCE, "bootstrap.js"));
      installConsole(context, logs);
      installToolBridge(
        context,
        request,
        pendingCalls,
        pendingDeferreds,
        runPendingJobs,
        () => alive,
      );
      setGlobalString(
        context,
        "__codeModeToolDefinitions",
        JSON.stringify(request.tools),
      );
      unwrapImmediate(
        context,
        context.evalCode(TOOL_BOOTSTRAP_SOURCE, "tools-bootstrap.js"),
      );

      runtime.setInterruptHandler(() => {
        if (request.signal.aborted) {
          return true;
        }
        const activeMs =
          activeStartedAt === undefined ? 0 : performance.now() - activeStartedAt;
        if (computeUsedMs + activeMs >= request.limits.computeTimeMs) {
          computeExceeded = true;
          return true;
        }
        return false;
      });

      const evaluated = runGuest(() => context.evalCode(request.javascript, "model.js"));
      if (isFail(evaluated)) {
        const dumped = context.dump(evaluated.error);
        evaluated.error.dispose();
        throw guestFailure(
          dumped,
          computeExceeded,
          request.signal.aborted,
          logs.values(),
        );
      }

      const promiseHandle = evaluated.value;
      const resolvedPromise = context.resolvePromise(promiseHandle);
      runPendingJobs();

      let resolved;
      try {
        resolved = await Promise.race([
          resolvedPromise,
          jobFailure.promise,
          cancellation.promise,
        ]);
      } finally {
        promiseHandle.dispose();
      }

      if (isFail(resolved)) {
        const dumped = context.dump(resolved.error);
        resolved.error.dispose();
        throw guestFailure(
          dumped,
          computeExceeded,
          request.signal.aborted,
          logs.values(),
        );
      }

      const dumpedValue = context.dump(resolved.value) as unknown;
      resolved.value.dispose();

      while (pendingCalls.size > 0) {
        await Promise.race([
          Promise.allSettled([...pendingCalls]),
          jobFailure.promise,
          cancellation.promise,
        ]);
      }

      if (request.signal.aborted) {
        throw cancelled(logs.values());
      }
      if (computeExceeded) {
        throw computeLimit(request.limits.computeTimeMs, logs.values());
      }

      if (dumpedValue === undefined) {
        return { logs: logs.values() };
      }

      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(dumpedValue);
      } catch {
        throw runtimeFailure(
          "Final value is not JSON serializable",
          logs.values(),
        );
      }
      if (serialized === undefined) {
        return { logs: logs.values() };
      }

      return {
        value: JSON.parse(serialized) as JsonValue,
        logs: logs.values(),
      };
    } catch (error) {
      if (error instanceof CodeModeError) {
        throw error;
      }
      if (request.signal.aborted) {
        throw cancelled(logs.values());
      }
      if (computeExceeded) {
        throw computeLimit(request.limits.computeTimeMs, logs.values());
      }
      throw runtimeFailure("Sandbox execution failed", logs.values(), error);
    } finally {
      alive = false;
      cancellation.dispose();
      runtime.removeInterruptHandler();
      for (const deferred of pendingDeferreds) {
        deferred.dispose();
      }
      pendingDeferreds.clear();
      context.dispose();
      runtime.dispose();
    }
  }
}

function installToolBridge(
  context: QuickJSContext,
  request: SandboxExecuteRequest,
  pendingCalls: Set<Promise<void>>,
  pendingDeferreds: Set<QuickJSDeferredPromise>,
  runPendingJobs: () => void,
  isAlive: () => boolean,
): void {
  const hostFunction = context.newFunction(
    "__codeModeCallTool",
    (sourceHandle, toolHandle, inputHandle) => {
      const deferred = context.newPromise();
      pendingDeferreds.add(deferred);
      const source = context.getString(sourceHandle);
      const tool = context.getString(toolHandle);
      const inputJson = context.getString(inputHandle);

      const pending = (async (): Promise<void> => {
        const response = await createBridgeResponse(
          request,
          source,
          tool,
          inputJson,
        );
        if (!isAlive()) {
          return;
        }
        const responseHandle = context.newString(JSON.stringify(response));
        try {
          deferred.resolve(responseHandle);
        } finally {
          responseHandle.dispose();
        }
      })();

      pendingCalls.add(pending);
      void pending.finally(() => pendingCalls.delete(pending));
      void deferred.settled.then(() => {
        pendingDeferreds.delete(deferred);
        runPendingJobs();
      });
      return deferred.handle;
    },
  );
  hostFunction.consume((handle) =>
    context.setProp(context.global, "__codeModeCallTool", handle),
  );
}

async function createBridgeResponse(
  request: SandboxExecuteRequest,
  source: string,
  tool: string,
  inputJson: string,
): Promise<
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly diagnostic: ModelDiagnostic }
> {
  try {
    const input = JSON.parse(inputJson) as unknown;
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return {
        ok: false,
        diagnostic: {
          code: "TOOL_INPUT_INVALID",
          phase: "tool",
          message: "Tool input must be an object",
          source,
          tool,
        },
      };
    }
    const result = await request.callTool({
      source,
      tool,
      input: input as JsonObject,
    });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof CodeModeError) {
      return { ok: false, diagnostic: error.diagnostic };
    }
    return {
      ok: false,
      diagnostic: {
        code: "TOOL_EXECUTION_FAILED",
        phase: "tool",
        message: `Tool ${source}.${tool} failed`,
        source,
        tool,
      },
    };
  }
}

function installConsole(
  context: QuickJSContext,
  logs: BoundedLogCollector,
): void {
  const consoleHandle = context.newObject();
  for (const level of ["debug", "info", "warn", "error", "log"] as const) {
    const method = context.newFunction(level, (...handles) => {
      const message = handles.map((handle) => formatDump(context.dump(handle))).join(" ");
      logs.add({ level, message });
    });
    context.setProp(consoleHandle, level, method);
    method.dispose();
  }
  context.setProp(context.global, "console", consoleHandle);
  consoleHandle.dispose();
}

function setGlobalString(
  context: QuickJSContext,
  name: string,
  value: string,
): void {
  const handle = context.newString(value);
  context.setProp(context.global, name, handle);
  handle.dispose();
}

function unwrapImmediate(
  context: QuickJSContext,
  result: VmCallResult<QuickJSHandle>,
): void {
  if (isFail(result)) {
    const dumped = context.dump(result.error);
    result.error.dispose();
    throw runtimeFailure(`Sandbox bootstrap failed: ${guestMessage(dumped)}`, []);
  }
  result.value.dispose();
}

function guestFailure(
  dumped: unknown,
  computeExceeded: boolean,
  aborted: boolean,
  logs: readonly SandboxLogEntry[],
): CodeModeError {
  if (aborted) {
    return cancelled(logs);
  }
  if (computeExceeded || guestMessage(dumped) === "interrupted") {
    return computeLimit(undefined, logs);
  }

  if (isRecord(dumped) && isSdkErrorCode(dumped.code)) {
    const phase =
      dumped.phase === "policy" || dumped.phase === "tool"
        ? dumped.phase
        : "tool";
    return new CodeModeError(
      {
        code: dumped.code,
        phase,
        message: guestMessage(dumped).slice(0, 1_024),
        ...(typeof dumped.source === "string" ? { source: dumped.source } : {}),
        ...(typeof dumped.tool === "string" ? { tool: dumped.tool } : {}),
      },
      { logs },
    );
  }

  return runtimeFailure(guestMessage(dumped).slice(0, 1_024), logs);
}

function guestMessage(dumped: unknown): string {
  if (isRecord(dumped) && typeof dumped.message === "string") {
    return dumped.message;
  }
  if (typeof dumped === "string") {
    return dumped;
  }
  return "Sandbox code threw an exception";
}

function cancelled(logs: readonly SandboxLogEntry[]): CodeModeError {
  return new CodeModeError(
    {
      code: "EXECUTION_CANCELLED",
      phase: "sandbox",
      message: "Execution was cancelled",
    },
    { logs },
  );
}

function computeLimit(
  limitMs: number | undefined,
  logs: readonly SandboxLogEntry[],
): CodeModeError {
  return new CodeModeError(
    {
      code: "EXECUTION_COMPUTE_LIMIT",
      phase: "sandbox",
      message:
        limitMs === undefined
          ? "Execution exceeded its compute-time limit"
          : `Execution exceeded ${limitMs}ms of compute time`,
    },
    { logs },
  );
}

function runtimeFailure(
  message: string,
  logs: readonly SandboxLogEntry[],
  cause?: unknown,
): CodeModeError {
  return new CodeModeError(
    {
      code: "SANDBOX_RUNTIME_FAILED",
      phase: "sandbox",
      message,
    },
    { ...(cause === undefined ? {} : { cause }), logs },
  );
}

function abortFailure(signal: AbortSignal): {
  readonly promise: Promise<never>;
  readonly dispose: () => void;
} {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function deferredFailure(): {
  readonly promise: Promise<never>;
  readonly reject: (error: unknown) => void;
} {
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  return {
    promise,
    reject: (error) => rejectPromise?.(error),
  };
}

class BoundedLogCollector {
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #entries: SandboxLogEntry[] = [];
  #bytes = 0;
  #truncated = false;

  constructor(maxEntries: number, maxBytes: number) {
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
  }

  add(entry: SandboxLogEntry): void {
    const bounded: SandboxLogEntry = {
      level: entry.level,
      message: truncateUtf8(entry.message, Math.max(1, this.#maxBytes / 4)),
    };
    const bytes = Buffer.byteLength(bounded.message, "utf8");

    if (
      !this.#truncated &&
      this.#entries.length + 1 <= this.#maxEntries &&
      this.#bytes + bytes <= this.#maxBytes
    ) {
      this.#entries.push(bounded);
      this.#bytes += bytes;
      return;
    }

    if (!this.#truncated) {
      this.#truncated = true;
      const keepHead = Math.max(0, Math.floor((this.#maxEntries - 1) / 2));
      this.#entries.splice(keepHead);
      this.#bytes = this.#entries.reduce(
        (total, item) => total + Buffer.byteLength(item.message, "utf8"),
        0,
      );
      this.#entries.push({ level: "warn", message: "[logs truncated]" });
      this.#bytes += Buffer.byteLength("[logs truncated]", "utf8");
    }

    this.#entries.push(bounded);
    this.#bytes += bytes;
    while (
      this.#entries.length > this.#maxEntries ||
      this.#bytes > this.#maxBytes
    ) {
      const markerIndex = this.#entries.findIndex(
        (candidate) => candidate.message === "[logs truncated]",
      );
      const removeIndex = markerIndex >= 0 ? markerIndex + 1 : 0;
      const removed = this.#entries.splice(removeIndex, 1)[0];
      if (removed === undefined || removed.message === "[logs truncated]") {
        break;
      }
      this.#bytes -= Buffer.byteLength(removed.message, "utf8");
    }
  }

  values(): readonly SandboxLogEntry[] {
    return this.#entries.map((entry) => ({ ...entry }));
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) {
    return value;
  }
  return `${bytes.subarray(0, Math.max(0, maxBytes - 3)).toString("utf8")}...`;
}

function formatDump(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const SDK_ERROR_CODE_SET: ReadonlySet<string> = new Set(SDK_ERROR_CODES);

function isSdkErrorCode(value: unknown): value is SdkErrorCode {
  return typeof value === "string" && SDK_ERROR_CODE_SET.has(value);
}
