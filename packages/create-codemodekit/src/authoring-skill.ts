import {
  installCodeModeKitSkills,
  type InstallCodeModeKitSkillsResult,
} from "@codemodekit/skills";

export interface InstallProjectAuthoringSkillOptions {
  readonly root: string;
  readonly overwrite?: boolean;
}

/** Installs both CodeModeKit development skills into the universal project path. */
export function installProjectAuthoringSkills(
  options: InstallProjectAuthoringSkillOptions,
): Promise<InstallCodeModeKitSkillsResult> {
  return installCodeModeKitSkills(options);
}

/**
 * Installs the original server-building role for compatibility. New generators
 * install both roles through installProjectAuthoringSkills.
 */
export async function installProjectAuthoringSkill(
  options: InstallProjectAuthoringSkillOptions,
): Promise<string> {
  const result = await installCodeModeKitSkills({
    ...options,
    skills: ["build-codemodekit-server"],
  });
  const directory = result.directories["build-codemodekit-server"];
  if (directory === undefined) {
    throw new Error("The CodeModeKit server-building skill was not installed");
  }
  return directory;
}

export type { InstallCodeModeKitSkillsResult } from "@codemodekit/skills";
