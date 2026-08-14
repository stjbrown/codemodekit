import { McpToolProvider } from "@codemodekit/mcp";
import type {
  McpSourceConfig,
  McpSseTransportConfig,
  McpStdioTransportConfig,
  McpStreamableHttpTransportConfig,
} from "@codemodekit/mcp";

export type McpStdioSourceOptions = Omit<McpSourceConfig, "transport"> &
  Omit<McpStdioTransportConfig, "type">;

export type McpHttpSourceOptions = Omit<McpSourceConfig, "transport"> &
  Omit<McpStreamableHttpTransportConfig, "type">;

export type McpSseSourceOptions = Omit<McpSourceConfig, "transport"> &
  Omit<McpSseTransportConfig, "type">;

function stdio(options: McpStdioSourceOptions): McpToolProvider {
  const {
    name,
    clientInfo,
    connectTimeoutMs,
    discoveryTimeoutMs,
    toolListChangedDebounceMs,
    command,
    args,
    env,
    cwd,
    stderr,
    maxBufferSize,
  } = options;

  return new McpToolProvider({
    name,
    transport: {
      type: "stdio",
      command,
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
      ...(cwd === undefined ? {} : { cwd }),
      stderr: stderr ?? "inherit",
      maxBufferSize: maxBufferSize ?? 32 * 1024 * 1024,
    },
    ...(clientInfo === undefined ? {} : { clientInfo }),
    connectTimeoutMs: connectTimeoutMs ?? 60_000,
    discoveryTimeoutMs: discoveryTimeoutMs ?? 60_000,
    ...(toolListChangedDebounceMs === undefined
      ? {}
      : { toolListChangedDebounceMs }),
  });
}

function http(options: McpHttpSourceOptions): McpToolProvider {
  const {
    name,
    clientInfo,
    connectTimeoutMs,
    discoveryTimeoutMs,
    toolListChangedDebounceMs,
    url,
    headers,
    headerPolicy,
  } = options;

  return new McpToolProvider({
    name,
    transport: {
      type: "streamable-http",
      url,
      ...(headers === undefined ? {} : { headers }),
      headerPolicy: headerPolicy ?? "same-origin",
    },
    ...(clientInfo === undefined ? {} : { clientInfo }),
    connectTimeoutMs: connectTimeoutMs ?? 60_000,
    discoveryTimeoutMs: discoveryTimeoutMs ?? 60_000,
    ...(toolListChangedDebounceMs === undefined
      ? {}
      : { toolListChangedDebounceMs }),
  });
}

function sse(options: McpSseSourceOptions): McpToolProvider {
  const {
    name,
    clientInfo,
    connectTimeoutMs,
    discoveryTimeoutMs,
    toolListChangedDebounceMs,
    url,
    headers,
    headerPolicy,
  } = options;

  return new McpToolProvider({
    name,
    transport: {
      type: "sse",
      url,
      ...(headers === undefined ? {} : { headers }),
      headerPolicy: headerPolicy ?? "same-origin",
    },
    ...(clientInfo === undefined ? {} : { clientInfo }),
    connectTimeoutMs: connectTimeoutMs ?? 60_000,
    discoveryTimeoutMs: discoveryTimeoutMs ?? 60_000,
    ...(toolListChangedDebounceMs === undefined
      ? {}
      : { toolListChangedDebounceMs }),
  });
}

/** Batteries-included constructors for upstream MCP tool sources. */
export const mcp = Object.freeze({
  stdio,
  http,
  streamableHttp: http,
  sse,
});
