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

interface CliMcpDraft {
  name?: string;
  command?: string;
  url?: string;
  bearerTokenEnv?: string;
  headerEnv: Record<string, string>;
}

interface CliDraft {
  readonly targetDirectory?: string;
  readonly mcpSources?: readonly CliMcpDraft[];
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
  | "mcpSources"
  | "example"
  | "policy"
  | "agentPlugin"
> {
  readonly targetDirectory: string;
  readonly sources: readonly ScaffoldSource[];
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
    sources: options.sources,
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
  const sourceName =
    options.sources.length === 1
      ? sourceDisplayName(options.sources[0] as ScaffoldSource)
      : "multi-source";
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
  const mcpSources: CliMcpDraft[] = [];
  let activeSource: CliMcpDraft | undefined;
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
        if (activeSource === undefined) {
          activeSource = { headerEnv: {} };
          mcpSources.push(activeSource);
        } else if (activeSource.name !== undefined) {
          if (activeSource.command === undefined && activeSource.url === undefined) {
            throw new TypeError("Each MCP source may have only one --mcp-name");
          }
          activeSource = { headerEnv: {} };
          mcpSources.push(activeSource);
        }
        activeSource.name = value;
        break;
      case "--mcp-command":
        activeSource ??= appendMcpDraft(mcpSources);
        if (activeSource.command !== undefined || activeSource.url !== undefined) {
          throw new TypeError("Begin each additional MCP source with --mcp-name");
        }
        activeSource.command = value;
        break;
      case "--mcp-url":
        activeSource ??= appendMcpDraft(mcpSources);
        if (activeSource.command !== undefined || activeSource.url !== undefined) {
          throw new TypeError("Begin each additional MCP source with --mcp-name");
        }
        activeSource.url = value;
        break;
      case "--mcp-bearer-env":
        activeSource ??= appendMcpDraft(mcpSources);
        activeSource.bearerTokenEnv = value;
        break;
      case "--mcp-header-env": {
        activeSource ??= appendMcpDraft(mcpSources);
        const separator = value.indexOf("=");
        if (separator <= 0 || separator === value.length - 1) {
          throw new TypeError("--mcp-header-env must be Header-Name=ENV_NAME");
        }
        activeSource.headerEnv[value.slice(0, separator)] = value.slice(separator + 1);
        break;
      }
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
    mcpSources.length > 0
  ) {
    throw new TypeError("--example cannot be combined with MCP source flags");
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
    ...(mcpSources.length === 0 ? {} : { mcpSources }),
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
  if (draft.mcpSources === undefined) return true;
  return draft.mcpSources.length === 1 && !isCompleteMcpDraft(draft.mcpSources[0]);
}

function appendMcpDraft(drafts: CliMcpDraft[]): CliMcpDraft {
  const draft: CliMcpDraft = { headerEnv: {} };
  drafts.push(draft);
  return draft;
}

function isCompleteMcpDraft(
  draft: CliMcpDraft | undefined,
): draft is CliMcpDraft {
  return (
    draft !== undefined &&
    draft.name !== undefined &&
    (draft.command !== undefined || draft.url !== undefined)
  );
}

function sourceDisplayName(source: ScaffoldSource): string {
  return source.type === "weather" ? "weather" : source.name;
}

async function completeOptions(
  draft: CliDraft,
  prompter: CliPrompter | undefined,
): Promise<CliOptions> {
  const targetDirectory =
    draft.targetDirectory ??
    (await requiredInput(prompter, "Project directory", "weather-code-mode"));
  let sources: readonly ScaffoldSource[];
  if (draft.example === "weather") {
    sources = [{ type: "weather" }];
  } else if (draft.mcpSources !== undefined) {
    if (draft.mcpSources.length > 1 && draft.mcpSources.some((source) => !isCompleteMcpDraft(source))) {
      throw new TypeError("Every repeated MCP source requires --mcp-name and either --mcp-command or --mcp-url");
    }
    const sourceDrafts = [...draft.mcpSources];
    const onlySource = sourceDrafts[0];
    if (
      sourceDrafts.length === 1 &&
      onlySource !== undefined &&
      onlySource.command === undefined &&
      onlySource.url === undefined
    ) {
      if (prompter === undefined) {
        throw new TypeError(
          "Each MCP source requires --mcp-command or --mcp-url",
        );
      }
      const transport = await prompter.select(
        "How should the MCP source connect?",
        [
          { label: "MCP command", value: "mcp-command" },
          { label: "Remote MCP URL", value: "mcp-url" },
        ] as const,
        onlySource.bearerTokenEnv !== undefined ||
          Object.keys(onlySource.headerEnv).length > 0
          ? "mcp-url"
          : "mcp-command",
      );
      sourceDrafts[0] =
        transport === "mcp-command"
          ? {
              ...onlySource,
              command: await requiredInput(prompter, "MCP command"),
            }
          : {
              ...onlySource,
              url: await requiredInput(prompter, "Remote MCP URL"),
            };
    }
    sources = await Promise.all(
      sourceDrafts.map(async (source): Promise<ScaffoldSource> => {
        const name =
          source.name ??
          (await requiredInput(prompter, "Tool source name", "upstream"));
        if (source.command !== undefined) {
          if (source.bearerTokenEnv !== undefined || Object.keys(source.headerEnv).length > 0) {
            throw new TypeError("HTTP authentication flags require --mcp-url");
          }
          return { type: "mcp-stdio", name, command: parseMcpCommand(source.command) };
        }
        if (source.url !== undefined) {
          return {
            type: "mcp-http",
            name,
            url: source.url,
            ...(source.bearerTokenEnv === undefined
              ? {}
              : { bearerTokenEnv: source.bearerTokenEnv }),
            ...(Object.keys(source.headerEnv).length === 0
              ? {}
              : { headerEnv: source.headerEnv }),
          };
        }
        throw new TypeError("Each MCP source requires --mcp-command or --mcp-url");
      }),
    );
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
      sources = [{ type: "weather" }];
    } else {
      const name = await requiredInput(prompter, "Tool source name", "upstream");
      if (starter === "mcp-command") {
        sources = [{
          type: "mcp-stdio",
          name,
          command: parseMcpCommand(
            await requiredInput(prompter, "MCP command"),
          ),
        }];
      } else {
        sources = [{
          type: "mcp-http",
          name,
          url: await requiredInput(prompter, "Remote MCP URL"),
        }];
      }
    }
  }

  const interactive = prompter !== undefined;
  const agentPlugin =
    draft.agentPlugin ??
    (interactive
      ? await prompter.confirm("Generate an Agent Plugin?", true)
      : sources.length === 1 && sources[0]?.type === "weather");
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
    sources,
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
    --mcp-url <https://example.com/mcp> \\
    --mcp-bearer-env MCP_TOKEN

Multiple sources (repeat a complete group):
  npm create codemodekit@latest my-code-mode -- \\
    --mcp-name github --mcp-command 'docker run ...' \\
    --mcp-name tickets --mcp-url https://example.com/mcp \\
    --mcp-header-env X-Tenant-ID=TICKETS_TENANT

Options:
  --example weather          Generate the editable Open-Meteo Local Tools starter
  --mcp-name <name>          Begin a source group and name it beneath tools.*
  --mcp-command <command>    Shell-free stdio MCP executable and arguments
  --mcp-url <url>            Streamable HTTP MCP endpoint
  --mcp-bearer-env <ENV>     Read an HTTP bearer token from ENV at runtime
  --mcp-header-env <H=ENV>   Read HTTP header H from ENV; may be repeated
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
