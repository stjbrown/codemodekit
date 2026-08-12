import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import {
  ProviderToolError,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type NormalizedTool,
  type ProviderCallContext,
  type ProviderStartContext,
  type ProviderToolResult,
  type ToolProvider,
} from "@codemodekit/core";

export type LocalToolInputSchema =
  | JsonSchema
  | StandardJSONSchemaV1<JsonObject, JsonObject>;

export type LocalToolOutputSchema =
  | JsonSchema
  | StandardJSONSchemaV1<JsonValue, JsonValue>;

export interface LocalToolExecutionContext {
  readonly executionId: string;
  readonly callId: string;
  readonly source: string;
  readonly tool: string;
  readonly signal: AbortSignal;
}

type InputFor<Schema> = Schema extends StandardJSONSchemaV1<infer Input, unknown>
  ? Input extends JsonObject
    ? Input
    : never
  : JsonObject;

type OutputFor<Schema> = Schema extends undefined
  ? JsonValue
  : Schema extends StandardJSONSchemaV1<unknown, infer Output>
    ? Output extends JsonValue
      ? Output
      : never
    : JsonValue;

export interface LocalToolDefinition<
  InputSchema extends LocalToolInputSchema = LocalToolInputSchema,
  OutputSchema extends LocalToolOutputSchema | undefined =
    | LocalToolOutputSchema
    | undefined,
> {
  readonly description?: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema?: OutputSchema;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  /** Trusted definition metadata retained outside the sandbox. */
  readonly sideband?: Readonly<Record<string, unknown>>;
  readonly execute: (
    input: InputFor<InputSchema>,
    context: LocalToolExecutionContext,
  ) => OutputFor<OutputSchema> | Promise<OutputFor<OutputSchema>>;
}

export interface LocalToolSourceOptions {
  readonly name: string;
  readonly tools: Readonly<Record<string, LocalToolDefinition<any, any>>>;
}

/**
 * Defines one host-side tool while preserving schema-derived input and output
 * types. The function is intentionally an identity helper; LocalToolProvider
 * owns schema conversion and execution.
 */
export function defineTool<
  const InputSchema extends LocalToolInputSchema,
  const OutputSchema extends LocalToolOutputSchema | undefined = undefined,
>(
  definition: LocalToolDefinition<InputSchema, OutputSchema>,
): LocalToolDefinition<InputSchema, OutputSchema> {
  return definition;
}

/** An immutable provider for application-owned functions. */
export class LocalToolProvider implements ToolProvider {
  readonly sourceName: string;

  readonly #tools: ReadonlyMap<string, LocalToolDefinition<any, any>>;
  readonly #definitions: readonly NormalizedTool[];
  #closed = false;

  constructor(options: LocalToolSourceOptions) {
    this.sourceName = requiredName(options.name, "Local source name");
    const entries = Object.entries(options.tools);
    if (entries.length === 0) {
      throw new TypeError("A local source must define at least one tool");
    }

    const tools = new Map<string, LocalToolDefinition<any, any>>();
    const definitions: NormalizedTool[] = [];
    for (const [candidateName, tool] of entries) {
      const name = requiredName(candidateName, "Local tool name");
      if (tools.has(name)) {
        throw new TypeError(`Duplicate local tool name: ${name}`);
      }
      tools.set(name, tool);
      definitions.push({
        name,
        ...(tool.description === undefined
          ? {}
          : { description: tool.description }),
        inputSchema: jsonSchema(tool.inputSchema, "input"),
        ...(tool.outputSchema === undefined
          ? {}
          : { outputSchema: jsonSchema(tool.outputSchema, "output") }),
        ...(tool.annotations === undefined
          ? {}
          : { annotations: tool.annotations }),
        ...(tool.sideband === undefined ? {} : { sideband: tool.sideband }),
      });
    }
    this.#tools = tools;
    this.#definitions = definitions;
  }

  async start(
    context: ProviderStartContext,
  ): Promise<readonly NormalizedTool[]> {
    if (this.#closed) {
      throw new Error(`Local source ${this.sourceName} is closed`);
    }
    if (context.signal.aborted) {
      throw context.signal.reason;
    }
    return this.#definitions;
  }

  async call(context: ProviderCallContext): Promise<ProviderToolResult> {
    if (this.#closed) {
      throw new Error(`Local source ${this.sourceName} is closed`);
    }
    if (context.signal.aborted) {
      throw context.signal.reason;
    }
    const tool = this.#tools.get(context.tool);
    if (tool === undefined) {
      throw new Error(`Unknown local tool: ${context.tool}`);
    }

    const output = await tool.execute(context.input, {
      executionId: context.executionId,
      callId: context.callId,
      source: this.sourceName,
      tool: context.tool,
      signal: context.signal,
    });
    return {
      content: [{ type: "text", text: serializeOutput(output) }],
      structuredContent: output,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

/** Creates an application-owned tool source for the batteries-included facade. */
export function local(options: LocalToolSourceOptions): LocalToolProvider {
  return new LocalToolProvider(options);
}

function jsonSchema(
  schema: LocalToolInputSchema | LocalToolOutputSchema,
  mode: "input" | "output",
): JsonSchema {
  if (isStandardJsonSchema(schema)) {
    return schema["~standard"].jsonSchema[mode]({ target: "draft-2020-12" });
  }
  return schema;
}

function isStandardJsonSchema(
  schema: LocalToolInputSchema | LocalToolOutputSchema,
): schema is StandardJSONSchemaV1<JsonValue, JsonValue> {
  if (typeof schema !== "object" || schema === null || !("~standard" in schema)) {
    return false;
  }
  const standard = schema["~standard"];
  const converter =
    typeof standard === "object" &&
    standard !== null &&
    "jsonSchema" in standard &&
    typeof standard.jsonSchema === "object" &&
    standard.jsonSchema !== null
      ? (standard.jsonSchema as Record<string, unknown>)
      : undefined;
  return (
    converter !== undefined &&
    typeof converter.input === "function" &&
    typeof converter.output === "function"
  );
}

function serializeOutput(output: JsonValue): string {
  if (typeof output === "string") return output;
  const serialized = JSON.stringify(output);
  if (serialized === undefined) {
    throw new ProviderToolError("The local tool returned a non-JSON value");
  }
  return serialized;
}

function requiredName(value: string, label: string): string {
  const name = value.trim();
  if (name === "") throw new TypeError(`${label} must not be empty`);
  return name;
}

export { ProviderToolError as ToolError } from "@codemodekit/core";
