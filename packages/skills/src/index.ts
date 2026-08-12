import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CODEMODEKIT_SKILL_NAMES = [
  "build-codemodekit-server",
  "author-codemode-skill",
] as const;

export type CodeModeKitSkillName = (typeof CODEMODEKIT_SKILL_NAMES)[number];

export interface InstallCodeModeKitSkillsOptions {
  readonly root: string;
  readonly skills?: readonly CodeModeKitSkillName[];
  readonly overwrite?: boolean;
}

export interface InstallCodeModeKitSkillsResult {
  readonly root: string;
  readonly skillsRoot: string;
  readonly directories: Readonly<Partial<Record<CodeModeKitSkillName, string>>>;
}

const BUNDLED_SKILLS_ROOT = fileURLToPath(new URL("../skills", import.meta.url));

/** Install CodeModeKit's development-time skills into the portable project path. */
export async function installCodeModeKitSkills(
  options: InstallCodeModeKitSkillsOptions,
): Promise<InstallCodeModeKitSkillsResult> {
  const root = path.resolve(options.root);
  const skillsRoot = path.join(root, ".agents", "skills");
  const selected = options.skills ?? CODEMODEKIT_SKILL_NAMES;
  const unique = [...new Set(selected)];
  if (unique.length === 0) {
    throw new TypeError("Select at least one CodeModeKit skill to install");
  }

  for (const skillName of unique) {
    if (!isCodeModeKitSkillName(skillName)) {
      throw new TypeError(`Unknown CodeModeKit skill: ${String(skillName)}`);
    }
    const destination = path.join(skillsRoot, skillName);
    if ((await pathExists(destination)) && options.overwrite !== true) {
      throw new Error(`CodeModeKit skill already exists: ${destination}`);
    }
  }

  await mkdir(skillsRoot, { recursive: true });
  const installed = new Map<CodeModeKitSkillName, string>();
  for (const skillName of unique) {
    const destination = path.join(skillsRoot, skillName);
    const staging = path.join(
      skillsRoot,
      `.${skillName}.${String(process.pid)}.${String(Date.now())}.tmp`,
    );
    await rm(staging, { recursive: true, force: true });
    await cp(path.join(BUNDLED_SKILLS_ROOT, skillName), staging, {
      recursive: true,
    });
    try {
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    installed.set(skillName, destination);
  }

  const directories = Object.fromEntries(installed) as Partial<
    Record<CodeModeKitSkillName, string>
  >;
  return { root, skillsRoot, directories };
}

function isCodeModeKitSkillName(value: string): value is CodeModeKitSkillName {
  return (CODEMODEKIT_SKILL_NAMES as readonly string[]).includes(value);
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
