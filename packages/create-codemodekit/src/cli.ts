#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseMcpCommand } from "./command.js";
import {
  scaffoldCodeModeMcp,
  type ScaffoldSource,
} from "./scaffold.js";

interface CliDraft {
  readonly targetDirectory?: string;
  readonly mcpName?: string;
  readonly mcpCommand?: string;
  readonly mcpUrl?: string;
  readonly example?: "weather";
  readonly serverName?: string;
  readonly pluginName?: string;
  readonly skillName?: string;
  readonly pluginDescription?: string;
  readonly pluginLicense?: string;
  readonly policy?: "allow-all" | "deny-all";
  readonly agentPlugin?: boolean;
  readonly authoringSkill: boolean;
  readonly sync: boolean;
  readonly install: boolean;
  readonly codemodekitVersion?: string;
  readonly createCodemodekitVersion?: string;
}

interface CliOptions extends Omit<
  CliDraft,
  | "targetDirectory"
  | "mcpName"
  | "mcpCommand"
  | "mcpUrl"
  | "example"
  | "policy"
  | "agentPlugin"
> {
  readonly targetDirectory: string;
  readonly source: ScaffoldSource;
  readonly policy: "allow-all" | "deny-all";
  readonly agentPlugin: boolean;
}

export interface CliPrompter {
  input(message: string, defaultValue?: string): Promise<string>;
  select<T extends string>(
    message: string,
    choices: readonly { readonly label: string; readonly value: T }[],
    defaultValue: T,
  ): Promise<T>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  close?(): void;
}

export interface RunCliOptions {
  readonly prompter?: CliPrompter;
  readonly write?: (value: string) => void;
}

export async function runCli(
  args: readonly string[],
  runtime: RunCliOptions = {},
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    (runtime.write ?? process.stdout.write.bind(process.stdout))(usage());
    return;
  }

  const draft = parseOptions(args);
  const needsPrompt = requiresPrompt(draft);
  const ownedPrompter =
    needsPrompt && runtime.prompter === undefined ? terminalPrompter() : undefined;
  const prompter = runtime.prompter ?? ownedPrompter;
  if (needsPrompt && prompter === undefined) {
    throw new TypeError(
      "Missing required options in a non-interactive terminal; pass a directory and source flags",
    );
  }

  let options: CliOptions;
  try {
    options = await completeOptions(draft, prompter);
  } finally {
    ownedPrompter?.close?.();
  }

  const result = await scaffoldCodeModeMcp({
    targetDirectory: options.targetDirectory,
    source: options.source,
    ...(options.serverName === undefined
      ? {}
      : { serverName: options.serverName }),
    policy: options.policy,
    authoringSkill: options.authoringSkill,
    install: options.install,
    ...(options.codemodekitVersion === undefined
      ? {}
      : { codemodekitVersion: options.codemodekitVersion }),
    ...(options.createCodemodekitVersion === undefined
      ? {}
      : { createCodemodekitVersion: options.createCodemodekitVersion }),
    ...(options.agentPlugin
      ? {
          agentPlugin: {
            sync: options.sync && options.install,
            ...(options.pluginName === undefined
              ? {}
              : { pluginName: options.pluginName }),
            ...(options.skillName === undefined
              ? {}
              : { skillName: options.skillName }),
            ...(options.pluginDescription === undefined
              ? {}
              : { description: options.pluginDescription }),
            ...(options.pluginLicense === undefined
              ? {}
              : { license: options.pluginLicense }),
          },
        }
      : {}),
  });

  const pluginSummary =
    result.agentPlugin === undefined
      ? ""
      : `Agent Plugin: ${result.agentPlugin.built ? "built" : "scaffolded"} (${result.agentPlugin.skillName})\n` +
        `${result.agentPlugin.synced ? "Catalog: synchronized\n" : "Catalog: pending\n"}` +
        `${result.agentPlugin.syncError === undefined ? "" : `Catalog sync pending: ${result.agentPlugin.syncError}\n`}` +
        `${result.agentPlugin.synced ? "" : "  npm run plugin:sync\n"}` +
        `${result.agentPlugin.built ? "" : "  npm run plugin:build\n"}` +
        "  npm run plugin:install:cursor\n";
  const sourceName = options.source.type === "weather" ? "weather" : options.source.name;
  (runtime.write ?? process.stdout.write.bind(process.stdout))(
    `\nCreated ${options.serverName ?? `${sourceName}-code-mode`} in ${result.directory}\n\n` +
      `${result.installed ? "" : "  npm install\n"}  npm start\n\n` +
      `${result.authoringSkillDirectories === undefined ? "" : "Authoring skills: .agents/skills/build-codemodekit-server, .agents/skills/author-codemode-skill\n"}` +
      pluginSummary +
      `Tool policy: ${options.policy}\n`,
  );
}

function parseOptions(args: readonly string[]): CliDraft {
  let targetDirectory: string | undefined;
  let mcpName: string | undefined;
  let mcpCommand: string | undefined;
  let mcpUrl: string | undefined;
  let example: "weather" | undefined;
  let serverName: string | undefined;
  let pluginName: string | undefined;
  let skillName: string | undefined;
  let pluginDescription: string | undefined;
  let pluginLicense: string | undefined;
  let policy: "allow-all" | "deny-all" | undefined;
  let agentPlugin: boolean | undefined;
  let authoringSkill = true;
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
      if (agentPlugin === false) {
        throw new TypeError("Use either --agent-plugin or --no-agent-plugin");
      }
      agentPlugin = true;
      continue;
    }
    if (argument === "--no-agent-plugin") {
      if (agentPlugin === true) {
        throw new TypeError("Use either --agent-plugin or --no-agent-plugin");
      }
      agentPlugin = false;
      continue;
    }
    if (argument === "--no-authoring-skill") {
      authoringSkill = false;
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
      case "--example":
        if (value !== "weather") {
          throw new TypeError("--example currently supports only weather");
        }
        example = value;
        break;
      case "--mcp-name":
        mcpName = value;
        break;
      case "--mcp-command":
        mcpCommand = value;
        break;
      case "--mcp-url":
        mcpUrl = value;
        break;
      case "--server-name":
        serverName = value;
        break;
      case "--plugin-name":
        pluginName = value;
        break;
      case "--skill-name":
        skillName = value;
        break;
      case "--plugin-description":
        pluginDescription = value;
        break;
      case "--plugin-license":
        pluginLicense = value;
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

  if (
    example !== undefined &&
    [mcpName, mcpCommand, mcpUrl].some((value) => value !== undefined)
  ) {
    throw new TypeError("--example cannot be combined with MCP source flags");
  }
  if (mcpCommand !== undefined && mcpUrl !== undefined) {
    throw new TypeError("Use either --mcp-command or --mcp-url");
  }
  if (
    agentPlugin === false &&
    [pluginName, skillName, pluginDescription, pluginLicense].some(
      (value) => value !== undefined,
    )
  ) {
    throw new TypeError("Plugin metadata options require --agent-plugin");
  }

  return {
    ...(targetDirectory === undefined ? {} : { targetDirectory }),
    ...(mcpName === undefined ? {} : { mcpName }),
    ...(mcpCommand === undefined ? {} : { mcpCommand }),
    ...(mcpUrl === undefined ? {} : { mcpUrl }),
    ...(example === undefined ? {} : { example }),
    ...(serverName === undefined ? {} : { serverName }),
    ...(pluginName === undefined ? {} : { pluginName }),
    ...(skillName === undefined ? {} : { skillName }),
    ...(pluginDescription === undefined ? {} : { pluginDescription }),
    ...(pluginLicense === undefined ? {} : { pluginLicense }),
    ...(policy === undefined ? {} : { policy }),
    ...(agentPlugin === undefined ? {} : { agentPlugin }),
    authoringSkill,
    sync,
    install,
    ...(codemodekitVersion === undefined ? {} : { codemodekitVersion }),
    ...(createCodemodekitVersion === undefined
      ? {}
      : { createCodemodekitVersion }),
  };
}

function requiresPrompt(draft: CliDraft): boolean {
  if (draft.targetDirectory === undefined) return true;
  if (draft.example !== undefined) return false;
  if (draft.mcpCommand === undefined && draft.mcpUrl === undefined) return true;
  return draft.mcpName === undefined;
}

async function completeOptions(
  draft: CliDraft,
  prompter: CliPrompter | undefined,
): Promise<CliOptions> {
  const targetDirectory =
    draft.targetDirectory ??
    (await requiredInput(prompter, "Project directory", "weather-code-mode"));
  let source: ScaffoldSource;
  if (draft.example === "weather") {
    source = { type: "weather" };
  } else if (draft.mcpCommand !== undefined) {
    source = {
      type: "mcp-stdio",
      name:
        draft.mcpName ??
        (await requiredInput(prompter, "Tool source name", "upstream")),
      command: parseMcpCommand(draft.mcpCommand),
    };
  } else if (draft.mcpUrl !== undefined) {
    source = {
      type: "mcp-http",
      name:
        draft.mcpName ??
        (await requiredInput(prompter, "Tool source name", "upstream")),
      url: draft.mcpUrl,
    };
  } else {
    if (prompter === undefined) throw new TypeError("A tool source is required");
    const starter = await prompter.select(
      "What would you like to connect?",
      [
        { label: "Weather starter", value: "weather" },
        { label: "MCP command", value: "mcp-command" },
        { label: "Remote MCP URL", value: "mcp-url" },
      ] as const,
      "weather",
    );
    if (starter === "weather") {
      source = { type: "weather" };
    } else {
      const name = await requiredInput(prompter, "Tool source name", "upstream");
      if (starter === "mcp-command") {
        source = {
          type: "mcp-stdio",
          name,
          command: parseMcpCommand(
            await requiredInput(prompter, "MCP command"),
          ),
        };
      } else {
        source = {
          type: "mcp-http",
          name,
          url: await requiredInput(prompter, "Remote MCP URL"),
        };
      }
    }
  }

  const interactive = prompter !== undefined;
  const agentPlugin =
    draft.agentPlugin ??
    (interactive
      ? await prompter.confirm("Generate an Agent Plugin?", true)
      : source.type === "weather");
  const policy =
    draft.policy ??
    (interactive
      ? await prompter.select(
          "Starting tool policy",
          [
            { label: "Allow all discovered tools", value: "allow-all" },
            { label: "Deny all until edited", value: "deny-all" },
          ] as const,
          "allow-all",
        )
      : "allow-all");

  if (
    !agentPlugin &&
    [
      draft.pluginName,
      draft.skillName,
      draft.pluginDescription,
      draft.pluginLicense,
    ].some((value) => value !== undefined)
  ) {
    throw new TypeError("Plugin metadata options require --agent-plugin");
  }

  return {
    targetDirectory,
    source,
    ...(draft.serverName === undefined ? {} : { serverName: draft.serverName }),
    ...(draft.pluginName === undefined ? {} : { pluginName: draft.pluginName }),
    ...(draft.skillName === undefined ? {} : { skillName: draft.skillName }),
    ...(draft.pluginDescription === undefined
      ? {}
      : { pluginDescription: draft.pluginDescription }),
    ...(draft.pluginLicense === undefined
      ? {}
      : { pluginLicense: draft.pluginLicense }),
    policy,
    agentPlugin,
    authoringSkill: draft.authoringSkill,
    sync: draft.sync,
    install: draft.install,
    ...(draft.codemodekitVersion === undefined
      ? {}
      : { codemodekitVersion: draft.codemodekitVersion }),
    ...(draft.createCodemodekitVersion === undefined
      ? {}
      : { createCodemodekitVersion: draft.createCodemodekitVersion }),
  };
}

function terminalPrompter(): CliPrompter | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return undefined;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return {
    input: async (message, defaultValue) => {
      const suffix = defaultValue === undefined ? ": " : ` (${defaultValue}): `;
      const answer = (await readline.question(`${message}${suffix}`)).trim();
      return answer === "" && defaultValue !== undefined ? defaultValue : answer;
    },
    select: async (message, choices, defaultValue) => {
      const defaultIndex = Math.max(
        0,
        choices.findIndex((choice) => choice.value === defaultValue),
      );
      const menu = choices
        .map((choice, index) => `  ${String(index + 1)}) ${choice.label}`)
        .join("\n");
      while (true) {
        const answer = (
          await readline.question(
            `${message}\n${menu}\nChoice (${String(defaultIndex + 1)}): `,
          )
        ).trim();
        const selected = answer === "" ? defaultIndex : Number(answer) - 1;
        const choice = choices[selected];
        if (choice !== undefined) return choice.value;
        process.stdout.write("Choose one of the listed numbers.\n");
      }
    },
    confirm: async (message, defaultValue) => {
      while (true) {
        const marker = defaultValue ? "Y/n" : "y/N";
        const answer = (await readline.question(`${message} (${marker}): `))
          .trim()
          .toLowerCase();
        if (answer === "") return defaultValue;
        if (answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
        process.stdout.write("Answer yes or no.\n");
      }
    },
    close: () => readline.close(),
  };
}

async function requiredInput(
  prompter: CliPrompter | undefined,
  message: string,
  defaultValue?: string,
): Promise<string> {
  if (prompter === undefined) throw new TypeError(`${message} is required`);
  while (true) {
    const value = (await prompter.input(message, defaultValue)).trim();
    if (value !== "") return value;
  }
}

function usage(): string {
  return `Create a batteries-included Code Mode MCP server.

Interactive:
  npm create codemodekit@latest

Weather starter:
  npm create codemodekit@latest weather-code-mode -- --example weather

MCP command:
  npm create codemodekit@latest my-code-mode -- \\
    --mcp-name <name> \\
    --mcp-command '<executable> [args...]'

Remote MCP:
  npm create codemodekit@latest my-code-mode -- \\
    --mcp-name <name> \\
    --mcp-url <https://example.com/mcp>

Options:
  --example weather          Generate the editable Open-Meteo Local Tools starter
  --mcp-name <name>          Name beneath tools.* for an MCP source
  --mcp-command <command>    Shell-free stdio MCP executable and arguments
  --mcp-url <url>            Streamable HTTP MCP endpoint
  --server-name <name>       Downstream MCP server name
  --policy allow-all         Allow every discovered tool (default)
  --policy deny-all          Deny every tool until policy is edited
  --agent-plugin             Generate a portable Agent Plugin
  --no-agent-plugin          Omit the Agent Plugin (weather includes it by default)
  --plugin-name <name>       Override the portable plugin name
  --skill-name <name>        Override the runtime companion skill name
  --plugin-description <s>   Override the plugin manifest description
  --plugin-license <SPDX>    Add a license identifier to plugin.json
  --no-authoring-skill       Omit both project-local CodeModeKit authoring skills
  --no-sync                  Do not snapshot tool types during Agent Plugin creation
  --no-install               Generate files without running npm install
  --codemodekit-version <v>  Override the generated runtime dependency
  --create-codemodekit-version <v>
                             Override the generated sync dependency
  -h, --help                 Show this help
`;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`create-codemodekit: ${message}\n\n${usage()}`);
    process.exitCode = 1;
  });
}
