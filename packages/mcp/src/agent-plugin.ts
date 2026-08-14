import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import type { McpSourceConfig, McpTransportConfig } from "./config.js";
import { McpToolProvider } from "./mcp-tool-provider.js";

const PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const MAX_CONFIG_BYTES = 1_048_576;
const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export interface AgentPluginLoadOptions {
  /** Local root of an already-installed Agent Plugins 1.0.0 package. */
  readonly root: string;
  /** Client-managed persistent writable directory dedicated to this plugin. */
  readonly dataDir: string;
  /**
   * Client-selected base environment for plugin stdio processes. Defaults to
   * empty, but the SDK transport still supplies a minimal inherited base
   * (PATH, HOME, and similar); this is an overlay, not full isolation.
   */
  readonly baseEnv?: Readonly<Record<string, string>>;
  readonly clientInfo?: {
    readonly name?: string;
    readonly version?: string;
  };
  readonly connectTimeoutMs?: number;
  readonly discoveryTimeoutMs?: number;
  readonly toolListChangedDebounceMs?: number;
}

export interface AgentPluginManifest {
  readonly schema: typeof PLUGIN_SCHEMA;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: Readonly<{
    readonly name?: string;
    readonly email?: string;
    readonly url?: string;
  }>;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
  readonly extensions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export type AgentPluginDiagnosticCode =
  | "PLUGIN_MANIFEST_FIELD_IGNORED"
  | "PLUGIN_MANIFEST_INVALID"
  | "PLUGIN_MCP_CONFIG_INVALID"
  | "PLUGIN_MCP_SERVER_INVALID";

export interface AgentPluginDiagnostic {
  readonly code: AgentPluginDiagnosticCode;
  readonly message: string;
  readonly server?: string;
}

export interface LoadedAgentPlugin {
  readonly root: string;
  readonly dataDir: string;
  readonly manifest: AgentPluginManifest;
  readonly diagnostics: readonly AgentPluginDiagnostic[];
  readonly mcp: {
    readonly status: "absent" | "invalid" | "loaded";
    readonly providers: readonly McpToolProvider[];
  };
}

export class AgentPluginLoadError extends Error {
  readonly diagnostics: readonly AgentPluginDiagnostic[];

  constructor(message: string, diagnostics: readonly AgentPluginDiagnostic[]) {
    super(message);
    this.name = "AgentPluginLoadError";
    this.diagnostics = diagnostics;
  }
}

export async function loadAgentPlugin(
  options: AgentPluginLoadOptions,
): Promise<LoadedAgentPlugin> {
  const diagnostics: AgentPluginDiagnostic[] = [];
  const root = await resolveDirectory(options.root, "Agent Plugin root");
  let manifest: AgentPluginManifest;
  try {
    const manifestDocument = await readContainedJson(root, "plugin.json", true);
    manifest = validateManifest(manifestDocument, diagnostics);
  } catch (error) {
    const diagnostic: AgentPluginDiagnostic = {
      code: "PLUGIN_MANIFEST_INVALID",
      message: safeMessage(error, "Agent Plugin manifest is invalid"),
    };
    diagnostics.push(diagnostic);
    throw new AgentPluginLoadError(diagnostic.message, diagnostics);
  }

  const dataDir = await resolveWritableDataDirectory(options.dataDir);
  let mcpDocument: unknown;
  try {
    mcpDocument = await readContainedJson(root, "mcp.json", false);
  } catch (error) {
    diagnostics.push({
      code: "PLUGIN_MCP_CONFIG_INVALID",
      message: safeMessage(error, "Agent Plugin MCP configuration is invalid"),
    });
    return loadedPlugin(root, dataDir, manifest, "invalid", [], diagnostics);
  }

  if (mcpDocument === undefined) {
    return loadedPlugin(root, dataDir, manifest, "absent", [], diagnostics);
  }
  if (!isRecord(mcpDocument) || !hasOnlyKeys(mcpDocument, ["$schema", "mcpServers"])) {
    diagnostics.push({
      code: "PLUGIN_MCP_CONFIG_INVALID",
      message: "mcp.json must contain only $schema and mcpServers",
    });
    return loadedPlugin(root, dataDir, manifest, "invalid", [], diagnostics);
  }
  if (mcpDocument.$schema !== MCP_SCHEMA || manifest.schema !== PLUGIN_SCHEMA) {
    diagnostics.push({
      code: "PLUGIN_MCP_CONFIG_INVALID",
      message: "plugin.json and mcp.json must target Agent Plugins 1.0.0",
    });
    return loadedPlugin(root, dataDir, manifest, "invalid", [], diagnostics);
  }
  if (!isRecord(mcpDocument.mcpServers)) {
    diagnostics.push({
      code: "PLUGIN_MCP_CONFIG_INVALID",
      message: "mcp.json mcpServers must be an object",
    });
    return loadedPlugin(root, dataDir, manifest, "invalid", [], diagnostics);
  }

  const baseEnv = validateBaseEnvironment(options.baseEnv);
  const providers: McpToolProvider[] = [];
  for (const [name, document] of Object.entries(mcpDocument.mcpServers)) {
    try {
      if (name.length === 0) {
        throw new InvalidServerError("Server name must not be empty");
      }
      const transport = await mapServerTransport(document, {
        root,
        dataDir,
        baseEnv,
      });
      const config: McpSourceConfig = {
        name,
        transport,
        ...(options.clientInfo === undefined
          ? {}
          : { clientInfo: options.clientInfo }),
        ...(options.connectTimeoutMs === undefined
          ? {}
          : { connectTimeoutMs: options.connectTimeoutMs }),
        ...(options.discoveryTimeoutMs === undefined
          ? {}
          : { discoveryTimeoutMs: options.discoveryTimeoutMs }),
        ...(options.toolListChangedDebounceMs === undefined
          ? {}
          : { toolListChangedDebounceMs: options.toolListChangedDebounceMs }),
      };
      providers.push(new McpToolProvider(config));
    } catch (error) {
      diagnostics.push({
        code: "PLUGIN_MCP_SERVER_INVALID",
        message: safeMessage(error, "MCP server entry is invalid"),
        server: name,
      });
    }
  }

  return loadedPlugin(root, dataDir, manifest, "loaded", providers, diagnostics);
}

function loadedPlugin(
  root: string,
  dataDir: string,
  manifest: AgentPluginManifest,
  status: LoadedAgentPlugin["mcp"]["status"],
  providers: readonly McpToolProvider[],
  diagnostics: readonly AgentPluginDiagnostic[],
): LoadedAgentPlugin {
  return {
    root,
    dataDir,
    manifest,
    diagnostics,
    mcp: { status, providers },
  };
}

async function mapServerTransport(
  document: unknown,
  context: {
    readonly root: string;
    readonly dataDir: string;
    readonly baseEnv: Readonly<Record<string, string>>;
  },
): Promise<McpTransportConfig> {
  if (!isRecord(document) || typeof document.type !== "string") {
    throw new InvalidServerError("Server entry must be an object with a type");
  }

  switch (document.type) {
    case "stdio":
      return mapStdioServer(document, context);
    case "streamable-http":
    case "sse":
      return mapHttpServer(document, document.type);
    default:
      throw new InvalidServerError(`Unsupported server transport: ${document.type}`);
  }
}

async function mapStdioServer(
  document: Record<string, unknown>,
  context: {
    readonly root: string;
    readonly dataDir: string;
    readonly baseEnv: Readonly<Record<string, string>>;
  },
): Promise<McpTransportConfig> {
  if (!hasOnlyKeys(document, ["type", "command", "args", "env", "cwd"])) {
    throw new InvalidServerError("stdio server contains an unknown field");
  }
  if (typeof document.command !== "string" || document.command.length === 0) {
    throw new InvalidServerError("stdio command must be a non-empty string");
  }
  const args = optionalStringArray(document.args, "stdio args");
  const configuredEnv = optionalStringRecord(document.env, "stdio env");
  const cwdValue = document.cwd;
  if (cwdValue !== undefined && typeof cwdValue !== "string") {
    throw new InvalidServerError("stdio cwd must be a string");
  }
  for (const key of Object.keys(configuredEnv ?? {})) {
    if (environmentKeyEquals(key, "PLUGIN_ROOT") || environmentKeyEquals(key, "PLUGIN_DATA")) {
      throw new InvalidServerError("stdio env must not define PLUGIN_ROOT or PLUGIN_DATA");
    }
  }

  const command = await resolveCommand(context.root, document.command);
  const cwd = await resolveCwd(context.root, context.dataDir, cwdValue);
  const env = overlayEnvironment(
    context.baseEnv,
    configuredEnv ?? {},
    context.root,
    context.dataDir,
  );
  return {
    type: "stdio",
    command,
    ...(args === undefined
      ? {}
      : { args: args.map((value) => expand(value, context.root, context.dataDir)) }),
    env,
    cwd,
  };
}

function mapHttpServer(
  document: Record<string, unknown>,
  type: "streamable-http" | "sse",
): McpTransportConfig {
  if (!hasOnlyKeys(document, ["type", "url", "headers"])) {
    throw new InvalidServerError(`${type} server contains an unknown field`);
  }
  if (typeof document.url !== "string") {
    throw new InvalidServerError(`${type} url must be a string`);
  }
  const url = validateRemoteUrl(document.url);
  const headers = optionalStringRecord(document.headers, `${type} headers`);
  if (headers !== undefined) {
    validateHeaders(headers);
  }
  return {
    type,
    url,
    ...(headers === undefined ? {} : { headers }),
    headerPolicy: "same-origin",
  };
}

async function resolveCommand(root: string, command: string): Promise<string> {
  if (command.startsWith("./")) {
    const candidate = path.resolve(root, command.slice(2));
    const resolved = await realpath(candidate).catch(() => {
      throw new InvalidServerError("Plugin-relative command does not resolve");
    });
    if (!isContained(root, resolved)) {
      throw new InvalidServerError("Plugin-relative command escapes the plugin root");
    }
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new InvalidServerError("Plugin-relative command must resolve to a file");
    }
    return resolved;
  }
  if (command.includes("/") || command.includes("\\")) {
    throw new InvalidServerError("stdio command must be bare or begin with ./");
  }
  return command;
}

async function resolveCwd(
  root: string,
  dataDir: string,
  configured: string | undefined,
): Promise<string> {
  if (configured === undefined) {
    return root;
  }
  let base: string;
  let candidate: string;
  if (configured.startsWith("./")) {
    base = root;
    candidate = path.resolve(root, configured.slice(2));
  } else if (
    configured === "${PLUGIN_ROOT}" ||
    configured.startsWith("${PLUGIN_ROOT}/")
  ) {
    base = root;
    candidate = path.resolve(expand(configured, root, dataDir));
  } else if (
    configured === "${PLUGIN_DATA}" ||
    configured.startsWith("${PLUGIN_DATA}/")
  ) {
    base = dataDir;
    candidate = path.resolve(expand(configured, root, dataDir));
  } else {
    throw new InvalidServerError("stdio cwd has an unsupported form");
  }
  const resolved = await realpath(candidate).catch(() => {
    throw new InvalidServerError("stdio cwd does not resolve");
  });
  if (!isContained(base, resolved)) {
    throw new InvalidServerError("stdio cwd escapes its permitted root");
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new InvalidServerError("stdio cwd must resolve to a directory");
  }
  return resolved;
}

function overlayEnvironment(
  base: Readonly<Record<string, string>>,
  configured: Readonly<Record<string, string>>,
  root: string,
  dataDir: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    setEnvironmentValue(result, key, value);
  }
  for (const [key, value] of Object.entries(configured)) {
    setEnvironmentValue(result, key, expand(value, root, dataDir));
  }
  setEnvironmentValue(result, "PLUGIN_ROOT", root);
  setEnvironmentValue(result, "PLUGIN_DATA", dataDir);
  return result;
}

function expand(value: string, root: string, dataDir: string): string {
  return value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_match, kind: string) =>
    kind === "ROOT" ? root : dataDir,
  );
}

function validateRemoteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidServerError("Remote MCP url must be absolute");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidServerError("Remote MCP url must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new InvalidServerError("Remote MCP url must not contain user info or a fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new InvalidServerError("Non-loopback remote MCP urls must use HTTPS");
  }
  return url.href;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (host === "localhost") {
    return true;
  }
  if (isIP(host) === 4) {
    return host.split(".")[0] === "127";
  }
  return isIP(host) === 6 && (host === "::1" || host.startsWith("::ffff:127."));
}

function validateHeaders(headers: Readonly<Record<string, string>>): void {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (names.has(normalized)) {
      throw new InvalidServerError("HTTP header names must be case-insensitively unique");
    }
    names.add(normalized);
    try {
      new Headers([[name, value]]);
    } catch {
      throw new InvalidServerError("Remote MCP headers contain an invalid field");
    }
  }
}

function validateManifest(
  document: unknown,
  diagnostics: AgentPluginDiagnostic[],
): AgentPluginManifest {
  if (!isRecord(document)) {
    throw new TypeError("plugin.json must contain an object");
  }
  if (document.$schema !== PLUGIN_SCHEMA) {
    throw new TypeError("plugin.json must target Agent Plugins 1.0.0");
  }
  if (
    typeof document.name !== "string" ||
    document.name.length > 64 ||
    !PLUGIN_NAME.test(document.name)
  ) {
    throw new TypeError("plugin.json contains an invalid plugin name");
  }

  const allowed = new Set([
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ]);
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) {
      diagnostics.push({
        code: "PLUGIN_MANIFEST_FIELD_IGNORED",
        message: `Unknown plugin.json field was ignored: ${key}`,
      });
    }
  }

  const version = optionalString(document.version, "plugin version");
  const description = optionalString(document.description, "plugin description");
  const homepage = optionalString(document.homepage, "plugin homepage");
  const repository = optionalString(document.repository, "plugin repository");
  const license = optionalString(document.license, "plugin license");
  const keywords = optionalStringArray(document.keywords, "plugin keywords");
  const author = validateAuthor(document.author);
  const extensions = validateExtensions(document.extensions, diagnostics);

  return {
    schema: PLUGIN_SCHEMA,
    name: document.name,
    ...(version === undefined ? {} : { version }),
    ...(description === undefined ? {} : { description }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repository === undefined ? {} : { repository }),
    ...(license === undefined ? {} : { license }),
    ...(keywords === undefined ? {} : { keywords }),
    ...(extensions === undefined ? {} : { extensions }),
  };
}

function validateAuthor(value: unknown): AgentPluginManifest["author"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["name", "email", "url"])) {
    throw new TypeError("plugin author must be a closed object");
  }
  const name = optionalString(value.name, "plugin author name");
  const email = optionalString(value.email, "plugin author email");
  const url = optionalString(value.url, "plugin author url");
  return {
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
    ...(url === undefined ? {} : { url }),
  };
}

function validateExtensions(
  value: unknown,
  diagnostics: AgentPluginDiagnostic[],
): AgentPluginManifest["extensions"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push({
      code: "PLUGIN_MANIFEST_FIELD_IGNORED",
      message: "Non-object plugin extensions field was ignored",
    });
    return undefined;
  }
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [namespace, extension] of Object.entries(value)) {
    if (!isRecord(extension)) {
      throw new TypeError("plugin extension values must be objects");
    }
    result[namespace] = { ...extension };
  }
  return result;
}

async function readContainedJson(
  root: string,
  name: "plugin.json" | "mcp.json",
  required: boolean,
): Promise<unknown | undefined> {
  const candidate = path.join(root, name);
  try {
    await lstat(candidate);
  } catch (error) {
    if (isMissing(error) && !required) {
      return undefined;
    }
    throw new TypeError(`${name} is missing`);
  }
  const resolved = await realpath(candidate).catch(() => {
    throw new TypeError(`${name} does not resolve`);
  });
  if (!isContained(root, resolved)) {
    throw new TypeError(`${name} resolves outside the plugin root`);
  }
  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new TypeError(`${name} must be a regular file`);
  }
  if (info.size > MAX_CONFIG_BYTES) {
    throw new TypeError(`${name} exceeds the configuration size limit`);
  }
  const source = await readFile(resolved, "utf8");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new TypeError(`${name} is not valid JSON`);
  }
}

async function resolveDirectory(value: string, label: string): Promise<string> {
  const resolved = await realpath(path.resolve(value)).catch(() => {
    throw new TypeError(`${label} does not resolve`);
  });
  if (!(await stat(resolved)).isDirectory()) {
    throw new TypeError(`${label} must be a directory`);
  }
  return resolved;
}

async function resolveWritableDataDirectory(value: string): Promise<string> {
  const absolute = path.resolve(value);
  await mkdir(absolute, { recursive: true });
  const resolved = await resolveDirectory(absolute, "Agent Plugin data directory");
  await access(resolved, fsConstants.W_OK);
  return resolved;
}

function validateBaseEnvironment(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (value === undefined) {
    return {};
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (key.length === 0 || typeof candidate !== "string") {
      throw new TypeError("Agent Plugin baseEnv must contain string entries");
    }
  }
  return { ...value };
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new InvalidServerError(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function optionalStringRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new InvalidServerError(`${label} must be an object of strings`);
  }
  return { ...value } as Record<string, string>;
}

function setEnvironmentValue(
  target: Record<string, string>,
  name: string,
  value: string,
): void {
  for (const existing of Object.keys(target)) {
    if (environmentKeyEquals(existing, name)) {
      delete target[existing];
    }
  }
  target[name] = value;
}

function environmentKeyEquals(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((key) => names.has(key));
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message.slice(0, 512)
    : fallback;
}

class InvalidServerError extends Error {}
