import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface AgentPluginCatalogSource {
  start(signal?: AbortSignal): Promise<AgentPluginStartupReport>;
  getTypeScriptCatalog(signal?: AbortSignal): Promise<AgentPluginTypeScriptCatalog>;
}

export interface AgentPluginStartupReport {
  readonly status: "ready" | "degraded";
  readonly catalogRevision: string;
  readonly sources: readonly AgentPluginSourceReport[];
}

export interface AgentPluginSourceReport {
  readonly source: string;
  readonly status: "healthy" | "unavailable";
  readonly toolCount: number;
  readonly message?: string;
  readonly rejectedToolCount?: number;
}

export interface AgentPluginTypeScriptCatalog {
  readonly catalogRevision: string;
  readonly declarations: string;
}

export interface ScaffoldAgentPluginOptions {
  readonly root: string;
  readonly pluginName: string;
  readonly serverName: string;
  readonly skillName: string;
  readonly description?: string;
  readonly version?: string;
  readonly license?: string;
  readonly entrypoint?: string;
}

export interface ScaffoldAgentPluginResult {
  readonly root: string;
  readonly manifest: string;
  readonly mcpConfig: string;
  readonly skillDirectory: string;
  readonly skillName: string;
}

export interface SyncAgentPluginSkillOptions {
  readonly root: string;
  readonly skillName: string;
  readonly serverName: string;
  readonly codeMode: AgentPluginCatalogSource;
  readonly signal?: AbortSignal;
}

export interface SyncAgentPluginSkillResult {
  readonly skillDirectory: string;
  readonly catalogRevision: string;
  readonly declarations: string;
  readonly metadata: string;
  readonly sources: readonly AgentPluginSourceReport[];
}

/**
 * Writes the portable Agent Plugins 1.0 wrapper and a compact companion skill.
 * Tool-specific declarations are populated later by syncAgentPluginSkill.
 */
export async function scaffoldAgentPlugin(
  options: ScaffoldAgentPluginOptions,
): Promise<ScaffoldAgentPluginResult> {
  const root = path.resolve(options.root);
  const pluginName = validatePortableName(options.pluginName, "Plugin name");
  const skillName = validatePortableName(options.skillName, "Skill name");
  const serverName = required(options.serverName, "Server name");
  const version = required(options.version ?? "0.1.0", "Plugin version");
  const entrypoint = options.entrypoint ?? "src/server.mjs";
  validatePluginRelativePath(entrypoint, "Plugin entrypoint");

  const manifestPath = path.join(root, "plugin.json");
  const mcpConfigPath = path.join(root, "mcp.json");
  const skillDirectory = path.join(root, "skills", skillName);
  const referencesDirectory = path.join(skillDirectory, "references");
  await mkdir(referencesDirectory, { recursive: true });

  const description =
    options.description ??
    `Use ${serverName} through a sandboxed TypeScript Code Mode interface.`;
  const manifest = {
    $schema: PLUGIN_SCHEMA,
    name: pluginName,
    version,
    description,
    ...(options.license === undefined
      ? {}
      : { license: required(options.license, "Plugin license") }),
    keywords: ["code-mode", "mcp", "agent-skill"],
  };
  const mcpConfig = {
    $schema: MCP_SCHEMA,
    mcpServers: {
      [serverName]: {
        type: "stdio",
        command: "node",
        args: [`\${PLUGIN_ROOT}/${entrypoint}`],
        cwd: "${PLUGIN_ROOT}",
      },
    },
  };

  await Promise.all([
    writeJson(manifestPath, manifest),
    writeJson(mcpConfigPath, mcpConfig),
    writeFile(
      path.join(skillDirectory, "SKILL.md"),
      renderCompanionSkill({ skillName, serverName }),
      "utf8",
    ),
    writeFile(
      path.join(referencesDirectory, "runtime.md"),
      renderRuntimeReference(serverName),
      "utf8",
    ),
    writeFile(
      path.join(referencesDirectory, "result-contract.md"),
      renderResultContractReference(),
      "utf8",
    ),
    writeFile(
      path.join(referencesDirectory, "examples.md"),
      renderExamplesReference(),
      "utf8",
    ),
    writeFile(
      path.join(referencesDirectory, "tools.d.ts"),
      renderPendingDeclarations(),
      "utf8",
    ),
    writeJson(path.join(referencesDirectory, "catalog-metadata.json"), {
      schemaVersion: 1,
      status: "pending",
      serverName,
      message: "Run npm run plugin:sync after the upstream tool source is available.",
    }),
  ]);

  return {
    root,
    manifest: manifestPath,
    mcpConfig: mcpConfigPath,
    skillDirectory,
    skillName,
  };
}

/**
 * Snapshots CodeModeKit's active catalog into an already-scaffolded companion
 * skill. A degraded catalog is rejected so a partial tool surface is never
 * presented as complete documentation.
 */
export async function syncAgentPluginSkill(
  options: SyncAgentPluginSkillOptions,
): Promise<SyncAgentPluginSkillResult> {
  const root = path.resolve(options.root);
  const skillName = validatePortableName(options.skillName, "Skill name");
  const serverName = required(options.serverName, "Server name");
  const snapshot = await stableCatalogSnapshot(options.codeMode, options.signal);
  if (snapshot.startup.status !== "ready") {
    const unavailable = snapshot.startup.sources
      .filter((source) => source.status === "unavailable")
      .map((source) => source.source)
      .join(", ");
    throw new Error(
      unavailable === ""
        ? "Cannot sync an Agent Plugin skill from a degraded catalog"
        : `Cannot sync an Agent Plugin skill while sources are unavailable: ${unavailable}`,
    );
  }

  const skillDirectory = path.join(root, "skills", skillName);
  const referencesDirectory = path.join(skillDirectory, "references");
  await mkdir(referencesDirectory, { recursive: true });
  const declarationsPath = path.join(referencesDirectory, "tools.d.ts");
  const metadataPath = path.join(referencesDirectory, "catalog-metadata.json");
  const declarations = renderCatalogDeclarations(
    snapshot.catalog.catalogRevision,
    snapshot.catalog.declarations,
  );
  const metadata = {
    schemaVersion: 1,
    status: "ready",
    serverName,
    catalogRevision: snapshot.catalog.catalogRevision,
    sources: snapshot.startup.sources.map((source) => ({
      source: source.source,
      status: source.status,
      toolCount: source.toolCount,
      ...(source.rejectedToolCount === undefined
        ? {}
        : { rejectedToolCount: source.rejectedToolCount }),
    })),
  };

  await Promise.all([
    atomicWrite(declarationsPath, declarations),
    atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`),
  ]);

  return {
    skillDirectory,
    catalogRevision: snapshot.catalog.catalogRevision,
    declarations: declarationsPath,
    metadata: metadataPath,
    sources: snapshot.startup.sources,
  };
}

export function normalizePortableName(value: string, label = "Name"): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 64)
    .replace(/-$/u, "");
  return validatePortableName(normalized, label);
}

interface RenderCompanionSkillOptions {
  readonly skillName: string;
  readonly serverName: string;
}

export function renderCompanionSkill(
  options: RenderCompanionSkillOptions,
): string {
  const skillName = validatePortableName(options.skillName, "Skill name");
  const serverName = required(options.serverName, "Server name");
  const description =
    `Use the ${serverName} Code Mode MCP server for requests that require its upstream tools. ` +
    "Apply the generated TypeScript catalog, compose calls in run_typescript, and return only the requested result.";
  return `---
name: ${skillName}
description: ${JSON.stringify(description)}
---

# Use ${serverName} Code Mode

Use \`run_typescript\` as the primary interface to the tools wrapped by this server.

1. Locate the relevant declarations in [references/tools.d.ts](references/tools.d.ts) before authoring calls. Search large files by capability, source, or tool name and read only focused matches.
2. Put related calls, result extraction, filtering, and reshaping into one \`run_typescript\` execution.
3. Return only the bounded value needed to answer the user.
4. Use \`search_tools\` when the generated catalog is pending or stale, does not contain the needed capability, or the client cannot search a large declaration reference efficiently.
5. Treat tool errors as data you can catch and handle; do not bypass tool policy or sandbox limits.

Read [references/runtime.md](references/runtime.md) for execution rules, [references/result-contract.md](references/result-contract.md) for MCP result extraction, and [references/examples.md](references/examples.md) for composition patterns.
`;
}

function renderRuntimeReference(serverName: string): string {
  return `# ${serverName} runtime

The server exposes a small Code Mode surface:

- \`run_typescript\` compiles and executes an async TypeScript function body in a sandbox. Top-level \`await\` and \`return\` are supported.
- \`search_tools\` searches the current runtime catalog and can return focused TypeScript declarations.

The sandbox exposes \`tools\` and a limited set of safe JavaScript globals. It does not expose Node.js modules, filesystem APIs, process APIs, network APIs, dynamic imports, or arbitrary package imports.

Prefer one execution that calls, combines, and reduces upstream results. Use \`Promise.all\` only for independent operations. Keep the final return value small; do not return raw payloads when a projection or summary is sufficient.

The generated declaration snapshot is authoritative for its recorded catalog revision. If a call is missing or fails with \`TOOL_NOT_FOUND\`, use \`search_tools\` to inspect the live catalog and then refresh the snapshot with \`npm run plugin:sync\` when maintaining the plugin.
`;
}

function renderResultContractReference(): string {
  return `# Tool result contract

Every \`tools.*\` call resolves to an MCP result wrapper rather than directly to the upstream payload:

\`\`\`ts
interface ToolContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface ToolResult<TStructured = unknown> {
  readonly content: readonly ToolContentBlock[];
  readonly structuredContent?: TStructured;
}
\`\`\`

Prefer \`structuredContent\` when present. Some servers nest the useful value under \`structuredContent.result\`. When structured content is absent, inspect text blocks in \`content\` and call \`JSON.parse\` only after confirming the selected block has a string \`text\` field.

Tool failures throw a catchable \`ToolCallError\` with \`code\`, \`phase\`, and optional \`source\` and \`tool\` fields. Catch an error only when the workflow can recover or return a more useful bounded result.
`;
}

function renderExamplesReference(): string {
  return `# Composition examples

Replace the source, tool, and input names with declarations from \`tools.d.ts\`.

## Extract structured data

\`\`\`ts
const result = await tools["source-name"]["tool-name"]({});
const structured = result.structuredContent;
return structured !== null &&
  typeof structured === "object" &&
  !Array.isArray(structured) &&
  "result" in structured
    ? structured.result
    : structured;
\`\`\`

## Run independent calls concurrently

\`\`\`ts
const [first, second] = await Promise.all([
  tools["source-name"]["first-tool"]({}),
  tools["source-name"]["second-tool"]({}),
]);
return {
  first: first.structuredContent,
  second: second.structuredContent,
};
\`\`\`

## Recover from an optional call

\`\`\`ts
try {
  const result = await tools["source-name"]["optional-tool"]({});
  return { available: true, value: result.structuredContent };
} catch (error) {
  return {
    available: false,
    code: error instanceof ToolCallError ? error.code : "UNKNOWN",
  };
}
\`\`\`
`;
}

function renderPendingDeclarations(): string {
  return `// CodeModeKit catalog snapshot pending.
// Run: npm run plugin:sync
`;
}

function renderCatalogDeclarations(revision: string, declarations: string): string {
  return `// Generated by CodeModeKit from catalog revision ${revision}.
// Refresh with: npm run plugin:sync

${declarations.trim()}\n`;
}

async function stableCatalogSnapshot(
  codeMode: AgentPluginCatalogSource,
  signal: AbortSignal | undefined,
): Promise<{
  readonly startup: AgentPluginStartupReport;
  readonly catalog: AgentPluginTypeScriptCatalog;
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startup = await codeMode.start(signal);
    const catalog = await codeMode.getTypeScriptCatalog(signal);
    if (startup.catalogRevision === catalog.catalogRevision) {
      return { startup, catalog };
    }
  }
  throw new Error("The Code Mode catalog changed repeatedly while creating the snapshot");
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, file);
}

function validatePortableName(value: string, label: string): string {
  const name = required(value, label);
  if (name.length > 64 || !PORTABLE_NAME.test(name)) {
    throw new TypeError(
      `${label} must contain at most 64 lowercase letters, digits, and single hyphens`,
    );
  }
  return name;
}

function validatePluginRelativePath(value: string, label: string): void {
  if (
    value === "" ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/u).some((segment) => segment === "..")
  ) {
    throw new TypeError(`${label} must stay within the plugin root`);
  }
}

function required(value: string, label: string): string {
  if (value.trim() === "") {
    throw new TypeError(`${label} must not be empty`);
  }
  return value;
}
