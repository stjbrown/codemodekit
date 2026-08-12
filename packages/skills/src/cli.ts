#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEMODEKIT_SKILL_NAMES,
  installCodeModeKitSkills,
  type CodeModeKitSkillName,
} from "./index.js";

async function run(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  let root: string | undefined;
  let overwrite = false;
  const skills: CodeModeKitSkillName[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--overwrite") {
      overwrite = true;
      continue;
    }
    if (argument === "--skill") {
      const value = args[index + 1];
      if (value === undefined || !isSkillName(value)) {
        throw new TypeError(
          `--skill must be one of: ${CODEMODEKIT_SKILL_NAMES.join(", ")}`,
        );
      }
      skills.push(value);
      index += 1;
      continue;
    }
    if (argument?.startsWith("-") === true) {
      throw new TypeError(`Unknown option: ${argument}`);
    }
    if (argument !== undefined) {
      if (root !== undefined) throw new TypeError(`Unexpected argument: ${argument}`);
      root = argument;
    }
  }

  const result = await installCodeModeKitSkills({
    root: root ?? process.cwd(),
    ...(skills.length === 0 ? {} : { skills }),
    overwrite,
  });
  process.stdout.write(
    `Installed CodeModeKit skills in ${result.skillsRoot}\n` +
      (skills.length === 0 ? CODEMODEKIT_SKILL_NAMES : skills)
        .map((skill) => `  ${skill}\n`)
        .join(""),
  );
}

function isSkillName(value: string): value is CodeModeKitSkillName {
  return (CODEMODEKIT_SKILL_NAMES as readonly string[]).includes(value);
}

function usage(): string {
  return `Install CodeModeKit development skills into .agents/skills.

Usage:
  npx @codemodekit/skills [project-directory]
  codemodekit-skills [project-directory] [--skill <name>] [--overwrite]

Skills:
  build-codemodekit-server
  author-codemode-skill
`;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `codemodekit-skills: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
