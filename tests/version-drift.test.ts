import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CODEMODEKIT_VERSION,
  GENERATED_MCP_CLIENT_VERSION,
} from "create-codemodekit";
import { describe, expect, it } from "vitest";

function readJson(relativePath: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function caretSatisfies(range: string, version: string): boolean {
  if (!range.startsWith("^")) return false;
  const parse = (value: string): number[] =>
    value.split(".").map((part) => Number.parseInt(part, 10));
  const [baseMajor, baseMinor, basePatch] = parse(range.slice(1));
  const [major, minor, patch] = parse(version);
  if (
    [baseMajor, baseMinor, basePatch, major, minor, patch].some(
      (part) => part === undefined || Number.isNaN(part),
    )
  ) {
    return false;
  }
  if (baseMajor !== major) return false;
  if (baseMajor === 0) {
    return baseMinor === minor && (patch as number) >= (basePatch as number);
  }
  return (
    (minor as number) > (baseMinor as number) ||
    (minor === baseMinor && (patch as number) >= (basePatch as number))
  );
}

describe("generated-project version constants", () => {
  it("keeps DEFAULT_CODEMODEKIT_VERSION satisfiable by the workspace codemodekit release", () => {
    const manifest = readJson("../packages/codemodekit/package.json");
    expect(typeof manifest.version).toBe("string");
    expect(
      caretSatisfies(DEFAULT_CODEMODEKIT_VERSION, manifest.version as string),
      `Scaffolded projects install codemodekit@${DEFAULT_CODEMODEKIT_VERSION}, ` +
        `but the workspace releases ${String(manifest.version)}; bump ` +
        "DEFAULT_CODEMODEKIT_VERSION in packages/create-codemodekit/src/scaffold.ts",
    ).toBe(true);
  });

  it("pins the generated @modelcontextprotocol/client to the workspace-tested version", () => {
    const manifest = readJson("../package.json");
    const devDependencies = manifest.devDependencies as Record<string, string>;
    expect(GENERATED_MCP_CLIENT_VERSION).toBe(
      devDependencies["@modelcontextprotocol/client"],
    );
  });
});
