import type {
  ModelDiagnostic,
  NormalizedTool,
  SearchToolMatch,
  SearchToolResultContract,
  SearchToolsRequest,
  SearchToolsResult,
} from "./contracts.js";
import { utf8Bytes } from "./json.js";
import {
  generateTypeScriptToolReference,
  toolResultTypeScriptContract,
} from "./typescript-catalog.js";

const MAX_QUERY_SCALARS = 256;
const MAX_RESULTS = 8;
const MAX_TYPESCRIPT_RESULTS = 5;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_SCHEMA_NAMES = 256;

export interface SearchCatalogEntry {
  readonly source: string;
  readonly definition: NormalizedTool;
}

export function searchCatalog(
  revision: string,
  sourceStatuses: ReadonlyMap<string, "healthy" | "unavailable">,
  entries: Iterable<SearchCatalogEntry>,
  request: SearchToolsRequest,
): SearchToolsResult {
  const query = validateQuery(request.query);
  const detail = request.detail ?? "summary";
  if (detail !== "summary" && detail !== "typescript") {
    throw new TypeError('search detail must be "summary" or "typescript"');
  }
  const requestedLimit = request.limit ?? 5;
  if (
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > MAX_RESULTS
  ) {
    throw new TypeError(`search limit must be an integer between 1 and ${MAX_RESULTS}`);
  }
  const resultContract =
    detail === "typescript" ? toolResultTypeScriptContract : undefined;

  if (request.source !== undefined) {
    const status = sourceStatuses.get(request.source);
    if (status === undefined) {
      return emptyResult(
        revision,
        query,
        {
          suggestions: suggestSources(request.source, sourceStatuses.keys()),
        },
        resultContract,
      );
    }
    if (status === "unavailable") {
      const diagnostic: ModelDiagnostic = {
        code: "SOURCE_UNAVAILABLE",
        phase: "host",
        source: request.source,
        message: `Tool source ${request.source} is unavailable`,
      };
      return emptyResult(revision, query, { diagnostic }, resultContract);
    }
  }

  const ranked = [...entries]
    .filter((entry) => request.source === undefined || entry.source === request.source)
    .map((entry) => ({ entry, score: scoreEntry(query, entry) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      compareCodePoints(left.entry.source, right.entry.source) ||
      compareCodePoints(left.entry.definition.name, right.entry.definition.name),
    );

  const effectiveLimit = Math.min(
    requestedLimit,
    detail === "typescript" ? MAX_TYPESCRIPT_RESULTS : MAX_RESULTS,
  );
  const results = ranked
    .slice(0, effectiveLimit)
    .map(({ entry }) => toMatch(entry, detail));
  let truncated = ranked.length > results.length;

  while (
    results.length > 0 &&
    responseBytes(revision, query, results, truncated, resultContract) >
      MAX_RESPONSE_BYTES
  ) {
    results.pop();
    truncated = true;
  }

  return {
    catalogRevision: revision,
    query,
    returned: results.length,
    truncated,
    results,
    ...(resultContract === undefined ? {} : { resultContract }),
  };
}

function validateQuery(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("search query must be a string");
  }
  const query = value.trim();
  const scalars = [...query];
  if (
    scalars.length < 1 ||
    scalars.length > MAX_QUERY_SCALARS ||
    scalars.some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0xd800 && point <= 0xdfff;
    })
  ) {
    throw new TypeError(
      `search query must contain 1 to ${MAX_QUERY_SCALARS} Unicode scalar values`,
    );
  }
  return query;
}

function scoreEntry(query: string, entry: SearchCatalogEntry): number {
  const normalizedQuery = query.toLowerCase();
  const tool = entry.definition.name.toLowerCase();
  const source = entry.source.toLowerCase();
  const dottedAddress = `${source}.${tool}`;
  const reference = generateTypeScriptToolReference(entry.source, entry.definition);
  const callable = reference.callable.toLowerCase();
  let score = 0;

  if (normalizedQuery === callable || normalizedQuery === dottedAddress) score += 20_000;
  if (normalizedQuery === tool) score += 16_000;
  if (normalizedQuery === source) score += 12_000;
  if (tool.startsWith(normalizedQuery)) score += 8_000;
  if (dottedAddress.startsWith(normalizedQuery)) score += 7_000;
  if (tool.includes(normalizedQuery)) score += 5_000;

  const schemaNames = schemaPropertyNames(entry.definition);
  const description = entry.definition.description?.toLowerCase() ?? "";
  const haystack = [source, tool, dottedAddress, callable, description, ...schemaNames].join(" ");
  const queryTokens = tokens(normalizedQuery);
  const candidateTokens = new Set(tokens(haystack));
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) {
      score += 1_000;
    } else if ([...candidateTokens].some((candidate) => candidate.startsWith(token))) {
      score += 400;
    } else if (haystack.includes(token)) {
      score += 100;
    }
  }
  if (queryTokens.length > 0 && queryTokens.every((token) => haystack.includes(token))) {
    score += 2_000;
  }
  return score;
}

function toMatch(
  entry: SearchCatalogEntry,
  detail: "summary" | "typescript",
): SearchToolMatch {
  const reference = generateTypeScriptToolReference(entry.source, entry.definition);
  const description = entry.definition.description?.trim().slice(0, MAX_DESCRIPTION_LENGTH);
  return {
    source: entry.source,
    tool: entry.definition.name,
    address: [entry.source, entry.definition.name],
    callable: reference.callable,
    ...(description === undefined || description === "" ? {} : { description }),
    ...(detail === "summary"
      ? {}
      : {
          typescript: {
            inputType: reference.inputType,
            outputType: reference.outputType,
            declaration: reference.declaration,
          },
        }),
  };
}

function schemaPropertyNames(tool: NormalizedTool): string[] {
  const names: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12 || names.length >= MAX_SCHEMA_NAMES || !isRecord(value) || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (isRecord(value.properties)) {
      for (const [name, schema] of Object.entries(value.properties)) {
        names.push(name.toLowerCase());
        visit(schema, depth + 1);
        if (names.length >= MAX_SCHEMA_NAMES) return;
      }
    }
    for (const keyword of ["items", "oneOf", "anyOf", "allOf", "$defs", "definitions"] as const) {
      const nested = value[keyword];
      if (Array.isArray(nested)) {
        for (const member of nested) visit(member, depth + 1);
      } else if (isRecord(nested)) {
        if (keyword === "$defs" || keyword === "definitions") {
          for (const member of Object.values(nested)) visit(member, depth + 1);
        } else {
          visit(nested, depth + 1);
        }
      }
    }
  };
  visit(tool.inputSchema, 0);
  visit(tool.outputSchema, 0);
  return names;
}

function tokens(value: string): string[] {
  return value.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
}

function suggestSources(query: string, sources: Iterable<string>): string[] {
  const normalized = query.toLowerCase();
  return [...sources]
    .sort((left, right) => {
      const leftMatch = left.toLowerCase().includes(normalized) ? 0 : 1;
      const rightMatch = right.toLowerCase().includes(normalized) ? 0 : 1;
      return leftMatch - rightMatch || compareCodePoints(left, right);
    })
    .slice(0, 3);
}

function emptyResult(
  revision: string,
  query: string,
  extra:
    | Pick<SearchToolsResult, "diagnostic">
    | Pick<SearchToolsResult, "suggestions">,
  resultContract?: SearchToolResultContract,
): SearchToolsResult {
  return {
    catalogRevision: revision,
    query,
    returned: 0,
    truncated: false,
    results: [],
    ...(resultContract === undefined ? {} : { resultContract }),
    ...extra,
  };
}

function responseBytes(
  revision: string,
  query: string,
  results: readonly SearchToolMatch[],
  truncated: boolean,
  resultContract: SearchToolResultContract | undefined,
): number {
  return utf8Bytes(
    JSON.stringify({
      catalogRevision: revision,
      query,
      returned: results.length,
      truncated,
      results,
      ...(resultContract === undefined ? {} : { resultContract }),
    }),
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
