import { fileURLToPath } from "node:url";

import { type ProviderCallContext } from "@codemodekit/core";
import { McpToolProvider } from "@codemodekit/mcp";

import {
  InMemoryTestToolProvider,
  echoTool,
  failingTool,
  waitTool,
} from "./support/in-memory-provider.js";
import {
  providerConformanceSuite,
  type ProviderConformanceHarness,
} from "./support/provider-conformance.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url),
);

providerConformanceSuite("in-memory", createInMemoryHarness);
providerConformanceSuite("MCP stdio", createMcpHarness);

function createInMemoryHarness(): ProviderConformanceHarness {
  const provider = new InMemoryTestToolProvider({
    sourceName: "conformance-memory",
    tools: [echoTool(), failingTool(), waitTool()],
  });
  return {
    provider,
    definitionSidebandMarker: "ui://fixture/echo",
    resultSidebandMarker: "host-only",
    triggerCatalogChange: async () => {
      const dynamic = dynamicTool();
      provider.replaceTools([echoTool(), failingTool(), waitTool(), dynamic]);
    },
  };
}

function createMcpHarness(): ProviderConformanceHarness {
  const provider = new McpToolProvider({
    name: "conformance-mcp",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [fixturePath],
      env: { MCP_FIXTURE_ENABLE_LIST_CHANGED: "1" },
      stderr: "pipe",
    },
    connectTimeoutMs: 5_000,
    discoveryTimeoutMs: 5_000,
    toolListChangedDebounceMs: 0,
  });
  return {
    provider,
    definitionSidebandMarker: "definition-sideband",
    resultSidebandMarker: "result-sideband",
    triggerCatalogChange: async () => {
      await provider.call(callContext("enable-dynamic-tool", {}));
    },
  };
}

function dynamicTool() {
  return {
    ...echoTool(),
    name: "dynamic-tool",
  };
}

function callContext(
  tool: string,
  input: ProviderCallContext["input"],
): ProviderCallContext {
  return {
    executionId: "provider-conformance-change",
    callId: `provider-conformance-change:${tool}`,
    tool,
    input,
    signal: new AbortController().signal,
  };
}
