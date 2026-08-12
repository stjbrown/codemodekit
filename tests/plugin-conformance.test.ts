import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
} from "ajv/dist/2020.js";
import {
  installProjectAuthoringSkills,
  scaffoldAgentPlugin,
} from "create-codemodekit";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const schemaDirectory = fileURLToPath(
  new URL("./fixtures/schemas", import.meta.url),
);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("generated Agent Plugin conformance", () => {
  it("matches the official Agent Plugins 1.0 JSON schemas", async () => {
    const root = await generatedPlugin();
    const ajv = new Ajv2020({ allErrors: true, strict: true });

    for (const name of ["plugin", "mcp"] as const) {
      const schema = await readJson<AnySchema>(
        path.join(schemaDirectory, `${name}.schema.json`),
      );
      const value = await readJson(path.join(root, `${name}.json`));
      const validate = ajv.compile(schema);
      expect(formatErrors(validate(value) ? [] : validate.errors)).toEqual([]);
    }
  });

  it("generates a spec-conformant Agent Skill with resolvable references", async () => {
    const root = await generatedPlugin();
    const skillName = "use-fixture-codemode";
    const skillDirectory = path.join(root, "skills", skillName);
    await expectSkillConforms(skillDirectory, skillName, [
      "references/catalog-metadata.json",
      "references/tools.d.ts",
      "references/runtime.md",
      "references/result-contract.md",
      "references/examples.md",
    ]);
  });

  it("ships two conformant project authoring skills", async () => {
    const root = await mkdtemp(path.join(workspaceRoot, ".authoring-skill-"));
    tempDirectories.push(root);
    const result = await installProjectAuthoringSkills({ root });
    const builder = result.directories["build-codemodekit-server"];
    const author = result.directories["author-codemode-skill"];
    expect(builder).toBe(
      path.join(root, ".agents", "skills", "build-codemodekit-server"),
    );
    expect(author).toBe(
      path.join(root, ".agents", "skills", "author-codemode-skill"),
    );
    await expectSkillConforms(builder ?? "", "build-codemodekit-server", [
      "references/generator.md",
      "references/server-api.md",
      "references/policy-and-security.md",
      "references/verification.md",
    ]);
    await expectSkillConforms(author ?? "", "author-codemode-skill", [
      "references/discovery.md",
      "references/runtime-skill-design.md",
      "references/plugin-maintenance.md",
      "references/evaluation.md",
    ]);
  });
});

async function generatedPlugin(): Promise<string> {
  const root = await mkdtemp(path.join(workspaceRoot, ".plugin-conformance-"));
  tempDirectories.push(root);
  await scaffoldAgentPlugin({
    root,
    pluginName: "fixture-plugin",
    serverName: "fixture-code-mode",
    skillName: "use-fixture-codemode",
    license: "Apache-2.0",
  });
  return root;
}

async function readJson<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function formatErrors(
  errors: readonly ErrorObject[] | null | undefined,
): readonly string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
}

function parseGeneratedSkill(source: string): {
  frontmatter: { name: string; description: string };
  body: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/u.exec(source);
  if (match === null) throw new TypeError("SKILL.md is missing YAML frontmatter");
  const lines = match[1]?.split("\n") ?? [];
  const fields = new Map(
    lines.map((line) => {
      const separator = line.indexOf(":");
      if (separator < 1) throw new TypeError(`Invalid frontmatter line: ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
    }),
  );
  const name = fields.get("name");
  const rawDescription = fields.get("description");
  if (name === undefined || rawDescription === undefined) {
    throw new TypeError("SKILL.md requires name and description fields");
  }
  let description: unknown;
  try {
    description = JSON.parse(rawDescription) as unknown;
  } catch {
    description = rawDescription;
  }
  if (typeof description !== "string") {
    throw new TypeError("SKILL.md description must be a string");
  }
  return { frontmatter: { name, description }, body: match[2]?.trim() ?? "" };
}

async function expectSkillConforms(
  skillDirectory: string,
  expectedName: string,
  expectedReferences: readonly string[],
): Promise<void> {
  const skill = await readFile(path.join(skillDirectory, "SKILL.md"), "utf8");
  const { frontmatter, body } = parseGeneratedSkill(skill);
  expect(frontmatter.name).toBe(expectedName);
  expect(frontmatter.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  expect(frontmatter.name.length).toBeLessThanOrEqual(64);
  expect(frontmatter.description.length).toBeGreaterThan(0);
  expect(frontmatter.description.length).toBeLessThanOrEqual(1024);
  expect(body.length).toBeGreaterThan(0);

  const references = [...skill.matchAll(/\]\((references\/[^)]+)\)/gu)]
    .map((match) => match[1])
    .filter((reference): reference is string => reference !== undefined);
  expect(references).toEqual(expectedReferences);
  await Promise.all(
    references.map((reference) =>
      expect(
        readFile(path.join(skillDirectory, reference), "utf8"),
      ).resolves.toBeTruthy(),
    ),
  );
}
