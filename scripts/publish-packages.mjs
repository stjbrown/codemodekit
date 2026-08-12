#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const packageDirectories = [
  "core",
  "mcp",
  "sandbox-quickjs",
  "codemodekit",
  "skills",
  "create-codemodekit",
];

if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error(
    "Package publishing is restricted to the trusted GitHub Actions release workflow",
  );
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codemodekit-release-"));
const packDirectory = path.join(temporaryRoot, "packs");
await mkdir(packDirectory, { recursive: true });
let publishedCount = 0;

try {
  for (const directoryName of packageDirectories) {
    const packageDirectory = path.join(
      workspaceRoot,
      "packages",
      directoryName,
    );
    const manifest = JSON.parse(
      await readFile(path.join(packageDirectory, "package.json"), "utf8"),
    );
    const specifier = `${manifest.name}@${manifest.version}`;
    if (await isPublished(specifier)) {
      process.stdout.write(`Skipping ${specifier}; it is already published.\n`);
      continue;
    }

    const { stdout } = await run(
      pnpm,
      ["pack", "--json", "--pack-destination", packDirectory],
      packageDirectory,
    );
    const packed = JSON.parse(stdout);
    if (packed.name !== manifest.name || packed.version !== manifest.version) {
      throw new Error(`Unexpected pack result for ${specifier}`);
    }
    const publication = await run(
      "npm",
      ["publish", packed.filename, "--access", "public"],
      workspaceRoot,
    );
    process.stdout.write(publication.stdout);
    process.stderr.write(publication.stderr);
    publishedCount += 1;
    process.stdout.write(`Published ${specifier}.\n`);
  }

  if (publishedCount === 0) {
    throw new Error(
      "No unpublished package versions were found; bump at least one package before releasing",
    );
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function isPublished(specifier) {
  try {
    await run("npm", ["view", specifier, "version", "--json"], workspaceRoot);
    return true;
  } catch (error) {
    const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    if (/E404|404 Not Found|is not in this registry/u.test(output)) return false;
    throw error;
  }
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
