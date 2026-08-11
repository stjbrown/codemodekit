import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const DEFAULT_ENTRYPOINT = "src/server.mjs";
const DEFAULT_ARTIFACT_DIRECTORY = "dist/plugin";
const ARTIFACT_ENTRYPOINT = "server.mjs";

export interface BuildAgentPluginOptions {
  readonly root: string;
  readonly entrypoint?: string;
  readonly artifactDirectory?: string;
  readonly serverName?: string;
}

export interface BuildAgentPluginResult {
  readonly root: string;
  readonly artifactDirectory: string;
  readonly entrypoint: string;
  readonly server: string;
  readonly bytes: number;
}

/**
 * Bundles a generated CodeModeKit server and copies its portable Agent Plugin
 * components into a dependency-free distribution directory.
 */
export async function buildAgentPlugin(
  options: BuildAgentPluginOptions,
): Promise<BuildAgentPluginResult> {
  const root = path.resolve(options.root);
  const entrypoint = resolveContainedPath(
    root,
    options.entrypoint ?? DEFAULT_ENTRYPOINT,
    "Plugin entrypoint",
  );
  const artifactDirectory = resolveContainedPath(
    root,
    options.artifactDirectory ?? DEFAULT_ARTIFACT_DIRECTORY,
    "Plugin artifact directory",
  );
  const artifactParent = path.dirname(artifactDirectory);
  const stagingDirectory = path.join(
    artifactParent,
    `.${path.basename(artifactDirectory)}.${String(process.pid)}.${String(Date.now())}.tmp`,
  );
  const server = path.join(stagingDirectory, ARTIFACT_ENTRYPOINT);

  await assertRegularFile(entrypoint, "Plugin entrypoint");
  await mkdir(artifactParent, { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });

  try {
    const buildResult = await build({
      entryPoints: [entrypoint],
      outfile: server,
      absWorkingDir: root,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      external: ["create-codemodekit"],
      banner: {
        js: [
          'import { createRequire as __createRequire } from "node:module";',
          'import { fileURLToPath as __fileURLToPath } from "node:url";',
          'import { dirname as __pathDirname } from "node:path";',
          "const require = __createRequire(import.meta.url);",
          "const __filename = __fileURLToPath(import.meta.url);",
          "const __dirname = __pathDirname(__filename);",
        ].join("\n"),
      },
      legalComments: "none",
      logLevel: "silent",
      metafile: true,
    });

    const [manifest, mcpConfig] = await Promise.all([
      readJsonObject(path.join(root, "plugin.json"), "plugin.json"),
      readJsonObject(path.join(root, "mcp.json"), "mcp.json"),
    ]);
    const portableMcpConfig = projectArtifactMcpConfig(
      mcpConfig,
      options.serverName,
    );
    const quickJsWasm = resolveQuickJsReleaseWasm(
      root,
      Object.keys(buildResult.metafile.inputs),
    );

    await Promise.all([
      writeJson(path.join(stagingDirectory, "plugin.json"), manifest),
      writeJson(path.join(stagingDirectory, "mcp.json"), portableMcpConfig),
      cp(quickJsWasm, path.join(stagingDirectory, "emscripten-module.wasm")),
      copyIfPresent(root, stagingDirectory, "skills"),
      copyIfPresent(root, stagingDirectory, "assets"),
      copyIfPresent(root, stagingDirectory, "README.md"),
      copyIfPresent(root, stagingDirectory, "LICENSE"),
    ]);

    await rm(artifactDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, artifactDirectory);

    const output = buildResult.metafile.outputs[path.resolve(server)];
    const serverBytes =
      output?.bytes ??
      (await stat(path.join(artifactDirectory, ARTIFACT_ENTRYPOINT))).size;
    const wasmBytes = (
      await stat(path.join(artifactDirectory, "emscripten-module.wasm"))
    ).size;
    return {
      root,
      artifactDirectory,
      entrypoint,
      server: path.join(artifactDirectory, ARTIFACT_ENTRYPOINT),
      bytes: serverBytes + wasmBytes,
    };
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function resolveQuickJsReleaseWasm(
  root: string,
  buildInputs: readonly string[],
): string {
  const moduleInput = buildInputs.find((input) => {
    const normalized = input.replaceAll("\\", "/");
    return (
      normalized.includes("quickjs-wasmfile-release-sync") &&
      normalized.endsWith("/emscripten-module.mjs")
    );
  });
  if (moduleInput === undefined) {
    throw new Error("Could not locate the bundled QuickJS release WASM module");
  }
  return path.join(path.dirname(path.resolve(root, moduleInput)), "emscripten-module.wasm");
}

function projectArtifactMcpConfig(
  config: Readonly<Record<string, unknown>>,
  requestedServerName: string | undefined,
): Readonly<Record<string, unknown>> {
  const rawServers = config.mcpServers;
  if (!isRecord(rawServers)) {
    throw new TypeError("mcp.json must contain an mcpServers object");
  }

  const stdioNames = Object.entries(rawServers)
    .filter(([, value]) => isRecord(value) && value.type === "stdio")
    .map(([name]) => name);
  const serverName =
    requestedServerName ??
    (stdioNames.length === 1 ? stdioNames[0] : undefined);
  if (serverName === undefined || !stdioNames.includes(serverName)) {
    throw new TypeError(
      "Agent Plugin build requires exactly one stdio server or an explicit serverName",
    );
  }

  const sourceServer = rawServers[serverName];
  if (!isRecord(sourceServer)) {
    throw new TypeError(`Invalid MCP server entry: ${serverName}`);
  }
  const { cwd: _cwd, ...serverWithoutCwd } = sourceServer;
  return {
    ...config,
    mcpServers: {
      ...rawServers,
      [serverName]: {
        ...serverWithoutCwd,
        type: "stdio",
        command: "node",
        args: [`\${PLUGIN_ROOT}/${ARTIFACT_ENTRYPOINT}`],
      },
    },
  };
}

async function copyIfPresent(
  root: string,
  destinationRoot: string,
  name: string,
): Promise<void> {
  const source = path.join(root, name);
  try {
    await stat(source);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await cp(source, path.join(destinationRoot, name), { recursive: true });
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

async function assertRegularFile(file: string, label: string): Promise<void> {
  let details;
  try {
    details = await stat(file);
  } catch (error) {
    throw new TypeError(`${label} does not exist: ${file}`, { cause: error });
  }
  if (!details.isFile()) {
    throw new TypeError(`${label} must be a file: ${file}`);
  }
}

function resolveContainedPath(root: string, value: string, label: string): string {
  const resolved = path.resolve(root, value);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new TypeError(`${label} must stay within the project root`);
  }
  return resolved;
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
