import type {
  NormalizedTool,
  ProviderCallContext,
  ProviderToolResult,
  ToolProvider,
  ProviderStartContext,
} from "@codemodekit/core";
import { ProviderToolError } from "@codemodekit/core";

export interface InMemoryTool extends NormalizedTool {
  readonly execute: (
    context: ProviderCallContext,
  ) => ProviderToolResult | Promise<ProviderToolResult>;
}

export class InMemoryTestToolProvider implements ToolProvider {
  readonly sourceName: string;
  readonly calls: ProviderCallContext[] = [];

  #tools: ReadonlyMap<string, InMemoryTool>;
  readonly #startError: Error | undefined;
  #onToolsChanged: ((tools: readonly NormalizedTool[]) => void) | undefined;
  #closed = false;

  constructor(options: {
    readonly sourceName: string;
    readonly tools: readonly InMemoryTool[];
    readonly startError?: Error;
  }) {
    this.sourceName = options.sourceName;
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.#startError = options.startError;
  }

  async start(context?: ProviderStartContext): Promise<readonly NormalizedTool[]> {
    if (this.#startError !== undefined) {
      throw this.#startError;
    }
    this.#onToolsChanged = context?.onToolsChanged;
    return this.#definitions();
  }

  async call(context: ProviderCallContext): Promise<ProviderToolResult> {
    if (this.#closed) {
      throw new Error("Provider is closed");
    }
    const tool = this.#tools.get(context.tool);
    if (tool === undefined) {
      throw new Error(`Unknown fixture tool: ${context.tool}`);
    }
    this.calls.push(context);
    return tool.execute(context);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#onToolsChanged = undefined;
  }

  replaceTools(tools: readonly InMemoryTool[]): void {
    if (this.#closed) {
      throw new Error("Provider is closed");
    }
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.#onToolsChanged?.(this.#definitions());
  }

  #definitions(): readonly NormalizedTool[] {
    return [...this.#tools.values()].map(({ execute: _execute, ...tool }) => tool);
  }
}

export function echoTool(): InMemoryTool {
  return {
    name: "echo",
    description: "Echo a string",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    sideband: { ui: { resourceUri: "ui://fixture/echo" } },
    execute: ({ input }) => ({
      content: [{ type: "text", text: String(input.value) }],
      structuredContent: { value: input.value ?? null },
      sideband: { private: "host-only" },
    }),
  };
}

export function failingTool(): InMemoryTool {
  return {
    name: "fail",
    description: "Return a safe provider-declared failure",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => {
      throw new ProviderToolError(
        "The value was rejected; retry with a non-empty string.",
      );
    },
  };
}

export function waitTool(): InMemoryTool {
  return {
    name: "wait",
    description: "Wait until a delay elapses or the caller cancels",
    inputSchema: {
      type: "object",
      properties: { delayMs: { type: "integer", minimum: 1 } },
      required: ["delayMs"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { completed: { type: "boolean" } },
      required: ["completed"],
      additionalProperties: false,
    },
    execute: async ({ input, signal }) => {
      await delay(Number(input.delayMs), signal);
      return {
        content: [{ type: "text", text: "completed" }],
        structuredContent: { completed: true },
      };
    },
  };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}
