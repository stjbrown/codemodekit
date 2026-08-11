import {
  ProviderToolError,
  type JsonSchema,
  type JsonValue,
  type NormalizedTool,
  type ProviderCallContext,
  type ProviderStartContext,
  type ProviderToolResult,
  type ToolContentBlock,
  type ToolProvider,
} from "@codemodekit/core";
import { Client, type CallToolResult, type Tool } from "@modelcontextprotocol/client";

import type { McpSourceConfig } from "./config.js";
import { createMcpTransport } from "./transport.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;

export class McpToolProvider implements ToolProvider {
  readonly sourceName: string;

  readonly #config: McpSourceConfig;
  #client: Client | undefined;
  #connectingClient: Client | undefined;
  #closePromise: Promise<void> | undefined;
  #startPromise: Promise<readonly NormalizedTool[]> | undefined;
  #tools = new Map<string, Tool>();
  #onUnavailable: (() => void) | undefined;
  #onToolsChanged: ((tools: readonly NormalizedTool[]) => void) | undefined;
  #closed = false;

  constructor(config: McpSourceConfig) {
    if (config.name.trim() === "") {
      throw new TypeError("MCP source name must not be empty");
    }
    validateTimeout(config.connectTimeoutMs, "connectTimeoutMs");
    validateTimeout(config.discoveryTimeoutMs, "discoveryTimeoutMs");
    validateDebounce(config.toolListChangedDebounceMs);
    this.sourceName = config.name;
    this.#config = config;
  }

  start(context: ProviderStartContext): Promise<readonly NormalizedTool[]> {
    if (this.#closed) {
      return Promise.reject(new Error(`MCP source ${this.sourceName} is closed`));
    }
    this.#onUnavailable = context.onUnavailable;
    this.#onToolsChanged = context.onToolsChanged;
    this.#startPromise ??= this.#connectAndDiscover(context).catch((error: unknown) => {
      this.#startPromise = undefined;
      throw error;
    });
    return this.#startPromise;
  }

  async call(context: ProviderCallContext): Promise<ProviderToolResult> {
    const client = this.#client;
    if (client === undefined) {
      throw new Error(`MCP source ${this.sourceName} is not connected`);
    }
    const toolDefinition = this.#tools.get(context.tool);
    if (toolDefinition === undefined) {
      throw new Error(`MCP tool ${this.sourceName}.${context.tool} is unavailable`);
    }

    const result = await client.callTool(
      {
        name: context.tool,
        arguments: { ...context.input },
      },
      {
        signal: context.signal,
        toolDefinition,
      },
    );

    if (result.isError === true) {
      throw new ProviderToolError(toolErrorMessage(result));
    }

    return normalizeResult(result);
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closePromise ??= this.#closeOwnedClients();
    return this.#closePromise;
  }

  async #closeOwnedClients(): Promise<void> {
    const client = this.#client;
    const connectingClient = this.#connectingClient;
    this.#client = undefined;
    this.#connectingClient = undefined;
    this.#onUnavailable = undefined;
    this.#onToolsChanged = undefined;
    this.#tools.clear();
    await Promise.all(
      [...new Set([client, connectingClient])]
        .filter((candidate): candidate is Client => candidate !== undefined)
        .map((candidate) => candidate.close()),
    );
  }

  async #connectAndDiscover(
    context: ProviderStartContext,
  ): Promise<readonly NormalizedTool[]> {
    let client: Client;
    client = new Client(
      {
        name: this.#config.clientInfo?.name ?? "codemodekit",
        version: this.#config.clientInfo?.version ?? "0.1.0",
      },
      {
        versionNegotiation: {
          mode: "auto",
          probe: {
            timeoutMs:
              this.#config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
            maxRetries: 0,
          },
        },
        inputRequired: { autoFulfill: false },
        listChanged: {
          tools: {
            autoRefresh: true,
            debounceMs: this.#config.toolListChangedDebounceMs ?? 300,
            onChanged: (error, tools) =>
              this.#handleToolListChanged(client, error, tools),
          },
        },
      },
    );
    client.onclose = () => this.#handleClientClose(client);
    this.#connectingClient = client;

    try {
      await client.connect(createMcpTransport(this.#config.transport), {
        signal: context.signal,
        timeout: this.#config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      });
      const listed = await client.listTools(undefined, {
        signal: context.signal,
        timeout:
          this.#config.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
        cacheMode: "refresh",
      });
      if (this.#closed) {
        throw new Error(`MCP source ${this.sourceName} was closed during startup`);
      }

      const activeTools = listed.tools.filter(isModelVisible);
      this.#tools = new Map(activeTools.map((tool) => [tool.name, tool]));
      this.#client = client;
      return activeTools.map(normalizeTool);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      if (this.#connectingClient === client) {
        this.#connectingClient = undefined;
      }
    }
  }

  #handleClientClose(client: Client): void {
    if (this.#closed || this.#client !== client) {
      return;
    }
    this.#client = undefined;
    this.#tools.clear();
    this.#startPromise = undefined;
    const onUnavailable = this.#onUnavailable;
    this.#onUnavailable = undefined;
    this.#onToolsChanged = undefined;
    onUnavailable?.();
  }

  #handleToolListChanged(
    client: Client,
    error: Error | null,
    tools: Tool[] | null,
  ): void {
    if (
      this.#closed ||
      this.#client !== client ||
      error !== null ||
      tools === null
    ) {
      return;
    }
    const activeTools = tools.filter(isModelVisible);
    this.#tools = new Map(activeTools.map((tool) => [tool.name, tool]));
    this.#onToolsChanged?.(activeTools.map(normalizeTool));
  }
}

function normalizeTool(tool: Tool): NormalizedTool {
  const description = tool.description;
  const outputSchema = tool.outputSchema;
  const annotations = tool.annotations;
  return {
    name: tool.name,
    ...(description === undefined ? {} : { description }),
    inputSchema: cloneJson(tool.inputSchema) as JsonSchema,
    ...(outputSchema === undefined
      ? {}
      : { outputSchema: cloneJson(outputSchema) as JsonSchema }),
    ...(annotations === undefined
      ? {}
      : { annotations: cloneJson(annotations) as Readonly<Record<string, JsonValue>> }),
    sideband: { mcp: { definition: tool } },
  };
}

function normalizeResult(result: CallToolResult): ProviderToolResult {
  const content = cloneJson(result.content) as readonly ToolContentBlock[];
  const structuredContent = result.structuredContent;
  return {
    content,
    ...(structuredContent === undefined
      ? {}
      : { structuredContent: cloneJson(structuredContent) }),
    sideband: { mcp: { result } },
  };
}

function isModelVisible(tool: Tool): boolean {
  const meta = tool._meta;
  if (!isRecord(meta)) {
    return true;
  }
  const ui = meta.ui;
  if (!isRecord(ui) || !Array.isArray(ui.visibility)) {
    return true;
  }
  return ui.visibility.includes("model");
}

function toolErrorMessage(result: CallToolResult): string {
  const messages: string[] = [];
  for (const block of result.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      messages.push(block.text);
    }
  }
  const detail = messages.join("\n").trim();
  return detail === ""
    ? "Upstream MCP tool reported an execution error"
    : `Upstream MCP tool reported an error: ${detail.slice(0, 900)}`;
}

function cloneJson(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("MCP value is not JSON serializable");
  }
  return JSON.parse(serialized) as JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateTimeout(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function validateDebounce(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("toolListChangedDebounceMs must be a non-negative safe integer");
  }
}
