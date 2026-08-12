import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";

import type {
  CatalogDiagnostic,
  CatalogDiagnosticsRequest,
  CatalogDiagnosticsResult,
  NormalizedTool,
  StartupReport,
  StartupSourceReport,
  SearchToolsRequest,
  SearchToolsResult,
  ToolProvider,
  TypeScriptCatalog,
} from "./contracts.js";
import { searchCatalog } from "./catalog-search.js";
import { generateTypeScriptCatalog } from "./typescript-catalog.js";

export interface CatalogSourceSnapshot {
  readonly provider: ToolProvider;
  readonly status: "healthy" | "unavailable";
  readonly tools: readonly NormalizedTool[];
  readonly message?: string;
}

export interface CatalogEntry {
  readonly source: string;
  readonly definition: NormalizedTool;
  readonly provider: ToolProvider;
  readonly validateInput: ValidateFunction;
  readonly validateOutput?: ValidateFunction;
}

export class ToolCatalog {
  readonly revision: string;
  readonly startupReport: StartupReport;

  readonly #entries: ReadonlyMap<string, CatalogEntry>;
  readonly #rejected: ReadonlyMap<string, CatalogDiagnostic>;
  readonly #sourceStatuses: ReadonlyMap<string, "healthy" | "unavailable">;

  private constructor(
    revision: string,
    entries: ReadonlyMap<string, CatalogEntry>,
    rejected: ReadonlyMap<string, CatalogDiagnostic>,
    sourceStatuses: ReadonlyMap<string, "healthy" | "unavailable">,
    sources: readonly StartupSourceReport[],
  ) {
    this.revision = revision;
    this.#entries = entries;
    this.#rejected = rejected;
    this.#sourceStatuses = sourceStatuses;
    this.startupReport = {
      status: sources.every((source) => source.status === "healthy")
        ? "ready"
        : "degraded",
      catalogRevision: revision,
      sources,
    };
  }

  static create(
    revision: string,
    snapshots: readonly CatalogSourceSnapshot[],
  ): ToolCatalog {
    const entries = new Map<string, CatalogEntry>();
    const rejected = new Map<string, CatalogDiagnostic>();
    const sourceStatuses = new Map<string, "healthy" | "unavailable">();
    const reports: StartupSourceReport[] = [];

    for (const snapshot of snapshots) {
      const provider = snapshot.provider;
      sourceStatuses.set(provider.sourceName, snapshot.status);
      if (snapshot.status === "unavailable") {
        reports.push({
          source: provider.sourceName,
          status: "unavailable",
          toolCount: 0,
          message: snapshot.message ?? "Source is unavailable",
        });
        continue;
      }

      let activeCount = 0;
      const sourceDiagnostics: CatalogDiagnostic[] = [];
      for (const definition of uniqueToolDefinitions(snapshot.tools)) {
        const key = toolKey(provider.sourceName, definition.name);
        if (entries.has(key)) {
          continue;
        }

        let validateInput: ValidateFunction;
        try {
          validateInput = compileSchema(definition.inputSchema);
        } catch {
          const diagnostic = rejectedSchemaDiagnostic(
            provider.sourceName,
            definition.name,
            "input",
          );
          rejected.set(key, diagnostic);
          sourceDiagnostics.push(diagnostic);
          continue;
        }

        let validateOutput: ValidateFunction | undefined;
        if (definition.outputSchema !== undefined) {
          try {
            validateOutput = compileSchema(definition.outputSchema);
          } catch {
            const diagnostic = rejectedSchemaDiagnostic(
              provider.sourceName,
              definition.name,
              "output",
            );
            rejected.set(key, diagnostic);
            sourceDiagnostics.push(diagnostic);
            continue;
          }
        }

        entries.set(key, {
          source: provider.sourceName,
          definition,
          provider,
          validateInput,
          ...(validateOutput === undefined ? {} : { validateOutput }),
        });
        activeCount += 1;
      }

      const startupDiagnostics = sourceDiagnostics.slice(0, 8);
      reports.push({
        source: provider.sourceName,
        status: "healthy",
        toolCount: activeCount,
        ...(sourceDiagnostics.length === 0
          ? {}
          : {
              rejectedToolCount: sourceDiagnostics.length,
              diagnostics: startupDiagnostics,
              ...(sourceDiagnostics.length > startupDiagnostics.length
                ? { diagnosticsTruncated: true }
                : {}),
            }),
      });
    }

    return new ToolCatalog(revision, entries, rejected, sourceStatuses, reports);
  }

  get(source: string, tool: string): CatalogEntry | undefined {
    return this.#entries.get(toolKey(source, tool));
  }

  rejected(source: string, tool: string): CatalogDiagnostic | undefined {
    return this.#rejected.get(toolKey(source, tool));
  }

  diagnostics(request: CatalogDiagnosticsRequest = {}): CatalogDiagnosticsResult {
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("catalog diagnostic limit must be an integer between 1 and 100");
    }
    const matching = [...this.#rejected.values()]
      .filter((diagnostic) =>
        request.source === undefined || diagnostic.source === request.source,
      )
      .sort((left, right) =>
        compareCodePoints(left.source, right.source) ||
        compareCodePoints(left.tool, right.tool) ||
        compareCodePoints(left.schema, right.schema),
      );
    const diagnostics = matching.slice(0, limit);
    return {
      catalogRevision: this.revision,
      total: matching.length,
      returned: diagnostics.length,
      truncated: matching.length > diagnostics.length,
      diagnostics,
    };
  }

  sourceStatus(source: string): "healthy" | "unavailable" | undefined {
    return this.#sourceStatuses.get(source);
  }

  toolSurface(): Readonly<Record<string, readonly string[]>> {
    const surface: Record<string, string[]> = Object.create(null) as Record<
      string,
      string[]
    >;
    for (const source of this.#sourceStatuses.keys()) {
      surface[source] = [];
    }
    for (const entry of this.#entries.values()) {
      (surface[entry.source] ??= []).push(entry.definition.name);
    }
    for (const names of Object.values(surface)) {
      names.sort();
    }
    return surface;
  }

  typeScriptCatalog(): TypeScriptCatalog {
    return generateTypeScriptCatalog(
      this.revision,
      [...this.#entries.values()].map((entry) => ({
        source: entry.source,
        definition: entry.definition,
      })),
      this.#sourceStatuses.keys(),
    );
  }

  search(request: SearchToolsRequest): SearchToolsResult {
    return searchCatalog(
      this.revision,
      this.#sourceStatuses,
      [...this.#entries.values()].map((entry) => ({
        source: entry.source,
        definition: entry.definition,
      })),
      request,
    );
  }
}

function rejectedSchemaDiagnostic(
  source: string,
  tool: string,
  schema: "input" | "output",
): CatalogDiagnostic {
  return {
    code: "TOOL_SCHEMA_UNSUPPORTED",
    severity: "error",
    source,
    tool,
    schema,
    message: boundedMessage(
      `Tool ${source}.${tool} was quarantined because its ${schema} schema cannot be enforced`,
    ),
  };
}

function uniqueToolDefinitions(
  definitions: readonly NormalizedTool[],
): readonly NormalizedTool[] {
  const byName = new Map<string, NormalizedTool>();
  for (const definition of definitions) {
    byName.set(definition.name, definition);
  }
  return [...byName.values()];
}

function boundedMessage(message: string): string {
  const encoded = new TextEncoder().encode(message);
  return encoded.byteLength <= 512
    ? message
    : new TextDecoder().decode(encoded.slice(0, 512));
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toolKey(source: string, tool: string): string {
  return `${source.length}:${source}${tool}`;
}

function compileSchema(schema: Readonly<Record<string, unknown>>): ValidateFunction {
  const dialect = schema.$schema;
  const options = { allErrors: true, strict: false } as const;

  if (dialect === undefined || isDialect(dialect, "draft-07")) {
    return new Ajv(options).compile(schema);
  }
  if (isDialect(dialect, "2019-09")) {
    return new Ajv2019(options).compile(schema);
  }
  if (isDialect(dialect, "2020-12")) {
    return new Ajv2020(options).compile(schema);
  }
  throw new TypeError(`Unsupported JSON Schema dialect: ${String(dialect)}`);
}

function isDialect(value: unknown, revision: string): boolean {
  return typeof value === "string" && value.toLowerCase().includes(revision);
}
