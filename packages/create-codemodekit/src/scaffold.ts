import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  normalizePortableName,
  scaffoldAgentPlugin,
  type ScaffoldAgentPluginResult,
} from "./agent-plugin.js";
import type { ParsedCommand } from "./command.js";

const PACKAGE_VERSION = readPackageVersion();
// The generator and batteries-included runtime release independently.
const DEFAULT_CODEMODEKIT_VERSION = "^0.1.0";
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
  readonly mcpName: string;
  readonly mcpCommand: ParsedCommand;
  readonly serverName?: string;
  readonly packageName?: string;
  readonly policy?: "allow-all" | "deny-all";
  /** Generate a portable Agent Plugins 1.0 package and companion skill. */
  readonly agentPlugin?: boolean | AgentPluginScaffoldOptions;
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
}

export interface ScaffoldResult {
  readonly directory: string;
  readonly entrypoint: string;
  readonly installed: boolean;
  readonly agentPlugin?: GeneratedAgentPluginResult;
}

export async function scaffoldCodeModeMcp(
  options: ScaffoldCodeModeMcpOptions,
): Promise<ScaffoldResult> {
  const cwd = options.cwd ?? process.cwd();
  const directory = path.resolve(cwd, options.targetDirectory);
  const mcpName = required(options.mcpName, "MCP name");
  const serverName = required(
    options.serverName ?? `${mcpName}-code-mode`,
    "Server name",
  );
  const packageName = validPackageName(
    options.packageName ?? packageNameFromDirectory(directory),
  );
  const policy = options.policy ?? "allow-all";
  const install = options.install ?? true;
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
          agentPluginOptions.skillName ?? `use-${mcpName}-codemode`,
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
  await mkdir(path.join(directory, "src"), { recursive: true });

  const packageJson = {
    name: packageName,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: { node: ">=20" },
    scripts: {
      start: "node src/server.mjs",
      ...(agentPluginOptions === undefined
        ? {}
        : { "plugin:sync": "node src/server.mjs --sync-plugin" }),
    },
    dependencies: { "codemodekit": codemodekitVersion },
    ...(agentPluginOptions === undefined
      ? {}
      : {
          devDependencies: {
            "create-codemodekit": createCodemodekitVersion,
          },
        }),
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
      entrypoint,
      renderServer({
        serverName,
        mcpName,
        mcpCommand: options.mcpCommand,
        policy,
        ...(skillName === undefined
          ? {}
          : { agentPlugin: { skillName } }),
      }),
      "utf8",
    ),
  ]);

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

  return {
    directory,
    entrypoint,
    installed: install,
    ...(generatedPlugin === undefined
      ? {}
      : {
          agentPlugin: {
            ...generatedPlugin,
            synced,
            ...(syncError === undefined ? {} : { syncError }),
          },
        }),
  };
}

interface RenderServerOptions {
  readonly serverName: string;
  readonly mcpName: string;
  readonly mcpCommand: ParsedCommand;
  readonly policy: "allow-all" | "deny-all";
  readonly agentPlugin?: {
    readonly skillName: string;
  };
}

export function renderServer(options: RenderServerOptions): string {
  const policyFactory =
    options.policy === "allow-all" ? "allowAllToolCalls" : "denyAllToolCalls";
  if (options.agentPlugin !== undefined) {
    return renderAgentPluginServer(options, policyFactory);
  }
  return `import {
  ${policyFactory},
  mcp,
  serveCodeModeStdio,
} from "codemodekit";

await serveCodeModeStdio({
  name: ${JSON.stringify(options.serverName)},
  version: "0.1.0",
  toolPolicy: ${policyFactory}(),
  sources: [
    mcp.stdio({
      name: ${JSON.stringify(options.mcpName)},
      command: ${JSON.stringify(options.mcpCommand.command)},
      args: ${JSON.stringify(options.mcpCommand.args)},
    }),
  ],
});
`;
}

function renderAgentPluginServer(
  options: RenderServerOptions,
  policyFactory: "allowAllToolCalls" | "denyAllToolCalls",
): string {
  const skillName = options.agentPlugin?.skillName;
  if (skillName === undefined) {
    throw new TypeError("Agent Plugin skill name is required");
  }
  return `import { fileURLToPath } from "node:url";

import {
  ${policyFactory},
  createCodeModeMcp,
  mcp,
  serveCodeModeStdio,
} from "codemodekit";

const options = {
  name: ${JSON.stringify(options.serverName)},
  version: "0.1.0",
  toolPolicy: ${policyFactory}(),
  sources: [
    mcp.stdio({
      name: ${JSON.stringify(options.mcpName)},
      command: ${JSON.stringify(options.mcpCommand.command)},
      args: ${JSON.stringify(options.mcpCommand.args)},
    }),
  ],
};

if (process.argv.includes("--sync-plugin")) {
  const { syncAgentPluginSkill } = await import("create-codemodekit");
  const application = createCodeModeMcp(options);
  try {
    const result = await syncAgentPluginSkill({
      root: fileURLToPath(new URL("../", import.meta.url)),
      skillName: ${JSON.stringify(skillName)},
      serverName: ${JSON.stringify(options.serverName)},
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
