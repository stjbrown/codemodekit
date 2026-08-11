import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { McpTransportConfig } from "./config.js";

/** @internal Exported from this module only for conformance testing. */
export function createMcpTransport(config: McpTransportConfig): Transport {
  switch (config.type) {
    case "stdio":
      return new StdioClientTransport({
        command: requiredString(config.command, "stdio command"),
        ...(config.args === undefined ? {} : { args: [...config.args] }),
        ...(config.env === undefined ? {} : { env: { ...config.env } }),
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.stderr === undefined ? {} : { stderr: config.stderr }),
        ...(config.maxBufferSize === undefined
          ? {}
          : { maxBufferSize: positiveInteger(config.maxBufferSize, "maxBufferSize") }),
      });

    case "streamable-http": {
      const url = toHttpUrl(config.url);
      const headers = config.headers === undefined ? undefined : { ...config.headers };
      return new StreamableHTTPClientTransport(url, {
        ...(headers === undefined ? {} : { requestInit: { headers } }),
        ...(headers === undefined
          ? {}
          : { fetch: fetchWithDefaultHeaders(url, headers, config.headerPolicy) }),
      });
    }

    case "sse": {
      const url = toHttpUrl(config.url);
      const headers = config.headers === undefined ? undefined : { ...config.headers };
      return new SSEClientTransport(url, {
        ...(headers === undefined ? {} : { requestInit: { headers } }),
        ...(headers === undefined
          ? {}
          : { fetch: fetchWithDefaultHeaders(url, headers, config.headerPolicy) }),
      });
    }
  }
}

function toHttpUrl(value: string | URL): URL {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("MCP HTTP transport URL must use http: or https:");
  }
  return url;
}

function requiredString(value: string, label: string): string {
  if (value.trim() === "") {
    throw new TypeError(`${label} must not be empty`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function fetchWithDefaultHeaders(
  configuredUrl: URL,
  defaults: Readonly<Record<string, string>>,
  policy: "all" | "same-origin" | undefined,
): typeof fetch {
  return async (input, init) => {
    const requestUrl = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
      configuredUrl,
    );
    const sameOrigin = requestUrl.origin === configuredUrl.origin;
    const headers = new Headers(
      policy === "same-origin" && !sameOrigin ? undefined : defaults,
    );
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    if (policy === "same-origin" && !sameOrigin) {
      for (const name of Object.keys(defaults)) {
        headers.delete(name);
      }
    }
    return fetch(input, {
      ...init,
      ...(policy === "same-origin" ? { redirect: "error" } : {}),
      headers,
    });
  };
}
