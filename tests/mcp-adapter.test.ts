import {
  CodeMode,
  TypeScriptCompiler,
  allowAllToolCalls,
} from "@codemodekit/core";
import { registerCodeModeTools } from "@codemodekit/mcp";
import { QuickJsSandbox } from "@codemodekit/sandbox-quickjs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  InMemoryTestToolProvider,
  echoTool,
  type InMemoryTool,
} from "./support/in-memory-provider.js";

const clients: Client[] = [];
const servers: McpServer[] = [];
const instances: CodeMode[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.allSettled(instances.splice(0).map((instance) => instance.close()));
});

describe("registerCodeModeTools", () => {
  it("composes run_typescript and search_tools on a consumer-owned MCP server", async () => {
    const codeMode = createCodeMode();
    const server = new McpServer({ name: "consumer-server", version: "1.0.0" });
    server.registerTool(
      "consumer_health",
      {
        description: "An unrelated consumer-owned tool",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: "text", text: "healthy" }] }),
    );
    registerCodeModeTools(server, { codeMode });
    const client = await connect(server);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "consumer_health",
      "run_typescript",
      "search_tools",
    ]);
    expect(listed.tools.find((tool) => tool.name === "run_typescript")?.annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    });
    expect(
      listed.tools.find((tool) => tool.name === "run_typescript")?.description,
    ).toContain("ToolResult wrapper");
    expect(
      listed.tools.find((tool) => tool.name === "run_typescript")?.description,
    ).toContain("inside this execution");
    expect(listed.tools.find((tool) => tool.name === "search_tools")?.annotations).toMatchObject({
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    });

    const search = await client.callTool({
      name: "search_tools",
      arguments: { query: "echo", detail: "typescript" },
    });
    expect(search.isError).not.toBe(true);
    expect(search.structuredContent).toMatchObject({
      returned: 1,
      truncated: false,
      resultContract: {
        declaration: expect.stringContaining("interface ToolResult"),
        guidance: expect.arrayContaining([
          expect.stringContaining("result.structuredContent"),
          expect.stringContaining("structuredContent.result"),
        ]),
        example: expect.stringContaining("JSON.parse"),
      },
      results: [
        {
          source: "deployment-api",
          tool: "echo",
          address: ["deployment-api", "echo"],
          callable: 'tools["deployment-api"].echo',
          typescript: {
            inputType: expect.stringContaining("value"),
            declaration: expect.stringContaining('tools["deployment-api"].echo'),
          },
        },
      ],
    });

    const execution = await client.callTool({
      name: "run_typescript",
      arguments: {
        code: `return await tools["deployment-api"].echo({ value: "through MCP" });`,
      },
    });
    expect(execution.isError).not.toBe(true);
    expect(execution.structuredContent).toMatchObject({
      ok: true,
      value: { structuredContent: { value: "through MCP" } },
    });

    const consumerTool = await client.callTool({
      name: "consumer_health",
      arguments: {},
    });
    expect(consumerTool.content).toContainEqual({ type: "text", text: "healthy" });
  });

  it("returns repairable execution failures as MCP tool errors", async () => {
    const codeMode = createCodeMode();
    const server = new McpServer({ name: "consumer-server", version: "1.0.0" });
    registerCodeModeTools(server, { codeMode });
    const client = await connect(server);

    const result = await client.callTool({
      name: "run_typescript",
      arguments: { code: "const broken: = 1;" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      diagnostic: {
        code: "CODE_COMPILE_FAILED",
        phase: "compile",
        message: expect.any(String),
      },
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("CODE_COMPILE_FAILED"),
    });
  });

  it("maps bounded lifecycle progress onto the caller's MCP progress stream", async () => {
    const delayed: InMemoryTool = {
      ...echoTool(),
      name: "delayed-echo",
      execute: async ({ input }) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          content: [{ type: "text", text: String(input.value) }],
          structuredContent: { value: input.value ?? null },
        };
      },
    };
    const codeMode = createCodeMode([delayed]);
    const server = new McpServer({ name: "consumer-server", version: "1.0.0" });
    registerCodeModeTools(server, { codeMode });
    const client = await connect(server);
    const progress: Array<{ progress: number; message?: string | undefined }> = [];

    const result = await client.callTool(
      {
        name: "run_typescript",
        arguments: {
          code: `return await tools["deployment-api"]["delayed-echo"]({ value: "done" });`,
        },
      },
      { onprogress: (event) => progress.push(event) },
    );

    expect(result.isError).not.toBe(true);
    expect(progress.length).toBeGreaterThanOrEqual(5);
    expect(progress.map((event) => event.progress)).toEqual(
      [...progress.map((event) => event.progress)].sort((left, right) => left - right),
    );
    expect(progress.map((event) => event.message)).toContain(
      "deployment-api.delayed-echo: started",
    );
  });

  it("propagates downstream MCP cancellation into an active provider call", async () => {
    let providerAborted = false;
    const blocking: InMemoryTool = {
      ...echoTool(),
      name: "blocking",
      execute: ({ signal }) =>
        new Promise((_resolve, reject) => {
          const abort = (): void => {
            providerAborted = true;
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
    };
    const codeMode = createCodeMode([blocking]);
    const server = new McpServer({ name: "consumer-server", version: "1.0.0" });
    registerCodeModeTools(server, { codeMode });
    const client = await connect(server);
    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: "run_typescript",
        arguments: {
          code: `return await tools["deployment-api"].blocking({ value: "wait" });`,
        },
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("cancel integration test")), 25);

    await expect(pending).rejects.toBeDefined();
    await waitFor(() => providerAborted);
    expect(providerAborted).toBe(true);
  });

  it("allows consumers to disable only search_tools", async () => {
    const codeMode = createCodeMode();
    const server = new McpServer({ name: "consumer-server", version: "1.0.0" });
    registerCodeModeTools(server, { codeMode, search: false });
    const client = await connect(server);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "run_typescript",
    ]);
    expect((await codeMode.getTypeScriptCatalog()).declarations).toContain(
      'readonly "deployment-api"',
    );
  });
});

function createCodeMode(tools: readonly InMemoryTool[] = [echoTool()]): CodeMode {
  const codeMode = new CodeMode({
    compiler: new TypeScriptCompiler(),
    sandbox: new QuickJsSandbox(),
    toolPolicy: allowAllToolCalls(),
    providers: [
      new InMemoryTestToolProvider({
        sourceName: "deployment-api",
        tools,
      }),
    ],
  });
  instances.push(codeMode);
  return codeMode;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  servers.push(server);
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
