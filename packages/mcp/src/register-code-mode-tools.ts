import {
  type CodeMode,
  type CodeModeProgress,
  type SearchToolsRequest,
} from "@codemodekit/core";
import {
  type CallToolResult,
  type JSONObject,
  type McpServer,
  type RegisteredTool,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export interface RegisterCodeModeToolsOptions {
  readonly codeMode: CodeMode;
  /** Register bounded local catalog discovery. Defaults to true. */
  readonly search?: boolean;
}

export interface RegisteredCodeModeTools {
  readonly runTypeScript: RegisteredTool;
  readonly searchTools?: RegisteredTool;
}

const runTypeScriptInput = z.object({
  code: z
    .string()
    .describe(
      "TypeScript async-function body. Use top-level await and an explicit return. Every tools.* call returns { content, structuredContent? }, not the upstream payload directly. Keep tool calls, extraction, and transformation inside this execution. Imports and host APIs are unavailable.",
    ),
});

const searchToolsInput = z.object({
  query: z
    .string()
    .transform((value) => value.trim())
    .refine(isBoundedQuery, {
      message: "query must contain 1 to 256 Unicode scalar values",
    }),
  source: z.string().optional().describe("Exact configured source name"),
  detail: z.enum(["summary", "typescript"]).optional().default("summary"),
  limit: z.number().int().min(1).max(8).optional().default(5),
});

export function registerCodeModeTools(
  server: McpServer,
  options: RegisterCodeModeToolsOptions,
): RegisteredCodeModeTools {
  const runTypeScript = server.registerTool(
    "run_typescript",
    {
      title: "Run TypeScript",
      description:
        "Execute one bounded TypeScript async-function body against the configured tools catalog. Use generated declaration references when available; use search_tools with detail=typescript for stale, missing, or unfamiliar capabilities. Every tools.* call returns a ToolResult wrapper: prefer result.structuredContent, inspect unknown shapes such as structuredContent.result, and only fall back to guarded JSON text from result.content. Compose related calls inside this execution, project only requested fields, cap returned collections, and return summaries instead of raw upstream payloads. Imports and host APIs are unavailable. Returns actionable diagnostics for repair.",
      inputSchema: runTypeScriptInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ code }, context): Promise<CallToolResult> => {
      const result = await options.codeMode.run({
        code,
        signal: context.mcpReq.signal,
        ...progressRelay(context),
      });
      return asToolResult(result, !result.ok);
    },
  );

  if (options.search === false) {
    return { runTypeScript };
  }

  const searchTools = server.registerTool(
    "search_tools",
    {
      title: "Search Tools",
      description:
        "Search the active Code Mode catalog locally. Use detail=typescript for exact callable expressions, conservative types, and the self-contained ToolResult contract with an extraction example.",
      inputSchema: searchToolsInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context): Promise<CallToolResult> => {
      const request: SearchToolsRequest = {
        query: input.query,
        detail: input.detail,
        limit: input.limit,
        ...(input.source === undefined ? {} : { source: input.source }),
      };
      const result = await options.codeMode.searchTools(
        request,
        context.mcpReq.signal,
      );
      return asToolResult(result, result.diagnostic !== undefined);
    },
  );

  return { runTypeScript, searchTools };
}

function progressRelay(
  context: Parameters<Parameters<McpServer["registerTool"]>[2]>[1],
): { readonly onProgress?: (event: CodeModeProgress) => void } {
  const progressToken = context.mcpReq._meta?.progressToken;
  if (progressToken === undefined) {
    return {};
  }
  const deliveryTimes: number[] = [];
  let delivered = 0;
  return {
    onProgress: (event): void => {
      if (delivered >= 100) return;
      const now = Date.now();
      while (deliveryTimes.length > 0 && (deliveryTimes[0] ?? now) <= now - 1_000) {
        deliveryTimes.shift();
      }
      if (deliveryTimes.length >= 10) return;
      deliveryTimes.push(now);
      delivered += 1;
      void context.mcpReq.notify({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: event.sequence,
          message: event.message,
        },
      }).catch(() => undefined);
    },
  };
}

function asToolResult(value: object, isError: boolean): CallToolResult {
  const text = JSON.stringify(value);
  return {
    content: [{ type: "text", text }],
    structuredContent: JSON.parse(text) as JSONObject,
    ...(isError ? { isError: true } : {}),
  };
}

function isBoundedQuery(value: string): boolean {
  const scalars = [...value];
  return (
    scalars.length >= 1 &&
    scalars.length <= 256 &&
    scalars.every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 0xd800 || point > 0xdfff;
    })
  );
}
