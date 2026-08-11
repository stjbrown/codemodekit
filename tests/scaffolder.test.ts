import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  parseMcpCommand,
  scaffoldCodeModeMcp,
} from "create-codemodekit";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url),
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

describe("create-codemodekit", () => {
  it("parses quoted MCP commands into an executable and arguments", () => {
    expect(
      parseMcpCommand(
        `uvx --env-file ".env local" zscaler-mcp --label 'Sales team'`,
      ),
    ).toEqual({
      command: "uvx",
      args: [
        "--env-file",
        ".env local",
        "zscaler-mcp",
        "--label",
        "Sales team",
      ],
    });
  });

  it.each(["uvx tool | tee out", "uvx tool > out", "uvx $(whoami)"])(
    "rejects shell syntax in %s",
    (command) => {
      expect(() => parseMcpCommand(command)).toThrow(/Shell operators/);
    },
  );

  it("renders a one-file server with no compiler or sandbox setup", async () => {
    const directory = await mkdtemp(path.join(workspaceRoot, ".scaffold-render-"));
    tempDirectories.push(directory);

    const result = await scaffoldCodeModeMcp({
      targetDirectory: directory,
      mcpName: "zscaler",
      mcpCommand: parseMcpCommand("uvx zscaler-mcp"),
      serverName: "zscaler-code-mode",
      install: false,
    });

    const source = await readFile(result.entrypoint, "utf8");
    expect(source).toContain("serveCodeModeStdio");
    expect(source).toContain('command: "uvx"');
    expect(source).toContain('args: ["zscaler-mcp"]');
    expect(source).not.toMatch(/TypeScriptCompiler|QuickJsSandbox/);
  });

  it("generates a server that completes search and sandbox execution end to end", async () => {
    const directory = await mkdtemp(path.join(workspaceRoot, ".scaffold-e2e-"));
    tempDirectories.push(directory);

    const result = await scaffoldCodeModeMcp({
      targetDirectory: directory,
      mcpName: "fixture",
      mcpCommand: { command: process.execPath, args: [fixturePath] },
      serverName: "generated-integration-test",
      install: false,
    });

    const client = new Client(
      { name: "generated-server-client", version: "1.0.0" },
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
      args: [result.entrypoint],
      stderr: "pipe",
    });
    await client.connect(transport, { timeout: 10_000 });

    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "run_typescript",
      "search_tools",
    ]);

    const search = await client.callTool({
      name: "search_tools",
      arguments: { query: "echo", detail: "typescript" },
    });
    expect(search.structuredContent).toMatchObject({
      returned: 1,
      results: [{ source: "fixture", tool: "echo" }],
    });

    const execution = await client.callTool({
      name: "run_typescript",
      arguments: {
        code: `
          const result = await tools.fixture.echo({ value: "generated" });
          return result.structuredContent.value;
        `,
      },
    });
    expect(execution).toMatchObject({
      structuredContent: { ok: true, value: "generated" },
    });
  }, 20_000);
});
