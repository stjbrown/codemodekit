import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadAgentPlugin } from "@codemodekit/mcp";
import {
  parseMcpCommand,
  scaffoldAgentPlugin,
  scaffoldCodeModeMcp,
  syncAgentPluginSkill,
} from "create-codemodekit";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url),
);
const execFileAsync = promisify(execFile);
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

  it("installs dependencies by default for programmatic callers", async () => {
    const parent = await mkdtemp(path.join(workspaceRoot, ".scaffold-install-"));
    tempDirectories.push(parent);
    const fakePackage = path.join(parent, "fake-codemodekit");
    await writeFile(
      path.join(parent, "package.json"),
      `${JSON.stringify({ private: true })}\n`,
      "utf8",
    );
    await mkdir(fakePackage, { recursive: true });
    await writeFile(
      path.join(fakePackage, "package.json"),
      `${JSON.stringify({ name: "codemodekit", version: "0.1.0", type: "module" })}\n`,
      "utf8",
    );

    const previousAllowScripts = process.env.npm_config_allow_scripts;
    process.env.npm_config_allow_scripts = "true";
    const result = await (async () => {
      try {
        return await scaffoldCodeModeMcp({
          targetDirectory: path.join(parent, "generated"),
          mcpName: "fixture",
          mcpCommand: { command: process.execPath, args: [fixturePath] },
          codemodekitVersion: `file:${fakePackage}`,
        });
      } finally {
        if (previousAllowScripts === undefined) {
          delete process.env.npm_config_allow_scripts;
        } else {
          process.env.npm_config_allow_scripts = previousAllowScripts;
        }
      }
    })();

    expect(result.installed).toBe(true);
    expect(
      JSON.parse(
        await readFile(
          path.join(result.directory, "node_modules", "codemodekit", "package.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ name: "codemodekit", version: "0.1.0" });
  });

  it("scaffolds a portable Agent Plugin with a companion runtime skill", async () => {
    const directory = await mkdtemp(path.join(workspaceRoot, ".scaffold-plugin-"));
    tempDirectories.push(directory);

    const result = await scaffoldCodeModeMcp({
      targetDirectory: directory,
      mcpName: "fixture",
      mcpCommand: { command: process.execPath, args: [fixturePath] },
      serverName: "fixture-code-mode",
      agentPlugin: true,
      install: false,
    });

    expect(result.agentPlugin).toMatchObject({
      skillName: "use-fixture-codemode",
      synced: false,
    });
    expect(JSON.parse(await readFile(path.join(directory, "plugin.json"), "utf8"))).toMatchObject({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: expect.stringMatching(/^scaffold-plugin-/),
    });
    expect(JSON.parse(await readFile(path.join(directory, "mcp.json"), "utf8"))).toMatchObject({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        "fixture-code-mode": {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/src/server.mjs"],
        },
      },
    });
    const skillRoot = path.join(directory, "skills", "use-fixture-codemode");
    expect(await readFile(path.join(skillRoot, "SKILL.md"), "utf8")).toContain(
      "references/tools.d.ts",
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(skillRoot, "references", "catalog-metadata.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ status: "pending", serverName: "fixture-code-mode" });

    const loaded = await loadAgentPlugin({
      root: directory,
      dataDir: path.join(directory, ".plugin-data"),
    });
    expect(loaded).toMatchObject({
      manifest: { name: expect.stringMatching(/^scaffold-plugin-/) },
      mcp: { status: "loaded" },
    });
    expect(loaded.mcp.providers.map((provider) => provider.sourceName)).toEqual([
      "fixture-code-mode",
    ]);
    await Promise.all(loaded.mcp.providers.map((provider) => provider.close()));
  });

  it("syncs generated Agent Plugin references from the live Code Mode catalog", async () => {
    const directory = await mkdtemp(path.join(workspaceRoot, ".scaffold-sync-"));
    tempDirectories.push(directory);

    const result = await scaffoldCodeModeMcp({
      targetDirectory: directory,
      mcpName: "fixture",
      mcpCommand: { command: process.execPath, args: [fixturePath] },
      serverName: "fixture-code-mode",
      agentPlugin: true,
      install: false,
    });
    await execFileAsync(process.execPath, [result.entrypoint, "--sync-plugin"], {
      cwd: directory,
      timeout: 10_000,
    });

    const references = path.join(
      directory,
      "skills",
      "use-fixture-codemode",
      "references",
    );
    expect(await readFile(path.join(references, "tools.d.ts"), "utf8")).toContain(
      "readonly echo:",
    );
    expect(
      JSON.parse(await readFile(path.join(references, "catalog-metadata.json"), "utf8")),
    ).toMatchObject({
      status: "ready",
      serverName: "fixture-code-mode",
      catalogRevision: expect.stringMatching(/^catalog-/),
      sources: [{ source: "fixture", status: "healthy", toolCount: 4 }],
    });
  }, 20_000);

  it("refuses to publish a partial catalog as complete skill documentation", async () => {
    const directory = await mkdtemp(path.join(workspaceRoot, ".scaffold-degraded-"));
    tempDirectories.push(directory);
    await scaffoldAgentPlugin({
      root: directory,
      pluginName: "degraded-plugin",
      serverName: "degraded-code-mode",
      skillName: "use-degraded-codemode",
    });

    await expect(
      syncAgentPluginSkill({
        root: directory,
        skillName: "use-degraded-codemode",
        serverName: "degraded-code-mode",
        codeMode: {
          start: async () => ({
            status: "degraded",
            catalogRevision: "catalog-1",
            sources: [
              { source: "offline", status: "unavailable", toolCount: 0 },
            ],
          }),
          getTypeScriptCatalog: async () => ({
            catalogRevision: "catalog-1",
            declarations: "declare const tools: {};",
          }),
        },
      }),
    ).rejects.toThrow(/sources are unavailable: offline/);

    expect(
      JSON.parse(
        await readFile(
          path.join(
            directory,
            "skills",
            "use-degraded-codemode",
            "references",
            "catalog-metadata.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ status: "pending" });
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
