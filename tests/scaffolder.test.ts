import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadAgentPlugin } from "@codemodekit/mcp";
import {
  buildAgentPlugin,
  getCursorPluginStatus,
  installCursorPlugin,
  parseMcpCommand,
  runCli,
  scaffoldAgentPlugin,
  scaffoldCodeModeMcp,
  syncAgentPluginSkill,
  uninstallCursorPlugin,
} from "create-codemodekit";
import type { CliPrompter } from "create-codemodekit";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url),
);
const execFileAsync = promisify(execFile);
const codemodekitPackageRoot = path.join(workspaceRoot, "packages", "codemodekit");
const clients: Client[] = [];
const httpServers: Server[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(
    httpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
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

  it("combines multiple sources and keeps HTTP credentials environment-backed", async () => {
    const directory = await mkdtemp(path.join(workspaceRoot, ".scaffold-multi-"));
    tempDirectories.push(directory);

    const result = await scaffoldCodeModeMcp({
      targetDirectory: directory,
      sources: [
        {
          type: "mcp-stdio",
          name: "issues",
          command: { command: process.execPath, args: [fixturePath] },
        },
        {
          type: "mcp-http",
          name: "knowledge",
          url: "https://example.com/mcp",
          bearerTokenEnv: "KNOWLEDGE_TOKEN",
          headerEnv: { "X-Tenant-ID": "KNOWLEDGE_TENANT" },
        },
      ],
      install: false,
    });

    const source = await readFile(result.entrypoint, "utf8");
    expect(source).toContain('name: "issues"');
    expect(source).toContain('name: "knowledge"');
    expect(source).toContain('requiredEnvironment("KNOWLEDGE_TOKEN")');
    expect(source).toContain('"X-Tenant-ID": requiredEnvironment("KNOWLEDGE_TENANT")');
    expect(source).not.toContain("Bearer secret-value");
    expect(await readFile(path.join(directory, ".env.example"), "utf8")).toContain(
      "KNOWLEDGE_TOKEN=",
    );
    expect(
      JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")),
    ).toMatchObject({ scripts: { verify: "node scripts/verify.mjs" } });
  });

  it("accepts repeated CLI source groups with HTTP auth mappings", async () => {
    const directory = path.join(
      await mkdtemp(path.join(workspaceRoot, ".scaffold-cli-multi-")),
      "generated",
    );
    tempDirectories.push(path.dirname(directory));

    await runCli(
      [
        directory,
        "--mcp-name",
        "fixture",
        "--mcp-command",
        `${process.execPath} ${fixturePath}`,
        "--mcp-name",
        "remote",
        "--mcp-url",
        "https://example.com/mcp",
        "--mcp-bearer-env",
        "REMOTE_TOKEN",
        "--mcp-header-env",
        "X-Workspace=REMOTE_WORKSPACE",
        "--no-agent-plugin",
        "--no-install",
      ],
      { write: () => undefined },
    );

    const source = await readFile(path.join(directory, "src", "server.mjs"), "utf8");
    expect(source).toContain('name: "fixture"');
    expect(source).toContain('name: "remote"');
    expect(source).toContain('requiredEnvironment("REMOTE_TOKEN")');
  });

  it("scaffolds the editable weather starter with Local Tools and an Agent Plugin", async () => {
    const directory = await mkdtemp(path.join(workspaceRoot, ".scaffold-weather-"));
    tempDirectories.push(directory);

    const result = await scaffoldCodeModeMcp({
      targetDirectory: directory,
      source: { type: "weather" },
      agentPlugin: true,
      install: false,
    });

    const source = await readFile(result.entrypoint, "utf8");
    expect(source).toContain("defineTool");
    expect(source).toContain("local({");
    expect(source).toContain("findLocation");
    expect(source).toContain("getCurrentWeather");
    expect(source).toContain("geocoding-api.open-meteo.com");
    expect(source).not.toContain("mcp.stdio");
    expect(await readFile(path.join(directory, ".env.example"), "utf8")).toContain(
      "OPEN_METEO_FORECAST_URL",
    );
    expect(await readFile(path.join(directory, "README.md"), "utf8")).toContain(
      "editable, keyless weather starter",
    );
    expect(result.agentPlugin).toMatchObject({
      skillName: "use-weather-codemode",
      synced: false,
    });

    await execFileAsync(process.execPath, [result.entrypoint, "--sync-plugin"], {
      cwd: directory,
      timeout: 10_000,
    });
    const tools = await readFile(
      path.join(
        directory,
        "skills",
        "use-weather-codemode",
        "references",
        "tools.d.ts",
      ),
      "utf8",
    );
    expect(tools).toContain("readonly findLocation");
    expect(tools).toContain("readonly getCurrentWeather");
  });

  it("runs the generated weather composition against overridable endpoints", async () => {
    const requests: string[] = [];
    const api = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/search") === true) {
        response.end(
          JSON.stringify({
            results: [
              {
                name: "Raleigh",
                country: "United States",
                latitude: 35.7796,
                longitude: -78.6382,
                timezone: "America/New_York",
              },
            ],
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          current: {
            time: "2026-08-12T07:00",
            temperature_2m: 24.5,
            apparent_temperature: 25.1,
            relative_humidity_2m: 70,
            precipitation: 0,
            weather_code: 1,
            wind_speed_10m: 8.2,
          },
          current_units: {
            temperature_2m: "°C",
            precipitation: "mm",
            wind_speed_10m: "km/h",
          },
        }),
      );
    });
    httpServers.push(api);
    const baseUrl = await listen(api);
    const directory = await mkdtemp(
      path.join(workspaceRoot, ".scaffold-weather-e2e-"),
    );
    tempDirectories.push(directory);
    const result = await scaffoldCodeModeMcp({
      targetDirectory: directory,
      source: { type: "weather" },
      install: false,
    });
    const client = await connectToServer(
      result.entrypoint,
      directory,
      {
        OPEN_METEO_GEOCODING_URL: `${baseUrl}/search`,
        OPEN_METEO_FORECAST_URL: `${baseUrl}/forecast`,
      },
    );

    const execution = await client.callTool({
      name: "run_typescript",
      arguments: {
        code: `
          const location = await tools.weather.findLocation({ query: "Raleigh" });
          const current = await tools.weather.getCurrentWeather({
            latitude: location.structuredContent.latitude,
            longitude: location.structuredContent.longitude,
          });
          return {
            location: location.structuredContent.name,
            temperature: current.structuredContent.temperature,
            condition: current.structuredContent.condition,
          };
        `,
      },
    });
    expect(execution).toMatchObject({
      structuredContent: {
        ok: true,
        value: { location: "Raleigh", temperature: 24.5, condition: "partly cloudy" },
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("name=Raleigh");
    expect(requests[1]).toContain("latitude=35.7796");
  });

  it("offers weather as the default interactive starter", async () => {
    const directory = path.join(
      await mkdtemp(path.join(workspaceRoot, ".scaffold-interactive-")),
      "weather-project",
    );
    tempDirectories.push(path.dirname(directory));
    const writes: string[] = [];
    const prompter: CliPrompter = {
      input: async (message, defaultValue) =>
        message === "Project directory" ? directory : (defaultValue ?? ""),
      select: async (_message, _choices, defaultValue) => defaultValue,
      confirm: async (_message, defaultValue) => defaultValue,
    };

    await runCli(["--no-install", "--no-sync"], {
      prompter,
      write: (value) => writes.push(value),
    });

    expect(await readFile(path.join(directory, "src", "server.mjs"), "utf8")).toContain(
      "getCurrentWeather",
    );
    expect(await lstat(path.join(directory, "plugin.json"))).toBeDefined();
    expect(writes.join("\n")).toContain("Agent Plugin: scaffolded");
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
    expect(result.authoringSkillDirectories).toEqual([
      path.join(directory, ".agents", "skills", "build-codemodekit-server"),
      path.join(directory, ".agents", "skills", "author-codemode-skill"),
    ]);
    expect(result.authoringSkillDirectory).toBe(
      result.authoringSkillDirectories?.[0],
    );
    expect(
      await readFile(
        path.join(result.authoringSkillDirectories?.[0] ?? "", "SKILL.md"),
        "utf8",
      ),
    ).toContain("# Build a CodeModeKit Server");
    expect(
      await readFile(
        path.join(result.authoringSkillDirectories?.[1] ?? "", "SKILL.md"),
        "utf8",
      ),
    ).toContain("# Author a Code Mode Skill");
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
          args: ["${PLUGIN_ROOT}/dist/plugin/server.mjs"],
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
      await readFile(path.join(references, "tools.fixture.d.ts"), "utf8"),
    ).toContain("readonly echo:");
    expect(
      JSON.parse(await readFile(path.join(references, "catalog-metadata.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 2,
      status: "ready",
      serverName: "fixture-code-mode",
      catalogRevision: expect.stringMatching(/^catalog-/),
      sources: [{ source: "fixture", status: "healthy", toolCount: 4 }],
      declarations: [
        { path: "tools.d.ts", scope: "catalog", toolCount: 4 },
        {
          path: "tools.fixture.d.ts",
          scope: "source",
          source: "fixture",
          toolCount: 4,
        },
      ],
      generatedFiles: ["tools.d.ts", "tools.fixture.d.ts"],
    });

    await writeFile(
      path.join(references, "tools.stale.d.ts"),
      "// Generated by CodeModeKit from an old catalog.\n",
      "utf8",
    );
    await writeFile(path.join(references, "domain-rules.md"), "# Keep me\n", "utf8");
    await execFileAsync(process.execPath, [result.entrypoint, "--sync-plugin"], {
      cwd: directory,
      timeout: 10_000,
    });
    await expectPathMissing(path.join(references, "tools.stale.d.ts"));
    expect(await readFile(path.join(references, "domain-rules.md"), "utf8")).toBe(
      "# Keep me\n",
    );
  }, 30_000);

  it("uses collision-safe declaration filenames for source and prefix shards", async () => {
    const directory = await mkdtemp(path.join(workspaceRoot, ".scaffold-shards-"));
    tempDirectories.push(directory);
    await scaffoldAgentPlugin({
      root: directory,
      pluginName: "sharded-plugin",
      serverName: "sharded-code-mode",
      skillName: "use-sharded-codemode",
    });
    const sources = ["foo/bar", "foo_bar"] as const;
    const result = await syncAgentPluginSkill({
      root: directory,
      skillName: "use-sharded-codemode",
      serverName: "sharded-code-mode",
      codeMode: {
        start: async () => ({
          status: "ready",
          catalogRevision: "catalog-collision",
          sources: sources.map((source) => ({
            source,
            status: "healthy" as const,
            toolCount: 60,
          })),
        }),
        getTypeScriptCatalog: async () => ({
          catalogRevision: "catalog-collision",
          declarations: "declare const tools: {};",
          sources: sources.map((source) => ({
            source,
            toolCount: 60,
            declarations: `declare const tools: { readonly ${JSON.stringify(source)}: {} };`,
            shards: [
              {
                key: "list/items",
                prefixes: ["list_items"],
                toolCount: 30,
                declarations: `declare const tools: { readonly ${JSON.stringify(source)}: {} };`,
              },
            ],
          })),
        }),
      },
    });

    expect(result.declarationFiles).toHaveLength(5);
    expect(new Set(result.declarationFiles).size).toBe(5);
    const metadata = JSON.parse(await readFile(result.metadata, "utf8")) as {
      generatedFiles: string[];
    };
    expect(metadata.generatedFiles).toHaveLength(5);
    expect(metadata.generatedFiles.filter((file) => file.includes("foo-bar"))).toHaveLength(4);
    await Promise.all(
      result.declarationFiles.map((file) =>
        expect(readFile(file, "utf8")).resolves.toContain(
          "Generated by CodeModeKit",
        ),
      ),
    );
  });

  it("builds a self-contained portable plugin that launches without node_modules", async () => {
    const directory = await generatedPluginProject("build");
    const result = await buildAgentPlugin({ root: directory });

    expect(result.artifactDirectory).toBe(path.join(directory, "dist", "plugin"));
    expect((await lstat(result.server)).isFile()).toBe(true);
    expect(
      (await lstat(path.join(result.artifactDirectory, "emscripten-module.wasm"))).isFile(),
    ).toBe(true);
    await expectPathMissing(path.join(result.artifactDirectory, "node_modules"));
    await expectPathMissing(path.join(result.artifactDirectory, ".env"));
    await expectPathMissing(path.join(result.artifactDirectory, ".agents"));

    const mcpConfig = JSON.parse(
      await readFile(path.join(result.artifactDirectory, "mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<string, { command: string; args: string[]; cwd?: string }>;
    };
    expect(mcpConfig.mcpServers["fixture-code-mode"]).toEqual({
      type: "stdio",
      command: "node",
      args: ["${PLUGIN_ROOT}/server.mjs"],
    });

    const client = await connectToServer(result.server, path.dirname(workspaceRoot));
    const execution = await client.callTool({
      name: "run_typescript",
      arguments: {
        code: `
          const result = await tools.fixture.echo({ value: "bundled" });
          return result.structuredContent.value;
        `,
      },
    });
    expect(execution).toMatchObject({
      structuredContent: { ok: true, value: "bundled" },
    });
  }, 30_000);

  it("installs a concrete Cursor copy with resolved runtime paths", async () => {
    const directory = await generatedPluginProject("cursor");
    const cursorHome = await mkdtemp(path.join(workspaceRoot, ".cursor-home-"));
    tempDirectories.push(cursorHome);
    await writeFile(path.join(directory, ".env"), "SECRET_DO_NOT_COPY=test\n", "utf8");

    const installation = await installCursorPlugin({
      root: directory,
      cursorHome,
      nodePath: process.execPath,
    });
    const installedDetails = await lstat(installation.destination);
    expect(installedDetails.isDirectory()).toBe(true);
    expect(installedDetails.isSymbolicLink()).toBe(false);
    await expectPathMissing(path.join(installation.destination, ".env"));
    await expectPathMissing(path.join(installation.destination, "node_modules"));
    await expectPathMissing(path.join(installation.destination, "src"));

    const installedMcp = JSON.parse(
      await readFile(path.join(installation.destination, "mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<string, { command: string; args: string[]; cwd?: string }>;
    };
    expect(installedMcp.mcpServers["fixture-code-mode"]).toEqual({
      type: "stdio",
      command: process.execPath,
      args: [path.join(installation.destination, "server.mjs")],
    });

    const installedServer = installedMcp.mcpServers["fixture-code-mode"]?.args[0];
    expect(installedServer).toBeDefined();
    const client = await connectToServer(installedServer ?? "", path.dirname(workspaceRoot));
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "run_typescript",
      "search_tools",
    ]);

    expect(
      await getCursorPluginStatus({ root: directory, cursorHome }),
    ).toMatchObject({ installed: true, destination: installation.destination });
    expect(
      await uninstallCursorPlugin({ root: directory, cursorHome }),
    ).toMatchObject({ installed: false, destination: installation.destination });
    await expectPathMissing(installation.destination);
  }, 30_000);

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

    const liveVerifier = path.join(directory, "verify-live.ts");
    await writeFile(
      liveVerifier,
      `const result = await tools.fixture.echo({ value: "verified" });
return { verified: result.structuredContent.value === "verified" };\n`,
      "utf8",
    );
    const verification = await execFileAsync("npm", ["run", "verify"], {
      cwd: directory,
      env: { ...process.env, CODEMODEKIT_VERIFY_CODE_FILE: liveVerifier },
      timeout: 20_000,
    });
    expect(verification.stdout).toContain("and live composition");
  }, 20_000);
});

async function generatedPluginProject(label: string): Promise<string> {
  const directory = await mkdtemp(
    path.join(workspaceRoot, `.scaffold-${label}-`),
  );
  tempDirectories.push(directory);
  await scaffoldCodeModeMcp({
    targetDirectory: directory,
    mcpName: "fixture",
    mcpCommand: { command: process.execPath, args: [fixturePath] },
    serverName: "fixture-code-mode",
    agentPlugin: true,
    install: false,
  });
  const modules = path.join(directory, "node_modules");
  await mkdir(modules, { recursive: true });
  await symlink(
    codemodekitPackageRoot,
    path.join(modules, "codemodekit"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return directory;
}

async function connectToServer(
  server: string,
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<Client> {
  const client = new Client(
    { name: "plugin-distribution-client", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: "auto",
        probe: { timeoutMs: 5_000, maxRetries: 0 },
      },
      inputRequired: { autoFulfill: false },
    },
  );
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      cwd,
      env: { PATH: process.env.PATH ?? "", ...environment },
      stderr: "pipe",
    }),
    { timeout: 10_000 },
  );
  return client;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Weather fixture did not bind a TCP port");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

async function expectPathMissing(file: string): Promise<void> {
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
}
