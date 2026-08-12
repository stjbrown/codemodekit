import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface AgentPluginTypeScriptCatalog {
  readonly catalogRevision: string;
  readonly declarations: string;
  readonly sources?: readonly AgentPluginTypeScriptCatalogSource[];
}

export interface AgentPluginTypeScriptCatalogSource {
  readonly source: string;
  readonly toolCount: number;
  readonly declarations: string;
  readonly shards: readonly AgentPluginTypeScriptCatalogShard[];
}

export interface AgentPluginTypeScriptCatalogShard {
  readonly key: string;
  readonly prefixes: readonly string[];
  readonly toolCount: number;
  readonly declarations: string;
}

export interface CatalogDeclarationFile {
  readonly path: string;
  readonly scope: "catalog" | "source" | "prefix";
  readonly source?: string;
  readonly prefixes?: readonly string[];
  readonly toolCount: number;
  readonly contents: string;
}

export function catalogDeclarationFiles(
  catalog: AgentPluginTypeScriptCatalog,
): readonly CatalogDeclarationFile[] {
  const files: CatalogDeclarationFile[] = [
    {
      path: "tools.d.ts",
      scope: "catalog",
      toolCount:
        catalog.sources?.reduce((total, source) => total + source.toolCount, 0) ?? 0,
      contents: renderCatalogDeclarations(
        catalog.catalogRevision,
        catalog.declarations,
      ),
    },
  ];
  const usedPaths = new Map<string, string>([["tools.d.ts", "catalog"]]);
  const sourceSegments = collisionSafeSegments(
    (catalog.sources ?? []).map((source) => source.source),
  );

  for (const source of catalog.sources ?? []) {
    const sourceSegment =
      sourceSegments.get(source.source) ?? safeFilenameSegment(source.source);
    files.push({
      path: allocateDeclarationPath(
        [sourceSegment],
        `source:${source.source}`,
        usedPaths,
      ),
      scope: "source",
      source: source.source,
      toolCount: source.toolCount,
      contents: renderCatalogDeclarations(
        catalog.catalogRevision,
        source.declarations,
      ),
    });

    for (const shard of source.shards) {
      const identity =
        `prefix:${source.source}:${shard.key}:` + shard.prefixes.join("\u0000");
      files.push({
        path: allocateDeclarationPath(
          [sourceSegment, safeFilenameSegment(shard.key)],
          identity,
          usedPaths,
        ),
        scope: "prefix",
        source: source.source,
        prefixes: shard.prefixes,
        toolCount: shard.toolCount,
        contents: renderCatalogDeclarations(
          catalog.catalogRevision,
          shard.declarations,
        ),
      });
    }
  }

  return files;
}

export async function commitCatalogSnapshot(
  referencesDirectory: string,
  files: ReadonlyMap<string, string>,
): Promise<void> {
  const transaction = path.join(
    referencesDirectory,
    `.codemodekit-sync-${String(process.pid)}-${randomUUID()}`,
  );
  const incoming = path.join(transaction, "incoming");
  const backup = path.join(transaction, "backup");
  const incomingNames = [...files.keys()];
  for (const name of incomingNames) {
    validateGeneratedFilename(name);
  }

  await Promise.all([
    mkdir(incoming, { recursive: true }),
    mkdir(backup, { recursive: true }),
  ]);
  try {
    await Promise.all(
      [...files].map(([name, contents]) =>
        writeFile(path.join(incoming, name), contents, "utf8"),
      ),
    );

    const existingNames = await ownedCatalogFiles(referencesDirectory);
    const backedUp: string[] = [];
    const committed: string[] = [];
    try {
      for (const name of existingNames) {
        if (await fileExists(path.join(referencesDirectory, name))) {
          await rename(
            path.join(referencesDirectory, name),
            path.join(backup, name),
          );
          backedUp.push(name);
        }
      }

      const commitOrder = incomingNames
        .filter((name) => name !== "catalog-metadata.json")
        .concat(
          incomingNames.includes("catalog-metadata.json")
            ? ["catalog-metadata.json"]
            : [],
        );
      for (const name of commitOrder) {
        await rename(
          path.join(incoming, name),
          path.join(referencesDirectory, name),
        );
        committed.push(name);
      }
    } catch (error) {
      await Promise.allSettled(
        committed.map((name) =>
          rm(path.join(referencesDirectory, name), { force: true }),
        ),
      );
      for (const name of backedUp) {
        await rename(
          path.join(backup, name),
          path.join(referencesDirectory, name),
        );
      }
      throw error;
    }
  } finally {
    await rm(transaction, { recursive: true, force: true });
  }
}

function collisionSafeSegments(values: readonly string[]): ReadonlyMap<string, string> {
  const byBase = new Map<string, string[]>();
  for (const value of values) {
    const base = safeFilenameSegment(value);
    byBase.set(base, [...(byBase.get(base) ?? []), value]);
  }
  const result = new Map<string, string>();
  for (const [base, collisions] of byBase) {
    for (const value of collisions) {
      result.set(
        value,
        collisions.length === 1 ? base : `${base}-${shortHash(value)}`,
      );
    }
  }
  return result;
}

function allocateDeclarationPath(
  segments: readonly string[],
  identity: string,
  used: Map<string, string>,
): string {
  const base = `tools.${segments.join(".")}.d.ts`;
  const existing = used.get(base);
  if (existing === undefined || existing === identity) {
    used.set(base, identity);
    return base;
  }

  const stem = `tools.${segments.join(".")}-${shortHash(identity)}`;
  let attempt = 1;
  while (true) {
    const candidate = `${stem}${attempt === 1 ? "" : `-${String(attempt)}`}.d.ts`;
    const collision = used.get(candidate);
    if (collision === undefined || collision === identity) {
      used.set(candidate, identity);
      return candidate;
    }
    attempt += 1;
  }
}

function safeFilenameSegment(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (normalized === "") {
    return `item-${shortHash(value)}`;
  }
  if (normalized.length <= 48) {
    return normalized;
  }
  return `${normalized.slice(0, 39).replace(/-$/u, "")}-${shortHash(value)}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function renderCatalogDeclarations(revision: string, declarations: string): string {
  return `// Generated by CodeModeKit from catalog revision ${revision}.
// Refresh with: npm run plugin:sync

${declarations.trim()}\n`;
}

async function ownedCatalogFiles(
  referencesDirectory: string,
): Promise<readonly string[]> {
  const owned = new Set<string>(["tools.d.ts", "catalog-metadata.json"]);
  const metadataPath = path.join(referencesDirectory, "catalog-metadata.json");
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      generatedFiles?: unknown;
    };
    if (Array.isArray(metadata.generatedFiles)) {
      for (const name of metadata.generatedFiles) {
        if (typeof name === "string" && isGeneratedFilename(name)) {
          owned.add(name);
        }
      }
    }
  } catch {
    // Legacy metadata is recovered by inspecting generated declaration headers.
  }

  try {
    const entries = await readdir(referencesDirectory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !isGeneratedFilename(entry.name)) return;
        const contents = await readFile(
          path.join(referencesDirectory, entry.name),
          "utf8",
        );
        if (
          contents.startsWith("// Generated by CodeModeKit") ||
          contents.startsWith("// CodeModeKit catalog snapshot pending")
        ) {
          owned.add(entry.name);
        }
      }),
    );
  } catch {
    // The caller creates this directory; absence means there is no prior snapshot.
  }
  return [...owned].sort();
}

function validateGeneratedFilename(name: string): void {
  if (!isGeneratedFilename(name) && name !== "catalog-metadata.json") {
    throw new TypeError(`Invalid generated catalog filename: ${name}`);
  }
}

function isGeneratedFilename(name: string): boolean {
  return (
    path.basename(name) === name &&
    /^tools(?:\.[a-z0-9-]+)*\.d\.ts$/u.test(name)
  );
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
