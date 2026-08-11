import { fileURLToPath } from "node:url";

import {
  CodeMode,
  TypeScriptCompiler,
  allowAllToolCalls,
  type ProviderCallContext,
} from "@codemodekit/core";
import {
  McpToolProvider,
  type McpSourceConfig,
} from "@codemodekit/mcp";
import { QuickJsSandbox } from "@codemodekit/sandbox-quickjs";
import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import { createMcpTransport } from "../packages/mcp/src/transport.js";
import {
  InMemoryTestToolProvider,
  echoTool,
} from "./support/in-memory-provider.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url),
);
const instances: CodeMode[] = [];
const providers: McpToolProvider[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
});

describe("McpToolProvider", () => {
  it("discovers and invokes tools through a real SDK-owned stdio client", async () => {
    const provider = createProvider("fixture");
    const tools = await provider.start({ signal: new AbortController().signal });

    expect(tools.map((tool) => tool.name)).toEqual([
      "echo",
      "hyphen-tool",
      "fail",
      "wait",
    ]);
    expect(tools).not.toContainEqual(expect.objectContaining({ name: "app-only" }));
    expect(JSON.stringify(tools.find((tool) => tool.name === "echo")?.sideband)).toContain(
      "definition-sideband",
    );

    const result = await provider.call(callContext("echo", { value: "hello" }));
    expect(result).toMatchObject({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { value: "hello", server: "stdio" },
    });
    expect(JSON.stringify(result.sideband)).toContain("result-sideband");
  });

  it("combines multiple real upstream MCP servers in one authored execution", async () => {
    const alpha = createProvider("alpha");
    const beta = createProvider("beta");
    const codeMode = new CodeMode({
      compiler: new TypeScriptCompiler(),
      sandbox: new QuickJsSandbox(),
      toolPolicy: allowAllToolCalls(),
      providers: [alpha, beta],
    });
    instances.push(codeMode);

    const startup = await codeMode.start();
    const result = await codeMode.run({
      code: `
        const [left, right] = await Promise.all([
          tools.alpha.echo({ value: "left" }),
          tools.beta["hyphen-tool"]({ value: "right" }),
        ]);
        return {
          left: left.structuredContent.value,
          right: right.structuredContent.value,
        };
      `,
    });

    expect(startup).toMatchObject({
      status: "ready",
      sources: [
        { source: "alpha", status: "healthy", toolCount: 4 },
        { source: "beta", status: "healthy", toolCount: 4 },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      value: { left: "left", right: "RIGHT" },
    });
    expect(JSON.stringify(result)).not.toContain("sideband");
  });

  it("orchestrates an MCP source and a provider-neutral source in one execution", async () => {
    const remote = createProvider("remote");
    const local = new InMemoryTestToolProvider({
      sourceName: "private-fixture",
      tools: [echoTool()],
    });
    const codeMode = new CodeMode({
      compiler: new TypeScriptCompiler(),
      sandbox: new QuickJsSandbox(),
      toolPolicy: allowAllToolCalls(),
      providers: [remote, local],
    });
    instances.push(codeMode);

    const result = await codeMode.run({
      code: `
        const remoteResult = await tools.remote.echo({ value: "from MCP" });
        const localResult = await tools["private-fixture"].echo({
          value: remoteResult.structuredContent.value,
        });
        return {
          remote: remoteResult.structuredContent.server,
          local: localResult.structuredContent.value,
        };
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { remote: "stdio", local: "from MCP" },
    });
    expect(local.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("sideband");
  });

  it("turns MCP isError results into actionable catchable sandbox failures", async () => {
    const provider = createProvider("fixture");
    const codeMode = new CodeMode({
      compiler: new TypeScriptCompiler(),
      sandbox: new QuickJsSandbox(),
      toolPolicy: allowAllToolCalls(),
      providers: [provider],
    });
    instances.push(codeMode);

    const result = await codeMode.run({
      code: `
        try {
          await tools.fixture.fail({});
          return { reached: true };
        } catch (error) {
          return { code: error.code, message: error.message };
        }
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        code: "TOOL_EXECUTION_FAILED",
        message: expect.stringContaining("retry with a non-empty string"),
      },
    });
    expect(JSON.stringify(result)).not.toContain("error-sideband");
  });

  it("propagates cancellation into the official MCP client call", async () => {
    const provider = createProvider("fixture");
    await provider.start({ signal: new AbortController().signal });
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = provider.call(
      callContext("wait", { delayMs: 5_000 }, controller.signal),
    );
    setTimeout(() => controller.abort(new Error("cancel test")), 25);

    await expect(pending).rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("reconnects after a real stdio child process disconnects", async () => {
    const provider = createProvider("recovering", { enableDisconnect: true });
    const codeMode = new CodeMode({
      compiler: new TypeScriptCompiler(),
      sandbox: new QuickJsSandbox(),
      toolPolicy: allowAllToolCalls(),
      providers: [provider],
      reconnect: {
        initialDelayMs: 200,
        maxDelayMs: 200,
        jitterRatio: 0,
      },
    });
    instances.push(codeMode);

    const startup = await codeMode.start();
    expect(startup).toMatchObject({
      status: "ready",
      sources: [{ source: "recovering", status: "healthy", toolCount: 5 }],
    });

    const disconnected = await codeMode.run({
      code: "return await tools.recovering.disconnect({});",
    });
    expect(disconnected).toMatchObject({
      ok: false,
      diagnostic: { code: "TOOL_EXECUTION_FAILED" },
    });
    expect(await codeMode.start()).toMatchObject({
      status: "degraded",
      sources: [{ source: "recovering", status: "unavailable", toolCount: 0 }],
    });

    const recovered = await waitForReady(codeMode);
    expect(recovered.sources).toEqual([
      { source: "recovering", status: "healthy", toolCount: 5 },
    ]);
    const later = await codeMode.run({
      code: 'return await tools.recovering.echo({ value: "restored" });',
    });
    expect(later).toMatchObject({
      ok: true,
      value: { structuredContent: { value: "restored", server: "stdio" } },
    });
  });

  it("atomically refreshes one source after tools/list_changed", async () => {
    const provider = createProvider("changing", { enableListChanged: true });
    const codeMode = new CodeMode({
      compiler: new TypeScriptCompiler(),
      sandbox: new QuickJsSandbox(),
      toolPolicy: allowAllToolCalls(),
      providers: [provider],
    });
    instances.push(codeMode);

    const startup = await codeMode.start();
    const initialTypes = await codeMode.getTypeScriptCatalog();
    expect(startup).toMatchObject({
      status: "ready",
      sources: [{ source: "changing", status: "healthy", toolCount: 5 }],
    });
    expect(initialTypes.declarations).not.toContain('readonly "dynamic-tool"');

    const pinnedExecution = await codeMode.run({
      code: `
        await tools.changing["enable-dynamic-tool"]({});
        try {
          await tools.changing["dynamic-tool"]({ value: "same execution" });
          return { reached: true };
        } catch (error) {
          return { code: error.code };
        }
      `,
    });
    expect(pinnedExecution).toMatchObject({
      ok: true,
      value: { code: "TOOL_NOT_FOUND" },
    });

    const refreshed = await waitForToolCount(codeMode, "changing", 6);
    expect(refreshed.catalogRevision).not.toBe(startup.catalogRevision);
    const refreshedTypes = await codeMode.getTypeScriptCatalog();
    expect(refreshedTypes.catalogRevision).toBe(refreshed.catalogRevision);
    expect(refreshedTypes.declarations).toContain('readonly "dynamic-tool"');
    const later = await codeMode.run({
      code: `
        return await tools.changing["dynamic-tool"]({ value: "later" });
      `,
    });
    expect(later).toMatchObject({
      ok: true,
      value: { structuredContent: { value: "later" } },
    });
  });

  it("owns and closes a client that is still starting", async () => {
    const provider = createProvider("closing");
    const starting = provider.start({ signal: new AbortController().signal });

    await provider.close();

    await expect(starting).rejects.toBeDefined();
    await expect(
      provider.start({ signal: new AbortController().signal }),
    ).rejects.toThrow(/closed/);
  });

  it("constructs every accepted upstream transport without connecting", () => {
    expect(
      createMcpTransport({ type: "stdio", command: process.execPath }),
    ).toBeInstanceOf(StdioClientTransport);
    expect(
      createMcpTransport({
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: { "x-test": "value" },
      }),
    ).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(
      createMcpTransport({
        type: "sse",
        url: "https://example.com/sse",
        headers: { "x-test": "value" },
      }),
    ).toBeInstanceOf(SSEClientTransport);
    expect(() =>
      createMcpTransport({ type: "streamable-http", url: "file:///tmp/mcp" }),
    ).toThrow(/http/);
  });
});

function createProvider(
  name: string,
  options: {
    readonly enableDisconnect?: boolean;
    readonly enableListChanged?: boolean;
  } = {},
): McpToolProvider {
  const config: McpSourceConfig = {
    name,
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [fixturePath],
      ...(options.enableDisconnect || options.enableListChanged
        ? {
            env: {
              ...(options.enableDisconnect
                ? { MCP_FIXTURE_ENABLE_DISCONNECT: "1" }
                : {}),
              ...(options.enableListChanged
                ? { MCP_FIXTURE_ENABLE_LIST_CHANGED: "1" }
                : {}),
            },
          }
        : {}),
      stderr: "pipe",
    },
    connectTimeoutMs: 5_000,
    discoveryTimeoutMs: 5_000,
    ...(options.enableListChanged ? { toolListChangedDebounceMs: 0 } : {}),
  };
  const provider = new McpToolProvider(config);
  providers.push(provider);
  return provider;
}

async function waitForReady(codeMode: CodeMode) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const report = await codeMode.start();
    if (report.status === "ready") {
      return report;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for MCP source recovery");
}

async function waitForToolCount(
  codeMode: CodeMode,
  source: string,
  toolCount: number,
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const report = await codeMode.start();
    if (
      report.sources.some(
        (candidate) =>
          candidate.source === source && candidate.toolCount === toolCount,
      )
    ) {
      return report;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${source} to expose ${toolCount} tools`);
}

function callContext(
  tool: string,
  input: ProviderCallContext["input"],
  signal: AbortSignal = new AbortController().signal,
): ProviderCallContext {
  return {
    executionId: "test-execution",
    callId: `test-call-${tool}`,
    tool,
    input,
    signal,
  };
}
