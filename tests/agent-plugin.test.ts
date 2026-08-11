import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CodeMode,
  TypeScriptCompiler,
  allowAllToolCalls,
} from "@codemodekit/core";
import {
  AgentPluginLoadError,
  loadAgentPlugin,
  type McpToolProvider,
} from "@codemodekit/mcp";
import { QuickJsSandbox } from "@codemodekit/sandbox-quickjs";
import { afterEach, describe, expect, it } from "vitest";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/agent-plugin", import.meta.url),
);
const tempDirectories: string[] = [];
const instances: CodeMode[] = [];
const detachedProviders: McpToolProvider[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
  await Promise.all(
    detachedProviders.splice(0).map((provider) => provider.close()),
  );
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Agent Plugins 1.0 MCP loading", () => {
  it("loads multiple valid entries, preserves exact names, and skips an invalid sibling", async () => {
    const dataDir = await temporaryDirectory("code-mode-plugin-data-");
    const plugin = await loadAgentPlugin({
      root: fixtureRoot,
      dataDir,
      baseEnv: { PATH: process.env.PATH ?? "" },
      connectTimeoutMs: 5_000,
      discoveryTimeoutMs: 5_000,
    });

    expect(plugin).toMatchObject({
      manifest: { name: "code-mode-test-plugin", version: "1.0.0" },
      mcp: { status: "loaded" },
    });
    expect(plugin.mcp.providers.map((provider) => provider.sourceName)).toEqual([
      "plugin-primary",
      "deployment-api",
    ]);
    expect(plugin.diagnostics).toEqual([
      expect.objectContaining({
        code: "PLUGIN_MANIFEST_FIELD_IGNORED",
      }),
      expect.objectContaining({
        code: "PLUGIN_MCP_SERVER_INVALID",
        server: "invalid-escape",
      }),
    ]);

    const codeMode = new CodeMode({
      compiler: new TypeScriptCompiler(),
      sandbox: new QuickJsSandbox(),
      toolPolicy: allowAllToolCalls(),
      providers: plugin.mcp.providers,
    });
    instances.push(codeMode);
    const startup = await codeMode.start();
    const result = await codeMode.run({
      code: `
        const [first, second] = await Promise.all([
          tools["plugin-primary"].echo({ value: "one" }),
          tools["deployment-api"]["hyphen-tool"]({ value: "two" }),
        ]);
        return [first.structuredContent.value, second.structuredContent.value];
      `,
    });

    expect(startup).toMatchObject({
      status: "ready",
      sources: [
        { source: "plugin-primary", status: "healthy", toolCount: 4 },
        { source: "deployment-api", status: "healthy", toolCount: 4 },
      ],
    });
    expect(result).toMatchObject({ ok: true, value: ["one", "TWO"] });
  });

  it("disables only the MCP component when top-level mcp.json is invalid", async () => {
    const root = await temporaryPlugin({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {},
      unexpected: true,
    });
    const plugin = await loadAgentPlugin({
      root,
      dataDir: await temporaryDirectory("code-mode-plugin-data-"),
    });

    expect(plugin.manifest.name).toBe("temporary-plugin");
    expect(plugin).toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: "PLUGIN_MCP_CONFIG_INVALID" }),
      ],
      mcp: {
        status: "invalid",
        providers: [],
      },
    });
  });

  it("rejects a fatally invalid manifest before discovering components", async () => {
    const root = await temporaryPlugin(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {},
      },
      { name: "Not-A-Valid-Plugin-Name" },
    );

    await expect(
      loadAgentPlugin({
        root,
        dataDir: await temporaryDirectory("code-mode-plugin-data-"),
      }),
    ).rejects.toMatchObject({
      name: "AgentPluginLoadError",
      diagnostics: [
        expect.objectContaining({ code: "PLUGIN_MANIFEST_INVALID" }),
      ],
    } satisfies Partial<AgentPluginLoadError>);
  });

  it("enforces remote URL and header rules per server entry", async () => {
    const root = await temporaryPlugin({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        secure: {
          type: "streamable-http",
          url: "https://mcp.example.com/service",
          headers: { "X-Tenant": "public" },
        },
        loopback: {
          type: "sse",
          url: "http://127.0.0.1:3333/sse",
        },
        insecure: {
          type: "streamable-http",
          url: "http://mcp.example.com/service",
        },
        fragment: {
          type: "sse",
          url: "https://mcp.example.com/sse#secret",
        },
        duplicateHeaders: {
          type: "streamable-http",
          url: "https://mcp.example.com/service",
          headers: { "X-Test": "one", "x-test": "two" },
        },
      },
    });
    const plugin = await loadAgentPlugin({
      root,
      dataDir: await temporaryDirectory("code-mode-plugin-data-"),
    });
    detachedProviders.push(...plugin.mcp.providers);

    expect(plugin.mcp.providers.map((provider) => provider.sourceName)).toEqual([
      "secure",
      "loopback",
    ]);
    expect(
      plugin.diagnostics
        .filter((diagnostic) => diagnostic.code === "PLUGIN_MCP_SERVER_INVALID")
        .map((diagnostic) => diagnostic.server),
    ).toEqual(["insecure", "fragment", "duplicateHeaders"]);
  });

  it("rejects an mcp.json symlink that resolves outside the plugin root", async () => {
    const root = await temporaryPlugin(undefined);
    const outside = await temporaryDirectory("code-mode-plugin-outside-");
    const outsideConfig = path.join(outside, "outside-mcp.json");
    await writeFile(
      outsideConfig,
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {},
      }),
    );
    await symlink(outsideConfig, path.join(root, "mcp.json"));

    const plugin = await loadAgentPlugin({
      root,
      dataDir: await temporaryDirectory("code-mode-plugin-data-"),
    });
    expect(plugin).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "PLUGIN_MCP_CONFIG_INVALID",
          message: expect.stringContaining("outside the plugin root"),
        }),
      ],
      mcp: {
        status: "invalid",
        providers: [],
      },
    });
  });
});

async function temporaryPlugin(
  mcp: unknown | undefined,
  manifestOverrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const root = await temporaryDirectory("code-mode-plugin-");
  await writeFile(
    path.join(root, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "temporary-plugin",
      ...manifestOverrides,
    }),
  );
  if (mcp !== undefined) {
    await writeFile(path.join(root, "mcp.json"), JSON.stringify(mcp));
  }
  return root;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}
