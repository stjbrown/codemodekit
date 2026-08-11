import {
  CodeMode,
  TypeScriptCompiler,
  allowAllToolCalls,
  type ProviderCallContext,
  type ToolProvider,
} from "@codemodekit/core";
import { QuickJsSandbox } from "@codemodekit/sandbox-quickjs";
import { describe, expect, it } from "vitest";

export interface ProviderConformanceHarness {
  readonly provider: ToolProvider;
  readonly definitionSidebandMarker: string;
  readonly resultSidebandMarker: string;
  readonly triggerCatalogChange: () => Promise<void>;
}

export function providerConformanceSuite(
  label: string,
  createHarness: () => ProviderConformanceHarness,
): void {
  describe(`${label} provider conformance`, () => {
    it("discovers exact normalized definitions and retains trusted sideband", async () => {
      const harness = createHarness();
      try {
        const definitions = await harness.provider.start({
          signal: new AbortController().signal,
        });
        const echo = definitions.find((tool) => tool.name === "echo");

        expect(harness.provider.sourceName).toBeTruthy();
        expect(echo).toMatchObject({
          name: "echo",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
          outputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        });
        expect(JSON.stringify(echo?.sideband)).toContain(
          harness.definitionSidebandMarker,
        );
      } finally {
        await harness.provider.close();
      }
    });

    it("invokes tools with computation-facing results and trusted result sideband", async () => {
      const harness = createHarness();
      try {
        await harness.provider.start({ signal: new AbortController().signal });
        const result = await harness.provider.call(
          callContext("echo", { value: "conformance" }),
        );

        expect(result).toMatchObject({
          content: [{ type: "text", text: "conformance" }],
          structuredContent: { value: "conformance" },
        });
        expect(JSON.stringify(result.sideband)).toContain(
          harness.resultSidebandMarker,
        );
      } finally {
        await harness.provider.close();
      }
    });

    it("maps provider-declared failures through the provider-neutral core", async () => {
      const harness = createHarness();
      const codeMode = new CodeMode({
        compiler: new TypeScriptCompiler(),
        sandbox: new QuickJsSandbox(),
        toolPolicy: allowAllToolCalls(),
        providers: [harness.provider],
      });
      try {
        const result = await codeMode.run({
          code: `return await tools[${JSON.stringify(harness.provider.sourceName)}].fail({});`,
        });
        expect(result).toMatchObject({
          ok: false,
          diagnostic: {
            code: "TOOL_EXECUTION_FAILED",
            phase: "tool",
            message: expect.stringContaining("retry with a non-empty string"),
          },
        });
      } finally {
        await codeMode.close();
      }
    });

    it("propagates cancellation into an active provider invocation", async () => {
      const harness = createHarness();
      try {
        await harness.provider.start({ signal: new AbortController().signal });
        const controller = new AbortController();
        const pending = harness.provider.call(
          callContext("wait", { delayMs: 5_000 }, controller.signal),
        );
        setTimeout(() => controller.abort(new Error("conformance cancellation")), 20);

        await expect(pending).rejects.toBeDefined();
      } finally {
        await harness.provider.close();
      }
    });

    it("publishes complete catalog replacements through the lifecycle callback", async () => {
      const harness = createHarness();
      try {
        let resolveChanged: ((names: readonly string[]) => void) | undefined;
        const changed = new Promise<readonly string[]>((resolve) => {
          resolveChanged = resolve;
        });
        const initial = await harness.provider.start({
          signal: new AbortController().signal,
          onToolsChanged: (tools) => resolveChanged?.(tools.map((tool) => tool.name)),
        });
        expect(initial.map((tool) => tool.name)).not.toContain("dynamic-tool");

        await harness.triggerCatalogChange();
        const names = await withTimeout(changed, 1_000);
        expect(names).toContain("echo");
        expect(names).toContain("dynamic-tool");
      } finally {
        await harness.provider.close();
      }
    });

    it("closes idempotently and rejects later invocation", async () => {
      const harness = createHarness();
      await harness.provider.start({ signal: new AbortController().signal });
      await harness.provider.close();
      await harness.provider.close();

      await expect(
        harness.provider.call(callContext("echo", { value: "closed" })),
      ).rejects.toBeDefined();
    });
  });
}

function callContext(
  tool: string,
  input: ProviderCallContext["input"],
  signal: AbortSignal = new AbortController().signal,
): ProviderCallContext {
  return {
    executionId: "provider-conformance",
    callId: `provider-conformance:${tool}`,
    tool,
    input,
    signal,
  };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for provider catalog change")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
