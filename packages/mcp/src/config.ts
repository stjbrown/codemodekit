export interface McpStdioTransportConfig {
  readonly type: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  /** Replaces, rather than merges with, the child environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly stderr?: "inherit" | "pipe" | "ignore";
  readonly maxBufferSize?: number;
}

export interface McpStreamableHttpTransportConfig {
  readonly type: "streamable-http";
  readonly url: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  /** Restricts configured headers to the configured origin when set. */
  readonly headerPolicy?: "all" | "same-origin";
}

export interface McpSseTransportConfig {
  readonly type: "sse";
  readonly url: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  /** Restricts configured headers to the configured origin when set. */
  readonly headerPolicy?: "all" | "same-origin";
}

export type McpTransportConfig =
  | McpStdioTransportConfig
  | McpStreamableHttpTransportConfig
  | McpSseTransportConfig;

export interface McpSourceConfig {
  /** Exact top-level `tools` namespace exposed to authored code. */
  readonly name: string;
  readonly transport: McpTransportConfig;
  readonly clientInfo?: {
    readonly name?: string;
    readonly version?: string;
  };
  readonly connectTimeoutMs?: number;
  readonly discoveryTimeoutMs?: number;
  /** Debounce for advertised tools/list_changed refreshes. Defaults to 300ms. */
  readonly toolListChangedDebounceMs?: number;
}
