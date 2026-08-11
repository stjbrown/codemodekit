import type {
  NormalizedTool,
  SearchToolResultContract,
  TypeScriptCatalog,
} from "./contracts.js";

const MAX_DEPTH = 16;
const MAX_PROPERTIES = 128;
const MAX_UNION_MEMBERS = 32;

export interface TypeScriptCatalogEntry {
  readonly source: string;
  readonly definition: NormalizedTool;
}

export interface TypeScriptToolReference {
  readonly callable: string;
  readonly inputType: string;
  readonly outputType: string;
  readonly declaration: string;
}

export const toolResultTypeScriptContract: SearchToolResultContract =
  Object.freeze({
    declaration: `interface ToolContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface ToolResult<TStructured = unknown> {
  readonly content: readonly ToolContentBlock[];
  readonly structuredContent?: TStructured;
}`,
    guidance: Object.freeze([
      "Every tools.* call resolves to this wrapper; it never resolves directly to the upstream payload.",
      "Prefer result.structuredContent when present, but inspect unknown structured shapes before use; MCP servers commonly nest the usable payload under structuredContent.result.",
      "When structuredContent is absent, inspect result.content and parse a text block with JSON.parse only after confirming its text field is a string containing JSON.",
      "Use upstream filtering or projection inputs when advertised so oversized raw payloads do not cross the bridge unnecessarily.",
      "Compose tool calls, extraction, and transformation inside one run_typescript execution, then return only the final bounded data.",
    ]),
    example: `const result = await tools.source.tool({});
const text = result.content.find(
  (block) => block.type === "text" && typeof block.text === "string",
)?.text;
const structured = result.structuredContent;
const data =
  structured !== null &&
  typeof structured === "object" &&
  !Array.isArray(structured) &&
  "result" in structured
    ? structured.result
    : structured ?? (typeof text === "string" ? JSON.parse(text) : null);
return data;`,
  });

export function generateTypeScriptCatalog(
  revision: string,
  entries: Iterable<TypeScriptCatalogEntry>,
): TypeScriptCatalog {
  const grouped = new Map<string, NormalizedTool[]>();
  for (const entry of entries) {
    const tools = grouped.get(entry.source) ?? [];
    tools.push(entry.definition);
    grouped.set(entry.source, tools);
  }

  const sourceDeclarations = [...grouped.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([source, tools]) => {
      const toolDeclarations = tools
        .sort((left, right) => compareCodePoints(left.name, right.name))
        .map((tool) => toolDeclaration(source, tool))
        .join("\n");
      return `  readonly ${propertyName(source)}: {\n${toolDeclarations}\n  };`;
    })
    .join("\n");

  const declarations = `${toolResultTypeScriptContract.declaration}

declare class ToolCallError extends Error {
  readonly code: string;
  readonly phase: string;
  readonly source?: string;
  readonly tool?: string;
}

declare const tools: {
${sourceDeclarations}
};`;

  return { catalogRevision: revision, declarations };
}

function toolDeclaration(source: string, tool: NormalizedTool): string {
  const reference = generateTypeScriptToolReference(source, tool);
  const description = documentation(source, tool);
  return `${description}    readonly ${propertyName(tool.name)}: (input: ${reference.inputType}) => Promise<${reference.outputType}>;`;
}

export function generateTypeScriptToolReference(
  source: string,
  tool: NormalizedTool,
): TypeScriptToolReference {
  const callable = `tools${propertyAccess(source)}${propertyAccess(tool.name)}`;
  const inputType = schemaType(tool.inputSchema, tool.inputSchema);
  const structuredOutput =
    tool.outputSchema === undefined
      ? "unknown"
      : schemaType(tool.outputSchema, tool.outputSchema);
  const outputType = `ToolResult<${structuredOutput}>`;
  return {
    callable,
    inputType,
    outputType,
    declaration: `${callable}(input: ${inputType}): Promise<${outputType}>`,
  };
}

function documentation(source: string, tool: NormalizedTool): string {
  const address = `tools${propertyAccess(source)}${propertyAccess(tool.name)}`;
  const description = tool.description?.trim();
  const lines = [address];
  if (description !== undefined && description !== "") {
    lines.push(description.slice(0, 512));
  }
  return `    /** ${lines.join(" — ").replaceAll("*/", "*\\/")} */\n`;
}

function schemaType(
  schema: unknown,
  root: Readonly<Record<string, unknown>>,
  state: { readonly depth: number; readonly references: ReadonlySet<string> } = {
    depth: 0,
    references: new Set(),
  },
): string {
  if (state.depth >= MAX_DEPTH) {
    return "unknown";
  }
  if (schema === true) {
    return "unknown";
  }
  if (schema === false) {
    return "never";
  }
  if (!isRecord(schema)) {
    return "unknown";
  }
  const next = { depth: state.depth + 1, references: state.references };

  if (typeof schema.$ref === "string") {
    if (state.references.has(schema.$ref)) {
      return "unknown";
    }
    const target = resolveLocalReference(root, schema.$ref);
    if (target === undefined) {
      return "unknown";
    }
    const references = new Set(state.references);
    references.add(schema.$ref);
    return schemaType(target, root, { depth: state.depth + 1, references });
  }

  if ("const" in schema) {
    return literalType(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    return union(
      schema.enum.slice(0, MAX_UNION_MEMBERS).map(literalType),
      schema.enum.length > MAX_UNION_MEMBERS,
    );
  }
  if (Array.isArray(schema.oneOf)) {
    return schemaUnion(schema.oneOf, root, next);
  }
  if (Array.isArray(schema.anyOf)) {
    return schemaUnion(schema.anyOf, root, next);
  }
  if (Array.isArray(schema.allOf)) {
    if (schema.allOf.length === 0 || schema.allOf.length > MAX_UNION_MEMBERS) {
      return "unknown";
    }
    return schema.allOf
      .map((member) => parenthesize(schemaType(member, root, next)))
      .join(" & ");
  }

  if (Array.isArray(schema.type)) {
    if (schema.type.length === 0 || schema.type.length > MAX_UNION_MEMBERS) {
      return "unknown";
    }
    return union(
      schema.type.map((type) =>
        typeof type === "string"
          ? typeProjection(type, schema, root, next)
          : "unknown",
      ),
    );
  }
  if (typeof schema.type === "string") {
    return typeProjection(schema.type, schema, root, next);
  }
  if (isRecord(schema.properties) || Array.isArray(schema.required)) {
    return objectType(schema, root, next);
  }
  if ("items" in schema || Array.isArray(schema.prefixItems)) {
    return arrayType(schema, root, next);
  }
  return "unknown";
}

function typeProjection(
  type: string,
  schema: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>>,
  state: { readonly depth: number; readonly references: ReadonlySet<string> },
): string {
  switch (type) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "string":
      return "string";
    case "array":
      return arrayType(schema, root, state);
    case "object":
      return objectType(schema, root, state);
    default:
      return "unknown";
  }
}

function objectType(
  schema: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>>,
  state: { readonly depth: number; readonly references: ReadonlySet<string> },
): string {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const propertyEntries = Object.entries(properties);
  if (propertyEntries.length > MAX_PROPERTIES) {
    return "unknown";
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const members: string[] = propertyEntries.map(([name, propertySchema]) => {
    const optional = required.has(name) ? "" : "?";
    return `readonly ${propertyName(name)}${optional}: ${schemaType(propertySchema, root, state)}`;
  });
  for (const name of required) {
    if (!(name in properties)) {
      members.push(`readonly ${propertyName(name)}: unknown`);
    }
  }
  if (schema.additionalProperties !== false) {
    members.push("readonly [key: string]: unknown");
  }
  if (members.length === 0) {
    return "{ readonly [key: string]: never }";
  }
  return `{ ${members.join("; ")} }`;
}

function arrayType(
  schema: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>>,
  state: { readonly depth: number; readonly references: ReadonlySet<string> },
): string {
  if (Array.isArray(schema.prefixItems) || Array.isArray(schema.items)) {
    return "readonly unknown[]";
  }
  if (schema.items === false) {
    return "readonly []";
  }
  const itemType =
    schema.items === undefined || schema.items === true
      ? "unknown"
      : schemaType(schema.items, root, state);
  return `readonly ${parenthesize(itemType)}[]`;
}

function schemaUnion(
  schemas: readonly unknown[],
  root: Readonly<Record<string, unknown>>,
  state: { readonly depth: number; readonly references: ReadonlySet<string> },
): string {
  return union(
    schemas
      .slice(0, MAX_UNION_MEMBERS)
      .map((member) => schemaType(member, root, state)),
    schemas.length > MAX_UNION_MEMBERS,
  );
}

function union(types: readonly string[], truncated = false): string {
  if (truncated || types.length === 0) {
    return "unknown";
  }
  const unique = [...new Set(types)];
  return unique.map(parenthesize).join(" | ");
}

function literalType(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  return "unknown";
}

function resolveLocalReference(
  root: Readonly<Record<string, unknown>>,
  reference: string,
): unknown | undefined {
  if (reference === "#") {
    return root;
  }
  if (!reference.startsWith("#/")) {
    return undefined;
  }
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(2));
  } catch {
    return undefined;
  }
  let current: unknown = root;
  for (const rawSegment of pointer.split("/")) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    current = (current as Readonly<Record<string, unknown>>)[segment];
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function propertyName(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function propertyAccess(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
    ? `.${value}`
    : `[${JSON.stringify(value)}]`;
}

function parenthesize(type: string): string {
  return type.includes(" | ") || type.includes(" & ") ? `(${type})` : type;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
