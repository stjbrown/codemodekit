import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { buildAgentPlugin, type BuildAgentPluginResult } from "./plugin-build.js";

const INSTALL_MARKER = ".codemodekit-install.json";

export interface InstallCursorPluginOptions {
  readonly root: string;
  readonly cursorHome?: string;
  readonly nodePath?: string;
}

export interface CursorPluginInstallation {
  readonly pluginName: string;
  readonly destination: string;
  readonly artifactDirectory: string;
  readonly nodePath: string;
}

export interface CursorPluginStatusOptions {
  readonly root: string;
  readonly cursorHome?: string;
}

export interface CursorPluginStatus {
  readonly pluginName: string;
  readonly destination: string;
  readonly installed: boolean;
}

/** Builds and installs a concrete copy under Cursor's local plugin directory. */
export async function installCursorPlugin(
  options: InstallCursorPluginOptions,
): Promise<CursorPluginInstallation> {
  const root = path.resolve(options.root);
  const build = await buildAgentPlugin({ root });
  const pluginName = await readPluginName(build.artifactDirectory);
  const nodePath = path.resolve(options.nodePath ?? process.execPath);
  await assertRegularFile(nodePath, "Node executable");

  const localRoot = cursorLocalPluginRoot(options.cursorHome);
  const destination = path.join(localRoot, pluginName);
  const staging = path.join(
    localRoot,
    `.${pluginName}.${String(process.pid)}.${String(Date.now())}.tmp`,
  );
  const backup = `${destination}.${String(process.pid)}.backup`;

  await mkdir(localRoot, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await cp(build.artifactDirectory, staging, { recursive: true });

  try {
    await adaptCursorMcpConfig(staging, destination, nodePath);
    await writeJson(path.join(staging, INSTALL_MARKER), {
      schemaVersion: 1,
      pluginName,
      sourceRoot: root,
      artifactDirectory: build.artifactDirectory,
      nodePath,
    });
    await replaceInstallation({ destination, staging, backup, pluginName });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    pluginName,
    destination,
    artifactDirectory: build.artifactDirectory,
    nodePath,
  };
}

export async function getCursorPluginStatus(
  options: CursorPluginStatusOptions,
): Promise<CursorPluginStatus> {
  const root = path.resolve(options.root);
  const pluginName = await readPluginName(root);
  const destination = path.join(
    cursorLocalPluginRoot(options.cursorHome),
    pluginName,
  );
  return {
    pluginName,
    destination,
    installed: await pathExists(destination),
  };
}

export async function uninstallCursorPlugin(
  options: CursorPluginStatusOptions,
): Promise<CursorPluginStatus> {
  const status = await getCursorPluginStatus(options);
  if (!status.installed) return status;
  await assertMatchingInstalledPlugin(status.destination, status.pluginName);
  await rm(status.destination, { recursive: true, force: true });
  return { ...status, installed: false };
}

async function adaptCursorMcpConfig(
  staging: string,
  destination: string,
  nodePath: string,
): Promise<void> {
  const file = path.join(staging, "mcp.json");
  const config = await readJsonObject(file, "mcp.json");
  const rawServers = config.mcpServers;
  if (!isRecord(rawServers)) {
    throw new TypeError("mcp.json must contain an mcpServers object");
  }
  const stdioEntries = Object.entries(rawServers).filter(
    ([, value]) => isRecord(value) && value.type === "stdio",
  );
  if (stdioEntries.length !== 1) {
    throw new TypeError("Cursor installation currently requires one stdio server");
  }
  const entry = stdioEntries[0];
  if (entry === undefined || !isRecord(entry[1])) {
    throw new TypeError("Cursor installation could not resolve the stdio server");
  }
  const [serverName, server] = entry;
  const { cwd: _cwd, ...serverWithoutCwd } = server;
  await writeJson(file, {
    ...config,
    mcpServers: {
      ...rawServers,
      [serverName]: {
        ...serverWithoutCwd,
        type: "stdio",
        command: nodePath,
        args: [path.join(destination, "server.mjs")],
      },
    },
  });
}

async function replaceInstallation(options: {
  readonly destination: string;
  readonly staging: string;
  readonly backup: string;
  readonly pluginName: string;
}): Promise<void> {
  const existing = await pathExists(options.destination);
  if (!existing) {
    await rename(options.staging, options.destination);
    return;
  }

  await assertMatchingInstalledPlugin(options.destination, options.pluginName);
  await rm(options.backup, { recursive: true, force: true });
  await rename(options.destination, options.backup);
  try {
    await rename(options.staging, options.destination);
    await rm(options.backup, { recursive: true, force: true });
  } catch (error) {
    if (!(await pathExists(options.destination))) {
      await rename(options.backup, options.destination);
    }
    throw error;
  }
}

async function assertMatchingInstalledPlugin(
  destination: string,
  expectedName: string,
): Promise<void> {
  const actualName = await readPluginName(destination);
  if (actualName !== expectedName) {
    throw new Error(
      `Refusing to replace Cursor plugin ${destination}; expected ${expectedName}, found ${actualName}`,
    );
  }
}

async function readPluginName(root: string): Promise<string> {
  const manifest = await readJsonObject(path.join(root, "plugin.json"), "plugin.json");
  const name = manifest.name;
  if (
    typeof name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ||
    path.basename(name) !== name
  ) {
    throw new TypeError("plugin.json contains an invalid portable plugin name");
  }
  return name;
}

function cursorLocalPluginRoot(cursorHome: string | undefined): string {
  const home = path.resolve(cursorHome ?? path.join(homedir(), ".cursor"));
  return path.join(home, "plugins", "local");
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function assertRegularFile(file: string, label: string): Promise<void> {
  let details;
  try {
    details = await lstat(file);
  } catch (error) {
    throw new TypeError(`${label} does not exist: ${file}`, { cause: error });
  }
  if (!details.isFile() && !details.isSymbolicLink()) {
    throw new TypeError(`${label} must be a file: ${file}`);
  }
}

async function readJsonObject(
  file: string,
  label: string,
): Promise<Readonly<Record<string, unknown>>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new TypeError(`Could not read ${label}`, { cause: error });
  }
  if (!isRecord(value)) {
    throw new TypeError(`${label} must contain a JSON object`);
  }
  return value;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
