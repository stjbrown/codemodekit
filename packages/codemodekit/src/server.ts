import {
  CodeMode,
  TypeScriptCompiler,
  type ExecutionLimits,
  type ReconnectOptions,
  type StartupReport,
  type ToolPolicy,
  type ToolProvider,
} from "@codemodekit/core";
import { registerCodeModeTools } from "@codemodekit/mcp";
import { QuickJsSandbox } from "@codemodekit/sandbox-quickjs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

export interface CodeModeMcpOptions {
  readonly name: string;
  readonly version: string;
  readonly toolPolicy: ToolPolicy;
  readonly sources: readonly ToolProvider[];
  readonly limits?: Partial<ExecutionLimits>;
  readonly reconnect?: Partial<ReconnectOptions>;
  /** Register bounded catalog search alongside run_typescript. Defaults to true. */
  readonly search?: boolean;
}

export interface CodeModeMcpApplication {
  readonly codeMode: CodeMode;
  start(signal?: AbortSignal): Promise<StartupReport>;
  createServer(): McpServer;
  close(): Promise<void>;
}

export interface ServeCodeModeStdioOptions extends CodeModeMcpOptions {
  /** Reports host and transport errors to stderr by default. */
  readonly onError?: (error: Error) => void;
  /** Install SIGINT, SIGTERM, and stdin-end shutdown handlers. Defaults to true. */
  readonly handleProcessSignals?: boolean;
}

export interface ServedCodeModeStdio {
  readonly codeMode: CodeMode;
  readonly startup: StartupReport;
  close(): Promise<void>;
}

/**
 * Creates the standard TypeScript + QuickJS Code Mode MCP application without
 * selecting a downstream transport. Expert consumers can still compose the
 * lower-level packages directly.
 */
export function createCodeModeMcp(
  options: CodeModeMcpOptions,
): CodeModeMcpApplication {
  const codeMode = new CodeMode({
    compiler: new TypeScriptCompiler(),
    sandbox: new QuickJsSandbox(),
    toolPolicy: options.toolPolicy,
    providers: options.sources,
    limits: {
      wallTimeMs: 120_000,
      toolCallTimeMs: 60_000,
      ...options.limits,
    },
    ...(options.reconnect === undefined
      ? {}
      : { reconnect: options.reconnect }),
  });

  return {
    codeMode,
    start: (signal) => codeMode.start(signal),
    createServer: () => {
      const server = new McpServer({
        name: required(options.name, "Server name"),
        version: required(options.version, "Server version"),
      });
      registerCodeModeTools(server, {
        codeMode,
        ...(options.search === undefined ? {} : { search: options.search }),
      });
      return server;
    },
    close: () => codeMode.close(),
  };
}

/**
 * Starts a complete Code Mode MCP server over process stdio. The returned
 * handle is useful for tests and embedded lifecycle control; normal CLI
 * entrypoints can simply await this function and let stdio keep Node alive.
 */
export async function serveCodeModeStdio(
  options: ServeCodeModeStdioOptions,
): Promise<ServedCodeModeStdio> {
  const application = createCodeModeMcp(options);
  const onError = options.onError ?? defaultErrorReporter;

  try {
    const startup = await application.start();
    const transport = serveStdio(() => application.createServer(), {
      onerror: onError,
    });
    let closing: Promise<void> | undefined;

    const close = (): Promise<void> => {
      closing ??= (async () => {
        removeHandlers();
        const results = await Promise.allSettled([
          transport.close(),
          application.close(),
        ]);
        for (const result of results) {
          if (result.status === "rejected") {
            onError(toError(result.reason));
          }
        }
      })();
      return closing;
    };

    const beginShutdown = (): void => {
      void close();
    };
    const installHandlers = options.handleProcessSignals !== false;
    const removeHandlers = (): void => {
      if (!installHandlers) return;
      process.removeListener("SIGINT", beginShutdown);
      process.removeListener("SIGTERM", beginShutdown);
      process.stdin.removeListener("end", beginShutdown);
    };

    if (installHandlers) {
      process.once("SIGINT", beginShutdown);
      process.once("SIGTERM", beginShutdown);
      process.stdin.once("end", beginShutdown);
    }

    return { codeMode: application.codeMode, startup, close };
  } catch (error) {
    await application.close().catch((closeError: unknown) => {
      onError(toError(closeError));
    });
    throw error;
  }
}

function defaultErrorReporter(error: Error): void {
  process.stderr.write(`[code-mode] ${error.message}\n`);
}

function required(value: string, label: string): string {
  if (value.trim() === "") {
    throw new TypeError(`${label} must not be empty`);
  }
  return value;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
