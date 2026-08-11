import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ParsedCommand } from "./command.js";

export interface ScaffoldCodeModeMcpOptions {
  readonly targetDirectory: string;
  readonly mcpName: string;
  readonly mcpCommand: ParsedCommand;
  readonly serverName?: string;
  readonly packageName?: string;
  readonly policy?: "allow-all" | "deny-all";
  readonly install?: boolean;
  readonly cwd?: string;
}

export interface ScaffoldResult {
  readonly directory: string;
  readonly entrypoint: string;
  readonly installed: boolean;
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

  await ensureEmptyDirectory(directory);
  await mkdir(path.join(directory, "src"), { recursive: true });

  const packageJson = {
    name: packageName,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: { node: ">=20" },
    scripts: { start: "node src/server.mjs" },
    dependencies: { "codemodekit": "^0.1.0" },
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
      }),
      "utf8",
    ),
  ]);

  if (options.install === true) {
    await runNpmInstall(directory);
  }

  return { directory, entrypoint, installed: options.install === true };
}

interface RenderServerOptions {
  readonly serverName: string;
  readonly mcpName: string;
  readonly mcpCommand: ParsedCommand;
  readonly policy: "allow-all" | "deny-all";
}

export function renderServer(options: RenderServerOptions): string {
  const policyFactory =
    options.policy === "allow-all" ? "allowAllToolCalls" : "denyAllToolCalls";
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
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install"], {
      cwd: directory,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `npm install failed${signal === null ? ` with exit code ${String(code)}` : ` from signal ${signal}`}`,
        ),
      );
    });
  });
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
