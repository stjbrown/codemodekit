import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  allowAllToolCalls,
  createCodeModeMcp,
  mcp,
  serveCodeModeHttp,
  type CodeModeObservation,
} from "codemodekit";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

const fixturePath = fileURLToPath(
  new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url),
);
const applications: Array<ReturnType<typeof createCodeModeMcp>> = [];
const clients: Client[] = [];
const servers: McpServer[] = [];
const httpServers: Array<Awaited<ReturnType<typeof serveCodeModeHttp>>> = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.allSettled(httpServers.splice(0).map((server) => server.close()));
  await Promise.allSettled(
    applications.splice(0).map((application) => application.close()),
  );
});

describe("codemodekit", () => {
  it("provides a TypeScript + QuickJS Code Mode MCP from the beginner API", async () => {
    const observations: CodeModeObservation[] = [];
    const application = createCodeModeMcp({
      name: "facade-test",
      version: "1.0.0",
      toolPolicy: allowAllToolCalls(),
      sources: [
        mcp.stdio({
          name: "fixture",
          command: process.execPath,
          args: [fixturePath],
        }),
      ],
      observer: (event) => {
        observations.push(event);
      },
    });
    applications.push(application);

    const startup = await application.start();
    expect(startup.sources).toMatchObject([
      { source: "fixture", status: "healthy", toolCount: 4 },
    ]);

    const server = application.createServer();
    servers.push(server);
    const client = await connect(server);

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "run_typescript",
      "search_tools",
    ]);

    const search = await client.callTool({
      name: "search_tools",
      arguments: { query: "echo", source: "fixture", detail: "typescript" },
    });
    expect(search.structuredContent).toMatchObject({
      returned: 1,
      results: [{ callable: "tools.fixture.echo" }],
    });

    const execution = await client.callTool({
      name: "run_typescript",
      arguments: {
        code: `
          const result = await tools.fixture.echo({ value: "simple" });
          return result.structuredContent;
        `,
      },
    });
    expect(execution).toMatchObject({
      structuredContent: {
        ok: true,
        value: { value: "simple", server: "stdio" },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observations.map((event) => event.type)).toEqual([
      "execution_started",
      "tool_call_queued",
      "tool_call_started",
      "tool_call_completed",
      "execution_completed",
    ]);
  }, 20_000);

  it("constructs stdio sources without requiring transport boilerplate", () => {
    const provider = mcp.stdio({
      name: "fixture",
      command: process.execPath,
      args: [path.basename(fixturePath)],
    });
    expect(provider.sourceName).toBe("fixture");
  });

  it("serves the same application over Streamable HTTP", async () => {
    const served = await serveCodeModeHttp({
      name: "http-facade-test",
      version: "1.0.0",
      toolPolicy: allowAllToolCalls(),
      sources: [
        mcp.stdio({
          name: "fixture",
          command: process.execPath,
          args: [fixturePath],
        }),
      ],
      port: 0,
      handleProcessSignals: false,
    });
    httpServers.push(served);
    expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);

    const client = new Client(
      { name: "http-facade-client", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: "auto",
          probe: { timeoutMs: 5_000, maxRetries: 0 },
        },
        inputRequired: { autoFulfill: false },
      },
    );
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(served.url)), {
      timeout: 10_000,
    });

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "run_typescript",
      "search_tools",
    ]);
    const execution = await client.callTool({
      name: "run_typescript",
      arguments: {
        code: `
          const result = await tools.fixture.echo({ value: "http" });
          return result.structuredContent.value;
        `,
      },
    });
    expect(execution).toMatchObject({
      structuredContent: { ok: true, value: "http" },
    });
  }, 20_000);
});

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "facade-client", version: "1.0.0" });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
