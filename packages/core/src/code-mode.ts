import { randomUUID } from "node:crypto";

import { ExecutionToolBridge } from "./bridge.js";
import { CatalogManager } from "./catalog-manager.js";
import type { ToolCatalog } from "./catalog.js";
import type {
  CatalogDiagnosticsRequest,
  CatalogDiagnosticsResult,
  CodeCompiler,
  CodeModeObservation,
  CodeModeObserver,
  CodeModeRunRequest,
  CodeModeRunResult,
  CodeModeProgress,
  CodeSandbox,
  ExecutionLimits,
  ReconnectOptions,
  SearchToolsRequest,
  SearchToolsResult,
  SandboxLogEntry,
  StartupReport,
  ToolPolicy,
  ToolProvider,
  TypeScriptCatalog,
} from "./contracts.js";
import { CodeModeError } from "./errors.js";
import { resolveExecutionLimits } from "./limits.js";
import { stringifyJson, utf8Bytes } from "./json.js";

export interface CodeModeOptions {
  readonly compiler: CodeCompiler;
  readonly sandbox: CodeSandbox;
  readonly toolPolicy: ToolPolicy;
  readonly providers: readonly ToolProvider[];
  readonly limits?: Partial<ExecutionLimits>;
  readonly reconnect?: Partial<ReconnectOptions>;
  /** Receives safe lifecycle metadata without authored code or tool payloads. */
  readonly observer?: CodeModeObserver;
}

export class CodeMode {
  readonly #compiler: CodeCompiler;
  readonly #sandbox: CodeSandbox;
  readonly #policy: ToolPolicy;
  readonly #limits: ExecutionLimits;
  readonly #catalogManager: CatalogManager;
  readonly #observer: CodeModeObserver | undefined;

  constructor(options: CodeModeOptions) {
    if (typeof options.toolPolicy !== "function") {
      throw new TypeError("CodeMode requires an explicit toolPolicy");
    }

    const sourceNames = new Set<string>();
    for (const provider of options.providers) {
      if (provider.sourceName.length === 0) {
        throw new TypeError("Provider sourceName must not be empty");
      }
      if (sourceNames.has(provider.sourceName)) {
        throw new TypeError(`Duplicate provider sourceName: ${provider.sourceName}`);
      }
      sourceNames.add(provider.sourceName);
    }

    this.#compiler = options.compiler;
    this.#sandbox = options.sandbox;
    this.#policy = options.toolPolicy;
    this.#observer = options.observer;
    this.#limits = resolveExecutionLimits(options.limits);
    this.#catalogManager = new CatalogManager(
      [...options.providers],
      options.reconnect,
    );
  }

  async start(signal: AbortSignal = new AbortController().signal): Promise<StartupReport> {
    return this.#catalogManager.start(signal);
  }

  async run(request: CodeModeRunRequest): Promise<CodeModeRunResult> {
    const executionId = randomUUID();
    const logs: readonly SandboxLogEntry[] = [];
    const progress = createProgressEmitter(request.onProgress);
    const observation = createObservationEmitter(this.#observer);
    const executionStartedAt = performance.now();
    const sourceBytes = utf8Bytes(request.code);
    observation.emit({
      type: "execution_started",
      timestampMs: Date.now(),
      executionId,
      sourceBytes,
    });
    const complete = (result: CodeModeRunResult): CodeModeRunResult => {
      observation.emit({
        type: "execution_completed",
        timestampMs: Date.now(),
        executionId,
        ok: result.ok,
        durationMs: elapsedMs(executionStartedAt),
        logEntries: result.logs.length,
        ...(result.ok
          ? {}
          : {
              errorCode: result.diagnostic.code,
              phase: result.diagnostic.phase,
            }),
      });
      return result;
    };

    if (request.signal?.aborted === true) {
      return complete(cancelled(executionId));
    }

    if (sourceBytes > this.#limits.sourceBytes) {
      return complete({
        ok: false,
        executionId,
        diagnostic: {
          code: "CODE_SOURCE_TOO_LARGE",
          phase: "compile",
          message: `Source exceeds the ${this.#limits.sourceBytes}-byte limit`,
        },
        logs,
      });
    }

    progress.emit({
      phase: "compile_started",
      message: "Compiling TypeScript",
    });
    const compiled = this.#compiler.compile(request.code);
    if (!compiled.ok) {
      return complete({
        ok: false,
        executionId,
        diagnostic: compiled.diagnostic,
        logs,
      });
    }
    progress.emit({
      phase: "compile_completed",
      message: "TypeScript compiled",
    });

    const wallController = new AbortController();
    let wallTimedOut = false;
    const onCallerAbort = (): void => wallController.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const wallTimer = setTimeout(() => {
      wallTimedOut = true;
      wallController.abort(new Error("wall-time limit"));
    }, this.#limits.wallTimeMs);

    try {
      const catalog = await this.#getCatalog(wallController.signal);
      const bridge = new ExecutionToolBridge({
        catalog,
        executionId,
        limits: this.#limits,
        policy: this.#policy,
        signal: wallController.signal,
        onProgress: (event) => progress.emit(event),
        onObservation: (event) => observation.emit(event),
      });
      progress.emit({
        phase: "sandbox_started",
        message: "Sandbox execution started",
      });
      const sandboxResult = await this.#sandbox.execute({
        javascript: compiled.javascript,
        tools: catalog.toolSurface(),
        limits: this.#limits,
        signal: wallController.signal,
        callTool: (call) => bridge.call(call),
      });

      if (sandboxResult.value !== undefined) {
        const finalBytes = utf8Bytes(stringifyJson(sandboxResult.value));
        if (finalBytes > this.#limits.finalResultBytes) {
          throw new CodeModeError(
            {
              code: "FINAL_RESULT_TOO_LARGE",
              phase: "sandbox",
              message: `Final result exceeds the ${this.#limits.finalResultBytes}-byte limit`,
            },
            { logs: sandboxResult.logs },
          );
        }
      }

      const result: CodeModeRunResult = {
        ok: true,
        executionId,
        ...(sandboxResult.value === undefined ? {} : { value: sandboxResult.value }),
        logs: sandboxResult.logs,
      };
      progress.emit({
        phase: "execution_completed",
        message: "Execution completed",
      });
      return complete(result);
    } catch (error) {
      if (!wallController.signal.aborted) {
        wallController.abort(error);
      }
      if (wallTimedOut) {
        return complete({
          ok: false,
          executionId,
          diagnostic: {
            code: "EXECUTION_WALL_LIMIT",
            phase: "sandbox",
            message: `Execution exceeded ${this.#limits.wallTimeMs}ms wall time`,
          },
          logs: error instanceof CodeModeError ? error.logs : logs,
        });
      }
      if (isAborted(request.signal)) {
        return complete(
          cancelled(
            executionId,
            error instanceof CodeModeError ? error.logs : logs,
          ),
        );
      }
      if (error instanceof CodeModeError) {
        return complete({
          ok: false,
          executionId,
          diagnostic: error.diagnostic,
          logs: error.logs,
        });
      }
      return complete({
        ok: false,
        executionId,
        diagnostic: {
          code: "SANDBOX_RUNTIME_FAILED",
          phase: "host",
          message: "Code Mode execution failed",
        },
        logs,
      });
    } finally {
      clearTimeout(wallTimer);
      request.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  async getTypeScriptCatalog(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TypeScriptCatalog> {
    await this.#catalogManager.start(signal);
    return this.#catalogManager.catalog.typeScriptCatalog();
  }

  async searchTools(
    request: SearchToolsRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SearchToolsResult> {
    await this.#catalogManager.start(signal);
    return this.#catalogManager.catalog.search(request);
  }

  async getCatalogDiagnostics(
    request: CatalogDiagnosticsRequest = {},
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CatalogDiagnosticsResult> {
    await this.#catalogManager.start(signal);
    return this.#catalogManager.catalog.diagnostics(request);
  }

  async close(): Promise<void> {
    await this.#catalogManager.close();
  }

  async #getCatalog(signal: AbortSignal): Promise<ToolCatalog> {
    await this.#catalogManager.start(signal);
    return this.#catalogManager.catalog;
  }
}

function createObservationEmitter(
  observer: CodeModeObserver | undefined,
): { emit(event: CodeModeObservation): void } {
  return {
    emit(event): void {
      if (observer === undefined) return;
      const delivered = Object.freeze({ ...event }) as CodeModeObservation;
      queueMicrotask(() => {
        try {
          Promise.resolve(observer(delivered)).catch(() => undefined);
        } catch {
          // Observation is advisory and cannot affect execution.
        }
      });
    },
  };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function createProgressEmitter(
  listener: ((event: CodeModeProgress) => void) | undefined,
): {
  emit(event: Omit<CodeModeProgress, "sequence">): void;
} {
  let sequence = 0;
  return {
    emit(event): void {
      if (listener === undefined || sequence >= 100) {
        return;
      }
      sequence += 1;
      const delivered = {
        ...event,
        sequence,
        message: boundedProgressMessage(event.message),
      };
      queueMicrotask(() => {
        try {
          listener(delivered);
        } catch {
          // Progress is advisory and cannot affect execution.
        }
      });
    },
  };
}

function boundedProgressMessage(message: string): string {
  const encoded = new TextEncoder().encode(message);
  return encoded.byteLength <= 1_024
    ? message
    : new TextDecoder().decode(encoded.slice(0, 1_024));
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelled(
  executionId: string,
  logs: readonly SandboxLogEntry[] = [],
): CodeModeRunResult {
  return {
    ok: false,
    executionId,
    diagnostic: {
      code: "EXECUTION_CANCELLED",
      phase: "host",
      message: "Execution was cancelled",
    },
    logs,
  };
}
