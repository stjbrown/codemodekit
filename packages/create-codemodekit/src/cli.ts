#!/usr/bin/env node
import { parseMcpCommand } from "./command.js";
import { scaffoldCodeModeMcp } from "./scaffold.js";

interface CliOptions {
  readonly targetDirectory: string;
  readonly mcpName: string;
  readonly mcpCommand: string;
  readonly serverName?: string;
  readonly policy: "allow-all" | "deny-all";
  readonly agentPlugin: boolean;
  readonly sync: boolean;
  readonly install: boolean;
  readonly codemodekitVersion?: string;
  readonly createCodemodekitVersion?: string;
}

export async function runCli(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return;
  }

  const options = parseOptions(args);
  const result = await scaffoldCodeModeMcp({
    targetDirectory: options.targetDirectory,
    mcpName: options.mcpName,
    mcpCommand: parseMcpCommand(options.mcpCommand),
    ...(options.serverName === undefined
      ? {}
      : { serverName: options.serverName }),
    policy: options.policy,
    install: options.install,
    ...(options.codemodekitVersion === undefined
      ? {}
      : { codemodekitVersion: options.codemodekitVersion }),
    ...(options.createCodemodekitVersion === undefined
      ? {}
      : { createCodemodekitVersion: options.createCodemodekitVersion }),
    ...(options.agentPlugin
      ? { agentPlugin: { sync: options.sync && options.install } }
      : {}),
  });

  const pluginSummary =
    result.agentPlugin === undefined
      ? ""
      : result.agentPlugin.synced
        ? `Agent Plugin: ready (${result.agentPlugin.skillName})\n`
        : `Agent Plugin: scaffolded (${result.agentPlugin.skillName})\n` +
          `${result.agentPlugin.syncError === undefined ? "" : `Catalog sync pending: ${result.agentPlugin.syncError}\n`}` +
          "  npm run plugin:sync\n";
  process.stdout.write(
    `\nCreated ${options.serverName ?? `${options.mcpName}-code-mode`} in ${result.directory}\n\n` +
      `${result.installed ? "" : "  npm install\n"}  npm start\n\n` +
      pluginSummary +
      `Tool policy: ${options.policy}\n`,
  );
}

function parseOptions(args: readonly string[]): CliOptions {
  let targetDirectory: string | undefined;
  let mcpName: string | undefined;
  let mcpCommand: string | undefined;
  let serverName: string | undefined;
  let policy: "allow-all" | "deny-all" = "allow-all";
  let agentPlugin = false;
  let sync = true;
  let install = true;
  let codemodekitVersion: string | undefined;
  let createCodemodekitVersion: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("-")) {
      if (targetDirectory !== undefined) {
        throw new TypeError(`Unexpected argument: ${argument}`);
      }
      targetDirectory = argument;
      continue;
    }

    if (argument === "--no-install") {
      install = false;
      continue;
    }
    if (argument === "--agent-plugin") {
      agentPlugin = true;
      continue;
    }
    if (argument === "--no-sync") {
      sync = false;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError(`Missing value for ${argument}`);
    }
    index += 1;

    switch (argument) {
      case "--mcp-name":
        mcpName = value;
        break;
      case "--mcp-command":
        mcpCommand = value;
        break;
      case "--server-name":
        serverName = value;
        break;
      case "--policy":
        if (value !== "allow-all" && value !== "deny-all") {
          throw new TypeError("--policy must be allow-all or deny-all");
        }
        policy = value;
        break;
      case "--codemodekit-version":
        codemodekitVersion = value;
        break;
      case "--create-codemodekit-version":
        createCodemodekitVersion = value;
        break;
      default:
        throw new TypeError(`Unknown option: ${argument}`);
    }
  }

  if (targetDirectory === undefined) {
    throw new TypeError("A target directory is required");
  }
  if (mcpName === undefined) {
    throw new TypeError("--mcp-name is required");
  }
  if (mcpCommand === undefined) {
    throw new TypeError("--mcp-command is required");
  }

  return {
    targetDirectory,
    mcpName,
    mcpCommand,
    ...(serverName === undefined ? {} : { serverName }),
    policy,
    agentPlugin,
    sync,
    install,
    ...(codemodekitVersion === undefined ? {} : { codemodekitVersion }),
    ...(createCodemodekitVersion === undefined
      ? {}
      : { createCodemodekitVersion }),
  };
}

function usage(): string {
  return `Create a batteries-included Code Mode MCP server.

Usage:
  npm create codemodekit@latest <directory> -- \\
    --mcp-name <name> \\
    --mcp-command '<executable> [args...]'

Options:
  --server-name <name>       Downstream MCP server name
  --policy allow-all         Allow every discovered upstream tool (default)
  --policy deny-all          Deny every upstream tool until policy is edited
  --agent-plugin             Add plugin.json, mcp.json, and a companion Agent Skill
  --no-sync                  Do not snapshot tool types during Agent Plugin creation
  --no-install               Generate files without running npm install
  --codemodekit-version <v>  Override the generated runtime dependency
  --create-codemodekit-version <v>
                             Override the generated sync dependency
  -h, --help                 Show this help
`;
}

runCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`create-codemodekit: ${message}\n\n${usage()}`);
  process.exitCode = 1;
});
