#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = path.join(
  workspaceRoot,
  "tests",
  "fixtures",
  "mcp-stdio-server.mjs",
);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const packages = [
  ["@codemodekit/core", "core"],
  ["@codemodekit/mcp", "mcp"],
  ["@codemodekit/sandbox-quickjs", "sandbox-quickjs"],
  ["codemodekit", "codemodekit"],
  ["create-codemodekit", "create-codemodekit"],
];

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "codemodekit-package-smoke-"),
);
let client;

try {
  await run(pnpm, ["run", "build"], workspaceRoot);

  const packDirectory = path.join(temporaryRoot, "packs");
  await mkdir(packDirectory, { recursive: true });
  const tarballs = new Map();
  for (const [packageName, directoryName] of packages) {
    const { stdout } = await run(
      pnpm,
      ["pack", "--json", "--pack-destination", packDirectory],
      path.join(workspaceRoot, "packages", directoryName),
    );
    const packed = JSON.parse(stdout);
    if (packed.name !== packageName || typeof packed.filename !== "string") {
      throw new Error(`Unexpected pack result for ${packageName}`);
    }
    await assertPackedPackage(packed.filename, packageName);
    tarballs.set(packageName, packed.filename);
  }

  const createTarball = requiredTarball(tarballs, "create-codemodekit");
  const extractedCreate = path.join(temporaryRoot, "create-package");
  await mkdir(extractedCreate, { recursive: true });
  await run("tar", ["-xzf", createTarball, "-C", extractedCreate], temporaryRoot);

  const project = path.join(temporaryRoot, "generated-plugin");
  const upstreamCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)}`;
  await run(
    process.execPath,
    [
      path.join(extractedCreate, "package", "dist", "cli.js"),
      project,
      "--mcp-name",
      "fixture",
      "--mcp-command",
      upstreamCommand,
      "--server-name",
      "package-smoke",
      "--agent-plugin",
      "--no-install",
      "--no-sync",
      "--codemodekit-version",
      `file:${requiredTarball(tarballs, "codemodekit")}`,
      "--create-codemodekit-version",
      `file:${createTarball}`,
    ],
    temporaryRoot,
  );

  const packageJsonPath = path.join(project, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.dependencies = {
    codemodekit: `file:${requiredTarball(tarballs, "codemodekit")}`,
    "@codemodekit/core": `file:${requiredTarball(tarballs, "@codemodekit/core")}`,
    "@codemodekit/mcp": `file:${requiredTarball(tarballs, "@codemodekit/mcp")}`,
    "@codemodekit/sandbox-quickjs": `file:${requiredTarball(
      tarballs,
      "@codemodekit/sandbox-quickjs",
    )}`,
  };
  packageJson.devDependencies = {
    "create-codemodekit": `file:${createTarball}`,
  };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(project, "pnpm-workspace.yaml"),
    [
      "overrides:",
      `  \"@codemodekit/core\": \"file:${requiredTarball(tarballs, "@codemodekit/core")}\"`,
      `  \"@codemodekit/mcp\": \"file:${requiredTarball(tarballs, "@codemodekit/mcp")}\"`,
      `  \"@codemodekit/sandbox-quickjs\": \"file:${requiredTarball(
        tarballs,
        "@codemodekit/sandbox-quickjs",
      )}\"`,
      "allowBuilds:",
      "  esbuild: true",
      "",
    ].join("\n"),
    "utf8",
  );

  await run(
    pnpm,
    ["install", "--prefer-offline", "--config.confirmModulesPurge=false"],
    project,
  );
  await run(pnpm, ["run", "plugin:sync"], project);
  await run(pnpm, ["run", "plugin:build"], project);

  const artifact = path.join(project, "dist", "plugin");
  const server = path.join(artifact, "server.mjs");
  const wasm = path.join(artifact, "emscripten-module.wasm");
  if (!(await lstat(server)).isFile() || !(await lstat(wasm)).isFile()) {
    throw new Error("The packed packages did not produce a runnable plugin artifact");
  }
  await expectMissing(path.join(artifact, "node_modules"));
  await expectMissing(path.join(artifact, ".env"));

  client = new Client(
    { name: "package-smoke-client", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: "auto",
        probe: { timeoutMs: 5_000, maxRetries: 0 },
      },
      inputRequired: { autoFulfill: false },
    },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      cwd: temporaryRoot,
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    }),
    { timeout: 10_000 },
  );
  const execution = await client.callTool({
    name: "run_typescript",
    arguments: {
      code: `
        const result = await tools.fixture.echo({ value: "packed" });
        return result.structuredContent.value;
      `,
    },
  });
  if (
    execution.structuredContent?.ok !== true ||
    execution.structuredContent?.value !== "packed"
  ) {
    throw new Error(
      `Unexpected packed plugin result: ${JSON.stringify(execution.structuredContent)}`,
    );
  }

  process.stdout.write(
    "Package smoke passed: five tarballs scaffolded, built, and ran a portable plugin.\n",
  );
} finally {
  await client?.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function assertPackedPackage(tarball, expectedName) {
  const { stdout: manifestSource } = await run(
    "tar",
    ["-xOf", tarball, "package/package.json"],
    temporaryRoot,
  );
  const manifest = JSON.parse(manifestSource);
  if (manifest.name !== expectedName) {
    throw new Error(`Packed manifest name mismatch for ${expectedName}`);
  }
  if (manifestSource.includes("workspace:")) {
    throw new Error(`Packed manifest still contains workspace ranges: ${expectedName}`);
  }
  const { stdout: listing } = await run("tar", ["-tf", tarball], temporaryRoot);
  if (!listing.split("\n").includes("package/dist/index.js")) {
    throw new Error(`Packed package is missing dist/index.js: ${expectedName}`);
  }
  if (expectedName === "create-codemodekit") {
    for (const executable of ["cli.js", "plugin-cli.js"]) {
      if (!listing.split("\n").includes(`package/dist/${executable}`)) {
        throw new Error(`Packed generator is missing dist/${executable}`);
      }
    }
    if (
      !listing
        .split("\n")
        .includes("package/skills/build-codemodekit-plugin/SKILL.md")
    ) {
      throw new Error("Packed generator is missing the project authoring skill");
    }
  }
}

function requiredTarball(tarballs, packageName) {
  const tarball = tarballs.get(packageName);
  if (tarball === undefined) throw new Error(`Missing tarball for ${packageName}`);
  return tarball;
}

async function expectMissing(file) {
  try {
    await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Unexpected path in portable artifact: ${file}`);
}

async function run(command, args, cwd) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (error) {
    if (error && typeof error === "object") {
      const stdout = "stdout" in error ? String(error.stdout ?? "") : "";
      const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
      error.message = `${error.message}\n${stdout}${stderr}`.trim();
    }
    throw error;
  }
}
