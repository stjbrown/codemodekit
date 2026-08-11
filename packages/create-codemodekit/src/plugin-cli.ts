#!/usr/bin/env node
import path from "node:path";

import {
  getCursorPluginStatus,
  installCursorPlugin,
  uninstallCursorPlugin,
} from "./cursor-plugin.js";
import { buildAgentPlugin } from "./plugin-build.js";

interface ParsedOptions {
  readonly command: "build" | "install" | "status" | "uninstall";
  readonly target?: "cursor";
  readonly root: string;
  readonly cursorHome?: string;
}

export async function runPluginCli(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const options = parseOptions(args);
  if (options.command === "build") {
    const result = await buildAgentPlugin({ root: options.root });
    process.stdout.write(
      `Built portable Agent Plugin at ${result.artifactDirectory} (${String(result.bytes)} bytes)\n`,
    );
    return;
  }
  if (options.target !== "cursor") {
    throw new TypeError(`${options.command} requires the cursor target`);
  }
  if (options.command === "install") {
    const result = await installCursorPlugin({
      root: options.root,
      ...(options.cursorHome === undefined ? {} : { cursorHome: options.cursorHome }),
    });
    process.stdout.write(
      `Installed ${result.pluginName} for Cursor at ${result.destination}\n` +
        "Reload Cursor with Developer: Reload Window.\n",
    );
    return;
  }
  if (options.command === "status") {
    const result = await getCursorPluginStatus({
      root: options.root,
      ...(options.cursorHome === undefined ? {} : { cursorHome: options.cursorHome }),
    });
    process.stdout.write(
      `${result.pluginName}: ${result.installed ? "installed" : "not installed"} (${result.destination})\n`,
    );
    return;
  }
  const result = await uninstallCursorPlugin({
    root: options.root,
    ...(options.cursorHome === undefined ? {} : { cursorHome: options.cursorHome }),
  });
  process.stdout.write(
    `${result.pluginName}: ${result.installed ? "installed" : "uninstalled"} (${result.destination})\n`,
  );
}

function parseOptions(args: readonly string[]): ParsedOptions {
  const positional: string[] = [];
  let root = process.cwd();
  let cursorHome: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new TypeError(`Missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--root") {
      root = path.resolve(value);
    } else if (argument === "--cursor-home") {
      cursorHome = path.resolve(value);
    } else {
      throw new TypeError(`Unknown option: ${argument}`);
    }
  }

  const command = positional[0];
  if (
    command !== "build" &&
    command !== "install" &&
    command !== "status" &&
    command !== "uninstall"
  ) {
    throw new TypeError("Expected build, install cursor, status cursor, or uninstall cursor");
  }
  const target = positional[1];
  if (positional.length > 2 || (target !== undefined && target !== "cursor")) {
    throw new TypeError(`Unexpected plugin command: ${positional.join(" ")}`);
  }
  return {
    command,
    ...(target === undefined ? {} : { target }),
    root,
    ...(cursorHome === undefined ? {} : { cursorHome }),
  };
}

function usage(): string {
  return `Build and install a generated CodeModeKit Agent Plugin.

Usage:
  codemodekit-plugin build [--root <directory>]
  codemodekit-plugin install cursor [--root <directory>] [--cursor-home <directory>]
  codemodekit-plugin status cursor [--root <directory>] [--cursor-home <directory>]
  codemodekit-plugin uninstall cursor [--root <directory>] [--cursor-home <directory>]
`;
}

runPluginCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codemodekit-plugin: ${message}\n\n${usage()}`);
  process.exitCode = 1;
});
