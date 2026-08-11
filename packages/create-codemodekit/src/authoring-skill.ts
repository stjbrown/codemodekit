import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AUTHORING_SKILL_NAME = "build-codemodekit-plugin";
const BUNDLED_SKILL_DIRECTORY = fileURLToPath(
  new URL(`../skills/${AUTHORING_SKILL_NAME}`, import.meta.url),
);

export interface InstallProjectAuthoringSkillOptions {
  readonly root: string;
  readonly overwrite?: boolean;
}

/** Installs CodeModeKit's development-time skill into the universal project path. */
export async function installProjectAuthoringSkill(
  options: InstallProjectAuthoringSkillOptions,
): Promise<string> {
  const root = path.resolve(options.root);
  const skillsRoot = path.join(root, ".agents", "skills");
  const destination = path.join(skillsRoot, AUTHORING_SKILL_NAME);
  const staging = path.join(
    skillsRoot,
    `.${AUTHORING_SKILL_NAME}.${String(process.pid)}.${String(Date.now())}.tmp`,
  );
  if ((await pathExists(destination)) && options.overwrite !== true) {
    throw new Error(`Authoring skill already exists: ${destination}`);
  }

  await mkdir(skillsRoot, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await cp(BUNDLED_SKILL_DIRECTORY, staging, { recursive: true });
  try {
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return destination;
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
