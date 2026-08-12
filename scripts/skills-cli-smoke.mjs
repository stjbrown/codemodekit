#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const source = process.env.CODEMODEKIT_SKILLS_SOURCE ?? workspaceRoot;
const cliVersion =
  process.env.CODEMODEKIT_SKILLS_CLI_VERSION ?? "1.5.22";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const skills = [
  {
    name: "build-codemodekit-server",
    requiredFiles: ["SKILL.md", "references/server-api.md"],
  },
  {
    name: "author-codemode-skill",
    requiredFiles: ["SKILL.md", "references/runtime-skill-design.md"],
  },
];

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "codemodekit-skills-cli-smoke-"),
);

try {
  const separateRoot = path.join(temporaryRoot, "separate");
  for (const skill of skills) {
    await install(separateRoot, ["--skill", skill.name]);
    await assertInstalled(separateRoot, skill);
  }

  const bundleRoot = path.join(temporaryRoot, "bundle");
  await install(bundleRoot, ["--skill", "*"]);
  for (const skill of skills) {
    await assertInstalled(bundleRoot, skill);
  }

  process.stdout.write(
    `Skills CLI smoke passed with skills@${cliVersion} from ${source}: ` +
      "both CodeModeKit skills installed separately and together.\n",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function install(root, selection) {
  await mkdir(root, { recursive: true });
  await execFileAsync(
    npx,
    [
      "--yes",
      `skills@${cliVersion}`,
      "add",
      source,
      ...selection,
      "--agent",
      "codex",
      "--copy",
      "--yes",
    ],
    {
      cwd: root,
      env: { ...process.env, DISABLE_TELEMETRY: "1" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

async function assertInstalled(root, skill) {
  for (const relativeFile of skill.requiredFiles) {
    const file = path.join(
      root,
      ".agents",
      "skills",
      skill.name,
      relativeFile,
    );
    if (!(await lstat(file)).isFile()) {
      throw new Error(`Skills CLI did not install ${file}`);
    }
  }
}
