import { ToolCatalog, type CatalogSourceSnapshot } from "./catalog.js";
import type {
  NormalizedTool,
  ReconnectOptions,
  StartupReport,
  ToolProvider,
} from "./contracts.js";

const DEFAULT_RECONNECT_OPTIONS: ReconnectOptions = {
  initialDelayMs: 250,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
};

interface SourceState {
  readonly provider: ToolProvider;
  status: "healthy" | "unavailable";
  tools: readonly NormalizedTool[];
  message: string | undefined;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  attemptPromise: Promise<void> | undefined;
}

export class CatalogManager {
  readonly #states: readonly SourceState[];
  readonly #reconnect: ReconnectOptions;
  readonly #lifetimeController = new AbortController();

  #catalog: ToolCatalog;
  #revision = 0;
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(
    providers: readonly ToolProvider[],
    reconnect: Partial<ReconnectOptions> | undefined,
  ) {
    this.#reconnect = resolveReconnectOptions(reconnect);
    this.#states = providers.map((provider) => ({
      provider,
      status: "unavailable",
      tools: [],
      message: "Source has not started",
      retryAttempt: 0,
      retryTimer: undefined,
      attemptPromise: undefined,
    }));
    this.#catalog = this.#createCatalog();
  }

  get catalog(): ToolCatalog {
    return this.#catalog;
  }

  async start(signal: AbortSignal): Promise<StartupReport> {
    if (this.#closed) {
      throw new Error("Code Mode is closed");
    }
    // Discovery is shared by every caller, so it runs under the manager's
    // lifetime signal only; a caller's signal ends that caller's wait without
    // aborting the attempts (failed sources keep reconnecting in background).
    this.#startPromise ??= Promise.allSettled(
      this.#states.map((state) =>
        this.#attempt(state, this.#lifetimeController.signal),
      ),
    ).then(() => undefined);
    await abortableWait(this.#startPromise, signal);
    return this.#catalog.startupReport;
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#lifetimeController.abort(new Error("Code Mode closed"));
    for (const state of this.#states) {
      if (state.retryTimer !== undefined) {
        clearTimeout(state.retryTimer);
        state.retryTimer = undefined;
      }
    }
    this.#closePromise ??= Promise.allSettled(
      this.#states.map((state) => state.provider.close()),
    ).then(() => undefined);
    return this.#closePromise;
  }

  async #attempt(state: SourceState, signal: AbortSignal): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (state.attemptPromise !== undefined) {
      return state.attemptPromise;
    }

    state.attemptPromise = (async () => {
      try {
        const tools = await state.provider.start({
          signal,
          onUnavailable: () => this.#markUnavailable(state),
          onToolsChanged: (changed) => this.#replaceTools(state, changed),
        });
        if (this.#closed) {
          return;
        }
        state.status = "healthy";
        state.tools = tools;
        state.message = undefined;
        state.retryAttempt = 0;
        this.#publish();
      } catch {
        if (this.#closed) {
          return;
        }
        state.status = "unavailable";
        state.tools = [];
        state.message = "Source discovery failed";
        this.#publish();
        this.#scheduleReconnect(state);
      } finally {
        state.attemptPromise = undefined;
      }
    })();
    return state.attemptPromise;
  }

  #markUnavailable(state: SourceState): void {
    if (this.#closed || state.status === "unavailable") {
      return;
    }
    state.status = "unavailable";
    state.tools = [];
    state.message = "Source connection was lost";
    state.retryAttempt = 0;
    this.#publish();
    this.#scheduleReconnect(state);
  }

  #replaceTools(state: SourceState, tools: readonly NormalizedTool[]): void {
    if (this.#closed || state.status !== "healthy") {
      return;
    }
    state.tools = tools;
    this.#publish();
  }

  #scheduleReconnect(state: SourceState): void {
    if (
      this.#closed ||
      state.retryTimer !== undefined
    ) {
      return;
    }
    const delayMs = reconnectDelay(this.#reconnect, state.retryAttempt);
    state.retryAttempt += 1;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      void this.#attempt(state, this.#lifetimeController.signal);
    }, delayMs);
  }

  #publish(): void {
    this.#revision += 1;
    this.#catalog = this.#createCatalog();
  }

  #createCatalog(): ToolCatalog {
    const snapshots: CatalogSourceSnapshot[] = this.#states.map((state) => ({
      provider: state.provider,
      status: state.status,
      tools: state.tools,
      ...(state.message === undefined ? {} : { message: state.message }),
    }));
    return ToolCatalog.create(`catalog-${this.#revision}`, snapshots);
  }
}

function resolveReconnectOptions(
  configured: Partial<ReconnectOptions> | undefined,
): ReconnectOptions {
  const resolved = { ...DEFAULT_RECONNECT_OPTIONS, ...configured };
  positiveInteger(resolved.initialDelayMs, "reconnect.initialDelayMs");
  positiveInteger(resolved.maxDelayMs, "reconnect.maxDelayMs");
  if (resolved.maxDelayMs < resolved.initialDelayMs) {
    throw new TypeError(
      "reconnect.maxDelayMs must be greater than or equal to initialDelayMs",
    );
  }
  if (!Number.isFinite(resolved.multiplier) || resolved.multiplier < 1) {
    throw new TypeError("reconnect.multiplier must be a finite number at least 1");
  }
  if (
    !Number.isFinite(resolved.jitterRatio) ||
    resolved.jitterRatio < 0 ||
    resolved.jitterRatio > 1
  ) {
    throw new TypeError("reconnect.jitterRatio must be between 0 and 1");
  }
  return resolved;
}

function reconnectDelay(options: ReconnectOptions, attempt: number): number {
  const exponential = Math.min(
    options.maxDelayMs,
    options.initialDelayMs * options.multiplier ** attempt,
  );
  const jitter = exponential * options.jitterRatio;
  return Math.max(1, Math.round(exponential - jitter + Math.random() * jitter * 2));
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

async function abortableWait(
  promise: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = (): void => reject(abortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject);
    });
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Catalog start wait was aborted");
}
