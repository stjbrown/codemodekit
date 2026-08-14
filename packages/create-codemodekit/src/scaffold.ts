import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  normalizePortableName,
  scaffoldAgentPlugin,
  type ScaffoldAgentPluginResult,
} from "./agent-plugin.js";
import { installProjectAuthoringSkills } from "./authoring-skill.js";
import type { ParsedCommand } from "./command.js";
import {
  renderEnvExample,
  renderSources,
  renderSourcesReadme,
  type ScaffoldSource,
} from "./source-template.js";
import { renderVerifyScript } from "./verify-template.js";

export type { ScaffoldSource } from "./source-template.js";

const PACKAGE_VERSION = readPackageVersion();
// The generator and batteries-included runtime release independently.
// Exported so tests can assert it stays satisfiable by the workspace release.
export const DEFAULT_CODEMODEKIT_VERSION = "^0.5.0";
export const GENERATED_MCP_CLIENT_VERSION = "2.0.0-beta.5";
const DEFAULT_CREATE_CODEMODEKIT_VERSION = `^${PACKAGE_VERSION}`;

export interface AgentPluginScaffoldOptions {
  readonly pluginName?: string;
  readonly skillName?: string;
  readonly description?: string;
  readonly license?: string;
  /** Discover the live catalog and populate references after install. Defaults to true. */
  readonly sync?: boolean;
}

export interface ScaffoldCodeModeMcpOptions {
  readonly targetDirectory: string;
  /** Tool sources to combine beneath one generated Code Mode catalog. */
  readonly sources?: readonly ScaffoldSource[];
  /** Tool source to wrap. Prefer this over the legacy mcpName/mcpCommand pair. */
  readonly source?: ScaffoldSource;
  /** @deprecated Use source: { type: "mcp-stdio", ... }. */
  readonly mcpName?: string;
  /** @deprecated Use source: { type: "mcp-stdio", ... }. */
  readonly mcpCommand?: ParsedCommand;
  readonly serverName?: string;
  readonly packageName?: string;
  readonly policy?: "allow-all" | "deny-all";
  /** Generate a portable Agent Plugins 1.0 package and companion skill. */
  readonly agentPlugin?: boolean | AgentPluginScaffoldOptions;
  /** Install both project-local authoring skills under .agents/skills. Defaults to true. */
  readonly authoringSkill?: boolean;
  readonly install?: boolean;
  /** Override the generated runtime dependency, including with a file: specifier. */
  readonly codemodekitVersion?: string;
  /** Override the generated sync-time dependency. */
  readonly createCodemodekitVersion?: string;
  readonly cwd?: string;
}

export interface GeneratedAgentPluginResult extends ScaffoldAgentPluginResult {
  readonly synced: boolean;
  readonly syncError?: string;
  readonly built: boolean;
  readonly artifactDirectory?: string;
}

export interface ScaffoldResult {
  readonly directory: string;
  readonly entrypoint: string;
  readonly installed: boolean;
  /** First installed authoring skill retained for compatibility. */
  readonly authoringSkillDirectory?: string;
  readonly authoringSkillDirectories?: readonly string[];
  readonly agentPlugin?: GeneratedAgentPluginResult;
}

export async function scaffoldCodeModeMcp(
  options: ScaffoldCodeModeMcpOptions,
): Promise<ScaffoldResult> {
  const cwd = options.cwd ?? process.cwd();
  const directory = path.resolve(cwd, options.targetDirectory);
  const sources = resolveSources(options);
  const sourceName =
    sources.length === 1
      ? resolvedSourceName(sources[0] as ScaffoldSource)
      : "multi-source";
  const serverName = required(
    options.serverName ?? `${sourceName}-code-mode`,
    "Server name",
  );
  const packageName = validPackageName(
    options.packageName ?? packageNameFromDirectory(directory),
  );
  const policy = options.policy ?? "allow-all";
  const install = options.install ?? true;
  const includeAuthoringSkill = options.authoringSkill ?? true;
  const agentPluginOptions = resolveAgentPluginOptions(options.agentPlugin);
  const pluginName =
    agentPluginOptions === undefined
      ? undefined
      : normalizePortableName(
          agentPluginOptions.pluginName ?? path.basename(directory),
          "Plugin name",
        );
  const skillName =
    agentPluginOptions === undefined
      ? undefined
      : normalizePortableName(
          agentPluginOptions.skillName ?? `use-${sourceName}-codemode`,
          "Skill name",
        );
  const codemodekitVersion = required(
    options.codemodekitVersion ?? DEFAULT_CODEMODEKIT_VERSION,
    "CodeModeKit dependency version",
  );
  const createCodemodekitVersion = required(
    options.createCodemodekitVersion ?? DEFAULT_CREATE_CODEMODEKIT_VERSION,
    "create-codemodekit dependency version",
  );

  await ensureEmptyDirectory(directory);
  await Promise.all([
    mkdir(path.join(directory, "src"), { recursive: true }),
    mkdir(path.join(directory, "scripts"), { recursive: true }),
  ]);

  const packageJson = {
    name: packageName,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: { node: ">=20" },
    scripts: {
      start: "node src/server.mjs",
      verify: "node scripts/verify.mjs",
      ...(agentPluginOptions === undefined
        ? {}
        : {
            "plugin:sync": "node src/server.mjs --sync-plugin",
            "plugin:build": "codemodekit-plugin build",
            "plugin:install:cursor": "codemodekit-plugin install cursor",
            "plugin:status:cursor": "codemodekit-plugin status cursor",
            "plugin:uninstall:cursor": "codemodekit-plugin uninstall cursor",
          }),
    },
    dependencies: { "codemodekit": codemodekitVersion },
    devDependencies: {
      "@modelcontextprotocol/client": GENERATED_MCP_CLIENT_VERSION,
      ...(agentPluginOptions === undefined
        ? {}
        : { "create-codemodekit": createCodemodekitVersion }),
    },
  };

  const entrypoint = path.join(directory, "src", "server.mjs");
  await Promise.all([
    writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(directory, ".gitignore"),
      "node_modules/\n.env\n.env.*\n!.env.example\n",
      "utf8",
    ),
    writeFile(
      path.join(directory, ".env.example"),
      renderEnvExample(sources),
      "utf8",
    ),
    writeFile(
      path.join(directory, "README.md"),
      renderProjectReadme({
        packageName,
        serverName,
        sources,
        policy,
        agentPlugin: agentPluginOptions !== undefined,
        authoringSkill: includeAuthoringSkill,
      }),
      "utf8",
    ),
    writeFile(
      entrypoint,
      renderServer({
        serverName,
        sources,
        policy,
        ...(skillName === undefined
          ? {}
          : { agentPlugin: { skillName } }),
      }),
      "utf8",
    ),
    writeFile(
      path.join(directory, "scripts", "verify.mjs"),
      renderVerifyScript(sources.map(resolvedSourceName)),
      "utf8",
    ),
  ]);

  const authoringSkills = includeAuthoringSkill
    ? await installProjectAuthoringSkills({ root: directory })
    : undefined;
  const authoringSkillDirectories =
    authoringSkills === undefined
      ? undefined
      : Object.values(authoringSkills.directories).filter(
          (value): value is string => value !== undefined,
        );
  const authoringSkillDirectory = authoringSkillDirectories?.[0];

  let generatedPlugin: ScaffoldAgentPluginResult | undefined;
  if (
    agentPluginOptions !== undefined &&
    pluginName !== undefined &&
    skillName !== undefined
  ) {
    generatedPlugin = await scaffoldAgentPlugin({
      root: directory,
      pluginName,
      serverName,
      skillName,
      ...(agentPluginOptions.description === undefined
        ? {}
        : { description: agentPluginOptions.description }),
      ...(agentPluginOptions.license === undefined
        ? {}
        : { license: agentPluginOptions.license }),
    });
  }

  if (install) {
    await runNpmInstall(directory);
  }

  let syncError: string | undefined;
  let synced = false;
  if (
    generatedPlugin !== undefined &&
    (agentPluginOptions?.sync ?? install)
  ) {
    try {
      await runPluginSync(directory);
      synced = true;
    } catch (error) {
      syncError = error instanceof Error ? error.message : String(error);
    }
  }

  let built = false;
  let artifactDirectory: string | undefined;
  if (generatedPlugin !== undefined && install) {
    await runPluginBuild(directory);
    built = true;
    artifactDirectory = path.join(directory, "dist", "plugin");
  }

  return {
    directory,
    entrypoint,
    installed: install,
    ...(authoringSkillDirectory === undefined
      ? {}
      : { authoringSkillDirectory }),
    ...(authoringSkillDirectories === undefined
      ? {}
      : { authoringSkillDirectories }),
    ...(generatedPlugin === undefined
      ? {}
      : {
          agentPlugin: {
            ...generatedPlugin,
            synced,
            built,
            ...(syncError === undefined ? {} : { syncError }),
            ...(artifactDirectory === undefined ? {} : { artifactDirectory }),
          },
        }),
  };
}

interface RenderServerOptions {
  readonly serverName: string;
  readonly sources: readonly ScaffoldSource[];
  readonly policy: "allow-all" | "deny-all";
  readonly agentPlugin?: {
    readonly skillName: string;
  };
}

interface RenderProjectReadmeOptions {
  readonly packageName: string;
  readonly serverName: string;
  readonly sources: readonly ScaffoldSource[];
  readonly policy: "allow-all" | "deny-all";
  readonly agentPlugin: boolean;
  readonly authoringSkill: boolean;
}

function renderProjectReadme(options: RenderProjectReadmeOptions): string {
  const pluginSection = options.agentPlugin
    ? `
## Agent Plugin

Refresh the companion skill after the upstream tool catalog changes, then rebuild the self-contained plugin:

\`\`\`sh
npm run plugin:sync
npm run plugin:build
\`\`\`

The portable package is written to \`dist/plugin\`; it does not require this project's \`node_modules\`. Credentials and \`.env\` files are never copied into it.

For Cursor, install a concrete local copy and reload the window:

\`\`\`sh
npm run plugin:install:cursor
\`\`\`

Run \`npm run plugin:status:cursor\` to inspect it and \`npm run plugin:uninstall:cursor\` to remove it. Reinstall after changing source, policy, metadata, or generated references.
`
    : "";
  const authoringSection = options.authoringSkill
    ? `
## Development guidance

The project-local \`.agents/skills/build-codemodekit-server\` and \`.agents/skills/author-codemode-skill\` skills let compatible coding agents build the server, then author domain-aware runtime guidance and maintain its Agent Plugin.

After the catalog is synchronized, ask the coding agent to use \`$author-codemode-skill\` before distributing the generated runtime skill.
`
    : "";
  const sourceSection = renderSourcesReadme(options.sources);
  return `# ${options.packageName}

Code Mode MCP server generated by [CodeModeKit](https://github.com/stjbrown/codemodekit).

## Run

\`\`\`sh
npm start

# Validate the Code Mode surface and sandbox without calling provider tools
npm run verify
\`\`\`

The downstream server is \`${options.serverName}\`.

${sourceSection}

The generated tool policy is \`${options.policy}\`. Review \`src/server.mjs\` before exposing the server, and keep credentials in uncommitted environment files or the upstream tool's supported secret mechanism.

For an end-to-end provider assertion, put a bounded TypeScript composition in a file that returns an object containing \`verified: true\`, then run \`CODEMODEKIT_VERIFY_CODE_FILE=verify/live.ts npm run verify\`. Export the variables shown in \`.env.example\` with your preferred environment manager before starting or verifying the server.
${pluginSection}${authoringSection}
`;
}

export function renderServer(options: RenderServerOptions): string {
  const policyFactory =
    options.policy === "allow-all" ? "allowAllToolCalls" : "denyAllToolCalls";
  const sources = renderSources(options.sources);
  const plugin = options.agentPlugin;
  const nodeImport =
    plugin === undefined ? "" : 'import { fileURLToPath } from "node:url";\n\n';
  const imports = [
    policyFactory,
    ...(plugin === undefined ? [] : ["createCodeModeMcp"]),
    ...sources.imports,
    "serveCodeModeStdio",
  ].sort();
  const application = `const options = {
  name: ${JSON.stringify(options.serverName)},
  version: "0.1.0",
  toolPolicy: ${policyFactory}(),
  sources: [${sources.expressions.join("")}],
};
`;
  const launch =
    plugin === undefined
      ? "await serveCodeModeStdio(options);\n"
      : renderAgentPluginLaunch(plugin.skillName, options.serverName);
  return `${nodeImport}import {
${imports.map((name) => `  ${name},`).join("\n")}
} from "codemodekit";

${sources.prelude}${application}
${launch}`;
}

function renderAgentPluginLaunch(skillName: string, serverName: string): string {
  return `if (process.argv.includes("--sync-plugin")) {
  const { syncAgentPluginSkill } = await import("create-codemodekit");
  const application = createCodeModeMcp(options);
  try {
    const result = await syncAgentPluginSkill({
      root: fileURLToPath(new URL("../", import.meta.url)),
      skillName: ${JSON.stringify(skillName)},
      serverName: ${JSON.stringify(serverName)},
      codeMode: application.codeMode,
    });
    process.stdout.write(
      \`Synced Agent Plugin catalog \${result.catalogRevision} to \${result.skillDirectory}\\n\`,
    );
  } finally {
    await application.close();
  }
} else {
  await serveCodeModeStdio(options);
}
`;
}

function resolveSources(
  options: ScaffoldCodeModeMcpOptions,
): readonly ScaffoldSource[] {
  if (
    (options.source !== undefined || options.sources !== undefined) &&
    (options.mcpName !== undefined || options.mcpCommand !== undefined)
  ) {
    throw new TypeError(
      "Use sources, source, or mcpName/mcpCommand, not a combination",
    );
  }
  if (options.source !== undefined && options.sources !== undefined) {
    throw new TypeError("Use either sources or source, not both");
  }
  const candidates =
    options.sources ??
    (options.source === undefined ? undefined : [options.source]);
  if (candidates !== undefined) {
    if (candidates.length === 0) {
      throw new TypeError("At least one source is required");
    }
    const resolved = candidates.map((source): ScaffoldSource => {
      switch (source.type) {
        case "weather":
          return source;
        case "mcp-stdio":
          return {
            type: "mcp-stdio",
            name: required(source.name, "MCP name"),
            command: validateCommand(source.command),
          };
        case "mcp-http": {
          const bearerTokenEnv = validateOptionalEnvironmentName(
            source.bearerTokenEnv,
          );
          const headerEnv = validateHeaderEnvironment(source.headerEnv);
          if (
            bearerTokenEnv !== undefined &&
            Object.keys(headerEnv).some(
              (header) => header.toLowerCase() === "authorization",
            )
          ) {
            throw new TypeError(
              "Use either bearerTokenEnv or an Authorization headerEnv mapping",
            );
          }
          return {
            type: "mcp-http",
            name: required(source.name, "MCP name"),
            url: validateHttpUrl(source.url),
            ...(bearerTokenEnv === undefined ? {} : { bearerTokenEnv }),
            ...(Object.keys(headerEnv).length === 0 ? {} : { headerEnv }),
          };
        }
      }
    });
    const names = resolved.map(resolvedSourceName);
    const duplicate = names.find(
      (name, index) => names.indexOf(name) !== index,
    );
    if (duplicate !== undefined) {
      throw new TypeError(`Duplicate source name: ${duplicate}`);
    }
    return resolved;
  }
  if (options.mcpName === undefined || options.mcpCommand === undefined) {
    throw new TypeError("A source or mcpName/mcpCommand pair is required");
  }
  return [
    {
      type: "mcp-stdio",
      name: required(options.mcpName, "MCP name"),
      command: validateCommand(options.mcpCommand),
    },
  ];
}

function resolvedSourceName(source: ScaffoldSource): string {
  return source.type === "weather" ? "weather" : source.name;
}

function validateOptionalEnvironmentName(
  value: string | undefined,
): string | undefined {
  return value === undefined ? undefined : validateEnvironmentName(value);
}

function validateEnvironmentName(value: string): string {
  const name = required(value, "Environment variable name");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new TypeError(`Invalid environment variable name: ${name}`);
  }
  return name;
}

function validateHeaderEnvironment(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const entries = Object.entries(value ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const result: Record<string, string> = {};
  const normalizedHeaders = new Set<string>();
  for (const [header, environment] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(header)) {
      throw new TypeError(`Invalid HTTP header name: ${header}`);
    }
    const normalized = header.toLowerCase();
    if (normalizedHeaders.has(normalized)) {
      throw new TypeError(`Duplicate HTTP header name: ${header}`);
    }
    normalizedHeaders.add(normalized);
    result[header] = validateEnvironmentName(environment);
  }
  return result;
}

function validateCommand(command: ParsedCommand): ParsedCommand {
  return {
    command: required(command.command, "MCP command"),
    args: command.args.map((argument) => String(argument)),
  };
}

function validateHttpUrl(value: string): string {
  const candidate = required(value, "MCP URL");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError(`Invalid MCP URL: ${candidate}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("MCP URL must use http or https");
  }
  return url.toString();
}

async function ensureEmptyDirectory(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory);
    if (entries.length > 0) {
      throw new Error(`Target directory is not empty: ${directory}`);
    }
  } catch (error) {
    if (isMissing(error)) {
      await mkdir(directory, { recursive: true });
      return;
    }
    throw error;
  }
}

function runNpmInstall(directory: string): Promise<void> {
  return runCommand("npm", ["install"], directory, "npm install");
}

function runPluginSync(directory: string): Promise<void> {
  return runCommand(
    "npm",
    ["run", "plugin:sync"],
    directory,
    "Agent Plugin catalog sync",
  );
}

function runPluginBuild(directory: string): Promise<void> {
  return runCommand(
    "npm",
    ["run", "plugin:build"],
    directory,
    "Agent Plugin build",
  );
}

function runCommand(
  command: string,
  args: readonly string[],
  directory: string,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: directory,
      stdio: "inherit",
      shell: false,
      env: projectCommandEnvironment(),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${label} failed${signal === null ? ` with exit code ${String(code)}` : ` from signal ${signal}`}`,
        ),
      );
    });
  });
}

function projectCommandEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "npm_config_allow_scripts") {
      delete environment[key];
    }
  }
  return environment;
}

function resolveAgentPluginOptions(
  value: ScaffoldCodeModeMcpOptions["agentPlugin"],
): AgentPluginScaffoldOptions | undefined {
  if (value === undefined || value === false) return undefined;
  return value === true ? {} : value;
}

function readPackageVersion(): string {
  const document: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof document !== "object" ||
    document === null ||
    !("version" in document) ||
    typeof document.version !== "string" ||
    document.version.trim() === ""
  ) {
    throw new Error("create-codemodekit package version is unavailable");
  }
  return document.version;
}

function packageNameFromDirectory(directory: string): string {
  return path.basename(directory).toLowerCase().replace(/[^a-z0-9._-]+/gu, "-");
}

function validPackageName(value: string): string {
  const name = required(value, "Package name");
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name)) {
    throw new TypeError(`Invalid npm package name: ${name}`);
  }
  return name;
}

function required(value: string, label: string): string {
  if (value.trim() === "") throw new TypeError(`${label} must not be empty`);
  return value;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
