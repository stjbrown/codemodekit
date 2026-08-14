import { createServer as createNodeServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import type { StartupReport } from "@codemodekit/core";
import {
  createMcpHandler,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import {
  createCodeModeMcp,
  type CodeModeMcpOptions,
} from "./server.js";

export interface ServeCodeModeHttpOptions extends CodeModeMcpOptions {
  /** Interface to bind. Defaults to 127.0.0.1. */
  readonly host?: string;
  /** Port to bind. Defaults to 3000; use 0 to select an available port. */
  readonly port?: number;
  /** MCP endpoint path. Defaults to /mcp. */
  readonly path?: string;
  readonly onError?: (error: Error) => void;
  /** Install SIGINT and SIGTERM shutdown handlers. Defaults to true. */
  readonly handleProcessSignals?: boolean;
  /**
   * Required when binding beyond loopback. This only acknowledges exposure;
   * authentication and authorization remain the application's responsibility.
   */
  readonly allowUnauthenticatedRemoteAccess?: boolean;
  /**
   * Validate Host and Origin headers to block DNS-rebinding and cross-site
   * requests from local web pages. Defaults to true for loopback binds and
   * false otherwise, where the expected public host names are unknowable here.
   */
  readonly dnsRebindingProtection?: boolean;
  /**
   * Additional accepted Host header values, compared case-insensitively with
   * or without a port. Loopback hosts and the bound host are always accepted.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Additional accepted Origin header values, compared case-insensitively as
   * full origins. Loopback origins and same-host origins are always accepted;
   * requests without an Origin header (non-browser clients) are not blocked.
   */
  readonly allowedOrigins?: readonly string[];
}

export interface ServedCodeModeHttp {
  readonly startup: StartupReport;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly url: string;
  close(): Promise<void>;
}

/** Starts a batteries-included Code Mode MCP endpoint over Streamable HTTP. */
export async function serveCodeModeHttp(
  options: ServeCodeModeHttpOptions,
): Promise<ServedCodeModeHttp> {
  const host = required(options.host ?? "127.0.0.1", "HTTP host");
  const port = validPort(options.port ?? 3_000);
  const route = validPath(options.path ?? "/mcp");
  if (!isLoopback(host) && options.allowUnauthenticatedRemoteAccess !== true) {
    throw new TypeError(
      "Non-loopback HTTP binding requires allowUnauthenticatedRemoteAccess: true and an intentional authentication design",
    );
  }

  const guard = createRequestGuard({
    host,
    enabled: options.dnsRebindingProtection ?? isLoopback(host),
    allowedHosts: options.allowedHosts ?? [],
    allowedOrigins: options.allowedOrigins ?? [],
  });
  const onError = options.onError ?? defaultErrorReporter;
  const application = createCodeModeMcp(options);
  let handler: McpHttpHandler | undefined;
  let nodeServer: Server | undefined;

  try {
    const startup = await application.start();
    handler = createMcpHandler(() => application.createServer(), {
      onerror: onError,
    });

    nodeServer = createNodeServer((request, response) => {
      void serveRequest(request, response, handler as McpHttpHandler, route, host, guard)
        .catch((error: unknown) => {
          onError(toError(error));
          if (!response.headersSent) {
            response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            response.end("Internal server error");
          } else {
            response.destroy(toError(error));
          }
        });
    });
    nodeServer.on("clientError", (error, socket) => {
      onError(error);
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    await listen(nodeServer, port, host);
    const boundPort = addressPort(nodeServer);
    const url = `http://${urlHost(host)}:${String(boundPort)}${route}`;
    let closing: Promise<void> | undefined;

    const beginShutdown = (): void => {
      void close();
    };
    const installHandlers = options.handleProcessSignals !== false;
    const removeHandlers = (): void => {
      if (!installHandlers) return;
      process.removeListener("SIGINT", beginShutdown);
      process.removeListener("SIGTERM", beginShutdown);
    };
    const close = (): Promise<void> => {
      closing ??= (async () => {
        removeHandlers();
        const results = await Promise.allSettled([
          closeNodeServer(nodeServer as Server),
          (handler as McpHttpHandler).close(),
          application.close(),
        ]);
        for (const result of results) {
          if (result.status === "rejected") onError(toError(result.reason));
        }
      })();
      return closing;
    };

    if (installHandlers) {
      process.once("SIGINT", beginShutdown);
      process.once("SIGTERM", beginShutdown);
    }

    return { startup, host, port: boundPort, path: route, url, close };
  } catch (error) {
    await Promise.allSettled([
      ...(nodeServer === undefined ? [] : [closeNodeServer(nodeServer)]),
      ...(handler === undefined ? [] : [handler.close()]),
      application.close(),
    ]);
    throw error;
  }
}

async function serveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: McpHttpHandler,
  route: string,
  host: string,
  guard: RequestGuard,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${urlHost(host)}`);
  if (requestUrl.pathname !== route) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const rejection = rejectDisallowedRequest(request, guard);
  if (rejection !== undefined) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end(rejection);
    return;
  }

  const webRequest = toWebRequest(request, response, requestUrl);
  const webResponse = await handler.fetch(webRequest);
  response.statusCode = webResponse.status;
  response.statusMessage = webResponse.statusText;
  webResponse.headers.forEach((value, name) => {
    if (name !== "set-cookie") response.setHeader(name, value);
  });
  const setCookie = webResponse.headers.getSetCookie();
  if (setCookie.length > 0) response.setHeader("set-cookie", setCookie);

  if (webResponse.body === null) {
    response.end();
    return;
  }
  const body = Readable.fromWeb(webResponse.body);
  body.once("error", (error) => response.destroy(error));
  body.pipe(response);
}

function toWebRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Request {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  const method = request.method ?? "GET";
  const abortController = new AbortController();
  // "close" fires on abrupt client disconnects after the request body has been
  // consumed, which the request "aborted" event does not cover.
  response.once("close", () => {
    if (!response.writableEnded) abortController.abort();
  });
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    signal: abortController.signal,
    ...(hasBody
      ? { body: Readable.toWeb(request) as ReadableStream<Uint8Array>, duplex: "half" }
      : {}),
  };
  return new Request(url, init);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeNodeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function addressPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address");
  }
  return address.port;
}

function validPort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new TypeError("HTTP port must be an integer from 0 to 65535");
  }
  return value;
}

function validPath(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new TypeError("HTTP path must start with / and must not include a query or fragment");
  }
  return value;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

interface RequestGuard {
  readonly enabled: boolean;
  readonly allowedHostnames: ReadonlySet<string>;
  readonly allowedHosts: ReadonlySet<string>;
  readonly allowedOrigins: ReadonlySet<string>;
}

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;

function createRequestGuard(options: {
  readonly host: string;
  readonly enabled: boolean;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
}): RequestGuard {
  const allowedHostnames = new Set<string>([urlHost(options.host).toLowerCase()]);
  if (isLoopback(options.host)) {
    for (const hostname of LOOPBACK_HOSTNAMES) allowedHostnames.add(hostname);
  }
  return {
    enabled: options.enabled,
    allowedHostnames,
    allowedHosts: new Set(options.allowedHosts.map((value) => value.toLowerCase())),
    allowedOrigins: new Set(options.allowedOrigins.map((value) => value.toLowerCase())),
  };
}

/**
 * Blocks DNS-rebinding and cross-site requests: browsers reach a rebound
 * server with the attacker's Host, and cross-site requests carry the page's
 * Origin. Non-browser clients that send neither header remain unaffected.
 */
function rejectDisallowedRequest(
  request: IncomingMessage,
  guard: RequestGuard,
): string | undefined {
  if (!guard.enabled) return undefined;

  const hostHeader = request.headers.host?.toLowerCase();
  if (hostHeader !== undefined && !guard.allowedHosts.has(hostHeader)) {
    const hostname = parseHostname(`http://${hostHeader}`);
    if (hostname === undefined || !guard.allowedHostnames.has(hostname)) {
      return "Forbidden: Host header is not an allowed host for this server";
    }
  }

  const originHeader = request.headers.origin?.toLowerCase();
  if (originHeader !== undefined && !guard.allowedOrigins.has(originHeader)) {
    const hostname = parseHostname(originHeader);
    if (hostname === undefined || !guard.allowedHostnames.has(hostname)) {
      return "Forbidden: Origin header is not an allowed origin for this server";
    }
  }

  return undefined;
}

function parseHostname(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const hostname = url.hostname.toLowerCase();
  // URL.hostname renders IPv6 without brackets in some runtimes; normalize.
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function required(value: string, label: string): string {
  if (value.trim() === "") throw new TypeError(`${label} must not be empty`);
  return value;
}

function defaultErrorReporter(error: Error): void {
  process.stderr.write(`[code-mode] ${error.message}\n`);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
