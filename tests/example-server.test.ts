import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

const examplePath = fileURLToPath(
  new URL("../examples/dist/agent-plugin-stdio-server.js", import.meta.url),
);
const pluginRoot = fileURLToPath(
  new URL("./fixtures/agent-plugin", import.meta.url),
);
const clients: Client[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("agent-plugin stdio server example", () => {
  it("serves the complete two-upstream Code Mode flow to an MCP client", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "code-mode-example-data-"));
    tempDirectories.push(dataDir);
    const client = new Client(
      { name: "example-integration-test", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: "auto",
          probe: { timeoutMs: 5_000, maxRetries: 0 },
        },
        inputRequired: { autoFulfill: false },
      },
    );
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [examplePath, pluginRoot, dataDir],
      stderr: "pipe",
    });
    await client.connect(transport, { timeout: 10_000 });

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "run_typescript",
      "search_tools",
    ]);

    const search = await client.callTool({
      name: "search_tools",
      arguments: {
        query: "hyphen-tool",
        source: "deployment-api",
        detail: "typescript",
      },
    });
    expect(search.structuredContent).toMatchObject({
      returned: 1,
      resultContract: {
        declaration: expect.stringContaining("interface ToolResult"),
        guidance: expect.arrayContaining([
          expect.stringContaining("one run_typescript execution"),
        ]),
      },
      results: [
        {
          source: "deployment-api",
          tool: "hyphen-tool",
          callable: 'tools["deployment-api"]["hyphen-tool"]',
        },
      ],
    });

    const execution = await client.callTool({
      name: "run_typescript",
      arguments: {
        code: `
          const [left, right] = await Promise.all([
            tools["plugin-primary"].echo({ value: "one" }),
            tools["deployment-api"]["hyphen-tool"]({ value: "two" }),
          ]);
          return [left.structuredContent.value, right.structuredContent.value];
        `,
      },
    });
    expect(execution.isError).not.toBe(true);
    expect(execution).toMatchObject({
      structuredContent: { ok: true, value: ["one", "TWO"] },
    });
  }, 20_000);
});
