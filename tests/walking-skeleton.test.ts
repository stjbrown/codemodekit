import {
  CodeMode,
  TypeScriptCompiler,
  allowAllToolCalls,
  denyAllToolCalls,
  type ExecutionLimits,
  type NormalizedTool,
  type ProviderCallContext,
  type ProviderStartContext,
  type ProviderToolResult,
  type ReconnectOptions,
  type ToolPolicy,
  type ToolProvider,
} from "@codemodekit/core";
import { QuickJsSandbox } from "@codemodekit/sandbox-quickjs";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import {
  InMemoryTestToolProvider,
  echoTool,
  type InMemoryTool,
} from "./support/in-memory-provider.js";

const instances: CodeMode[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
});

describe("M0 walking skeleton", () => {
  it("executes TypeScript in QuickJS and crosses the asynchronous tool bridge", async () => {
    const provider = fixtureProvider();
    const codeMode = createCodeMode(provider);

    const startup = await codeMode.start();
    const result = await codeMode.run({
      code: `
        const echoed = await tools.test.echo({ value: "hello" });
        console.log("received", echoed.structuredContent.value);
        return echoed;
      `,
    });

    expect(startup).toMatchObject({ status: "ready" });
    expect(result).toMatchObject({
      ok: true,
      value: {
        content: [{ type: "text", text: "hello" }],
        structuredContent: { value: "hello" },
      },
      logs: [{ level: "log", message: "received hello" }],
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain("host-only");
  });

  it("composes structured, JSON-text, and rich results inside one execution", async () => {
    const structuredTool: InMemoryTool = {
      name: "structured",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
        required: ["rows"],
        additionalProperties: false,
      },
      execute: () => ({
        content: [{ type: "text", text: "structured fallback" }],
        structuredContent: { rows: [{ name: "structured-row" }] },
      }),
    };
    const jsonTextTool: InMemoryTool = {
      name: "json-text",
      inputSchema: { type: "object", additionalProperties: false },
      execute: () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ rows: [{ name: "json-row" }] }),
          },
        ],
      }),
    };
    const richTool: InMemoryTool = {
      name: "rich",
      inputSchema: { type: "object", additionalProperties: false },
      execute: () => ({
        content: [
          { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
          { type: "text", text: "plain summary" },
        ],
      }),
    };
    const provider = new InMemoryTestToolProvider({
      sourceName: "shapes",
      tools: [structuredTool, jsonTextTool, richTool],
    });
    const codeMode = createCodeMode(provider);

    const result = await codeMode.run({
      code: `
        const [structured, jsonText, rich] = await Promise.all([
          tools.shapes.structured({}),
          tools.shapes["json-text"]({}),
          tools.shapes.rich({}),
        ]);
        const jsonBlock = jsonText.content.find(
          (block) => block.type === "text" && typeof block.text === "string",
        );
        if (jsonBlock === undefined || typeof jsonBlock.text !== "string") {
          throw new Error("Expected a JSON text block");
        }
        const parsed = JSON.parse(jsonBlock.text);
        const richText = rich.content.find(
          (block) => block.type === "text" && typeof block.text === "string",
        );
        return {
          structured: structured.structuredContent.rows[0].name,
          jsonText: parsed.rows[0].name,
          richTypes: rich.content.map((block) => block.type),
          richText:
            richText !== undefined && typeof richText.text === "string"
              ? richText.text
              : null,
        };
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        structured: "structured-row",
        jsonText: "json-row",
        richTypes: ["image", "text"],
        richText: "plain summary",
      },
    });
    expect(provider.calls).toHaveLength(3);
  });

  it("passes the bridge path under QuickJS's leak-detecting debug build", async () => {
    const provider = fixtureProvider();
    const codeMode = new CodeMode({
      compiler: new TypeScriptCompiler(),
      sandbox: new QuickJsSandbox({ debug: true }),
      toolPolicy: allowAllToolCalls(),
      providers: [provider],
    });
    instances.push(codeMode);

    const result = await codeMode.run({
      code: 'return await tools.test.echo({ value: "debug" });',
    });

    expect(result).toMatchObject({
      ok: true,
      value: { structuredContent: { value: "debug" } },
    });
  });

  it("disposes timed-out debug runtimes while provider work is still settling", async () => {
    let observedAborts = 0;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const slowTool: InMemoryTool = {
        name: "slow",
        inputSchema: { type: "object", additionalProperties: false },
        execute: async ({ signal }) => {
          await new Promise<void>((resolve) => {
            const finish = (): void => {
              setTimeout(resolve, 10);
            };
            if (signal.aborted) {
              observedAborts += 1;
              finish();
            } else {
              signal.addEventListener(
                "abort",
                () => {
                  observedAborts += 1;
                  finish();
                },
                { once: true },
              );
            }
          });
          return { content: [], structuredContent: { late: true } };
        },
      };
      const provider = new InMemoryTestToolProvider({
        sourceName: "test",
        tools: [slowTool],
      });
      const codeMode = new CodeMode({
        compiler: new TypeScriptCompiler(),
        sandbox: new QuickJsSandbox({ debug: true }),
        toolPolicy: allowAllToolCalls(),
        providers: [provider],
        limits: { wallTimeMs: 2_000, toolCallTimeMs: 5 },
      });
      instances.push(codeMode);

      const result = await codeMode.run({
        code: "return await tools.test.slow({});",
      });
      expect(result).toMatchObject({
        ok: false,
        diagnostic: { code: "TOOL_TIMEOUT" },
      });
      await codeMode.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(observedAborts).toBe(8);
  });

  it("requires an explicit return and does not return the final expression", async () => {
    const codeMode = createCodeMode(fixtureProvider());
    const result = await codeMode.run({
      code: `
        await tools.test.echo({ value: "ignored" });
        ({ value: "not returned" });
      `,
    });

    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("value");
  });

  it("reports compile errors against the unwrapped model source", async () => {
    const codeMode = createCodeMode(fixtureProvider());
    const result = await codeMode.run({
      code: "const valid = 1;\nconst broken = ;\nreturn valid;",
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: {
        code: "CODE_COMPILE_FAILED",
        phase: "compile",
        location: { line: 2 },
      },
    });
  });

  it("rejects module loading before sandbox execution", async () => {
    const codeMode = createCodeMode(fixtureProvider());
    const result = await codeMode.run({
      code: 'const module = await import("node:fs"); return module;',
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: {
        code: "CODE_UNSAFE_SYNTAX",
        phase: "compile",
        location: { line: 1 },
      },
    });
  });

  it("makes policy denial catchable inside authored code", async () => {
    const codeMode = createCodeMode(
      fixtureProvider(),
      denyAllToolCalls("requires review"),
    );
    const result = await codeMode.run({
      code: `
        try {
          await tools.test.echo({ value: "blocked" });
          return { reached: true };
        } catch (error) {
          return { name: error.name, code: error.code, message: error.message };
        }
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        name: "ToolCallError",
        code: "TOOL_APPROVAL_DENIED",
        message: "Tool call was denied: requires review",
      },
    });
  });

  it("returns uncaught sandbox failures with actionable messages", async () => {
    const codeMode = createCodeMode(fixtureProvider());
    const result = await codeMode.run({
      code: 'throw new Error("use a string value instead");',
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: {
        code: "SANDBOX_RUNTIME_FAILED",
        phase: "sandbox",
        message: "use a string value instead",
      },
    });
  });

  it("does not expose ambient host APIs or dynamic function constructors", async () => {
    const codeMode = createCodeMode(fixtureProvider());
    const result = await codeMode.run({
      code: `
        return {
          process: typeof process,
          fetch: typeof fetch,
          require: typeof require,
          functionConstructor: typeof (() => {}).constructor,
          asyncConstructor: typeof (async () => {}).constructor,
        };
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        process: "undefined",
        fetch: "undefined",
        require: "undefined",
        functionConstructor: "undefined",
        asyncConstructor: "undefined",
      },
    });
  });

  it("interrupts unbounded compute", async () => {
    const codeMode = createCodeMode(fixtureProvider(), allowAllToolCalls(), {
      computeTimeMs: 20,
      wallTimeMs: 2_000,
    });
    const result = await codeMode.run({ code: "while (true) {}" });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: { code: "EXECUTION_COMPUTE_LIMIT" },
    });
  });

  it("propagates caller cancellation into active providers", async () => {
    let observedAbort = false;
    const waitingTool: InMemoryTool = {
      name: "wait",
      inputSchema: { type: "object", additionalProperties: false },
      execute: ({ signal }) =>
        new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            observedAbort = true;
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
    };
    const provider = new InMemoryTestToolProvider({
      sourceName: "test",
      tools: [waitingTool],
    });
    const codeMode = createCodeMode(provider);
    await codeMode.start();

    const controller = new AbortController();
    const running = codeMode.run({
      code: "return await tools.test.wait({});",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("test cancellation")), 20);

    const result = await running;
    expect(result).toMatchObject({
      ok: false,
      diagnostic: { code: "EXECUTION_CANCELLED" },
    });
    expect(observedAbort).toBe(true);
  });

  it("queues concurrent calls at the configured cap and assigns unique call IDs", async () => {
    let active = 0;
    let maximumActive = 0;
    const policyCallIds: string[] = [];
    const delayedEcho: InMemoryTool = {
      ...echoTool(),
      execute: async ({ input, signal }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await delay(15, signal);
          return {
            content: [{ type: "text", text: String(input.value) }],
            structuredContent: { value: input.value ?? null },
          };
        } finally {
          active -= 1;
        }
      },
    };
    const provider = new InMemoryTestToolProvider({
      sourceName: "test",
      tools: [delayedEcho],
    });
    const policy: ToolPolicy = (request) => {
      policyCallIds.push(request.callId);
      return { decision: "allow" };
    };
    const codeMode = createCodeMode(provider, policy, {
      maxConcurrentToolCalls: 2,
    });
    const result = await codeMode.run({
      code: `
        const values = await Promise.all(
          ["a", "b", "c", "d"].map(async (value) => {
            const result = await tools.test.echo({ value });
            return result.structuredContent.value;
          }),
        );
        return values;
      `,
    });

    expect(result).toMatchObject({ ok: true, value: ["a", "b", "c", "d"] });
    expect(maximumActive).toBe(2);
    expect(new Set(policyCallIds).size).toBe(4);
  });

  it("aborts timed-out providers and exposes a catchable stable error", async () => {
    let observedAbort = false;
    const timeoutTool: InMemoryTool = {
      name: "timeout",
      inputSchema: { type: "object", additionalProperties: false },
      execute: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    };
    const provider = new InMemoryTestToolProvider({
      sourceName: "test",
      tools: [timeoutTool],
    });
    const codeMode = createCodeMode(provider, allowAllToolCalls(), {
      toolCallTimeMs: 20,
      wallTimeMs: 2_000,
    });
    const result = await codeMode.run({
      code: `
        try {
          await tools.test.timeout({});
          return { reached: true };
        } catch (error) {
          return { code: error.code };
        }
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { code: "TOOL_TIMEOUT" },
    });
    expect(observedAbort).toBe(true);
  });

  it("fails closed when a policy returns an invalid runtime decision", async () => {
    const invalidPolicy = (() => undefined) as unknown as ToolPolicy;
    const codeMode = createCodeMode(fixtureProvider(), invalidPolicy);
    const result = await codeMode.run({
      code: 'return await tools.test.echo({ value: "blocked" });',
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: { code: "TOOL_APPROVAL_DENIED", phase: "policy" },
    });
  });

  it("validates a declared output schema even when structured content is absent", async () => {
    const invalidOutput: InMemoryTool = {
      ...echoTool(),
      execute: () => ({ content: [{ type: "text", text: "missing output" }] }),
    };
    const provider = new InMemoryTestToolProvider({
      sourceName: "test",
      tools: [invalidOutput],
    });
    const codeMode = createCodeMode(provider);
    const result = await codeMode.run({
      code: `
        try {
          await tools.test.echo({ value: "hello" });
          return { reached: true };
        } catch (error) {
          return { code: error.code };
        }
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { code: "TOOL_RESULT_INVALID" },
    });
  });

  it("fails explicitly when the final result exceeds its bound", async () => {
    const codeMode = createCodeMode(fixtureProvider(), allowAllToolCalls(), {
      finalResultBytes: 64,
    });
    const result = await codeMode.run({
      code: 'return "x".repeat(1024);',
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: { code: "FINAL_RESULT_TOO_LARGE" },
    });
  });

  it("starts degraded when one provider fails without disabling a sibling", async () => {
    const healthy = fixtureProvider();
    const unavailable = new InMemoryTestToolProvider({
      sourceName: "offline",
      tools: [],
      startError: new Error("contains a secret that must not leak"),
    });
    const codeMode = createCodeModeWithProviders([healthy, unavailable]);

    const startup = await codeMode.start();
    const result = await codeMode.run({
      code: 'return await tools.test.echo({ value: "still works" });',
    });

    expect(startup).toMatchObject({
      status: "degraded",
      sources: [
        { source: "test", status: "healthy", toolCount: 1 },
        {
          source: "offline",
          status: "unavailable",
          toolCount: 0,
          message: "Source discovery failed",
        },
      ],
    });
    expect(JSON.stringify(startup)).not.toContain("secret");
    expect(result).toMatchObject({ ok: true });
  });

  it("returns SOURCE_UNAVAILABLE for an explicitly configured offline source", async () => {
    const unavailable = new InMemoryTestToolProvider({
      sourceName: "offline",
      tools: [],
      startError: new Error("offline"),
    });
    const codeMode = createCodeModeWithProviders(
      [unavailable],
      allowAllToolCalls(),
      undefined,
      { initialDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0 },
    );

    const result = await codeMode.run({
      code: `
        try {
          await tools.offline.echo({ value: "hello" });
          return { reached: true };
        } catch (error) {
          return { code: error.code, source: error.source, message: error.message };
        }
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        code: "SOURCE_UNAVAILABLE",
        source: "offline",
        message: "Tool source offline is temporarily unavailable",
      },
    });
  });

  it("returns SOURCE_NOT_FOUND and TOOL_NOT_FOUND through the lazy namespace", async () => {
    const codeMode = createCodeMode(fixtureProvider());
    const result = await codeMode.run({
      code: `
        const codes = [];
        try { await tools.missing.echo({}); } catch (error) { codes.push(error.code); }
        try { await tools.test.missing({}); } catch (error) { codes.push(error.code); }
        return codes;
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: ["SOURCE_NOT_FOUND", "TOOL_NOT_FOUND"],
    });
  });

  it("quarantines unenforceable schemas, reports them, and heals on refresh", async () => {
    const provider = new SchemaRefreshTestProvider();
    const codeMode = createCodeMode(provider);

    const startup = await codeMode.start();
    expect(startup).toMatchObject({
      status: "ready",
      sources: [
        {
          source: "schemas",
          status: "healthy",
          toolCount: 2,
          rejectedToolCount: 3,
          diagnostics: [
            { code: "TOOL_SCHEMA_UNSUPPORTED", tool: "bad-input", schema: "input" },
            { code: "TOOL_SCHEMA_UNSUPPORTED", tool: "bad-output", schema: "output" },
            { code: "TOOL_SCHEMA_UNSUPPORTED", tool: "external-ref", schema: "input" },
          ],
        },
      ],
    });

    const diagnostics = await codeMode.getCatalogDiagnostics({ limit: 1 });
    expect(diagnostics).toMatchObject({
      catalogRevision: startup.catalogRevision,
      total: 3,
      returned: 1,
      truncated: true,
      diagnostics: [
        {
          source: "schemas",
          tool: "bad-input",
          schema: "input",
          severity: "error",
        },
      ],
    });
    expect(JSON.stringify(diagnostics)).not.toContain("example.invalid");

    const declarations = await codeMode.getTypeScriptCatalog();
    expect(declarations.declarations).toContain("recursive-node");
    expect(declarations.declarations).not.toContain("bad-input");
    expect((await codeMode.searchTools({ query: "bad" })).returned).toBe(0);

    const rejectedCall = await codeMode.run({
      code: `
        try {
          await tools.schemas["bad-input"]({ value: "blocked" });
          return { reached: true };
        } catch (error) {
          return {
            code: error.code,
            source: error.source,
            tool: error.tool,
            message: error.message,
          };
        }
      `,
    });
    expect(rejectedCall).toMatchObject({
      ok: true,
      value: {
        code: "TOOL_SCHEMA_UNSUPPORTED",
        source: "schemas",
        tool: "bad-input",
        message: expect.stringContaining("input schema cannot be enforced"),
      },
    });
    expect(provider.calls).toBe(0);

    provider.repairSchemas();
    const repaired = await codeMode.start();
    expect(repaired.catalogRevision).not.toBe(startup.catalogRevision);
    expect(repaired.sources).toEqual([
      { source: "schemas", status: "healthy", toolCount: 5 },
    ]);
    expect(await codeMode.getCatalogDiagnostics()).toMatchObject({
      catalogRevision: repaired.catalogRevision,
      total: 0,
      diagnostics: [],
    });

    const successfulCall = await codeMode.run({
      code: `return await tools.schemas["bad-input"]({ value: "repaired" });`,
    });
    expect(successfulCall).toMatchObject({
      ok: true,
      value: { structuredContent: { value: "repaired" } },
    });
    expect(provider.calls).toBe(1);
  });

  it("generates standalone source catalogs and bounded tool-prefix shards", async () => {
    const names = [
      ...Array.from({ length: 60 }, (_, index) =>
        `zia_get_policy_${String(index).padStart(3, "0")}`,
      ),
      ...Array.from({ length: 45 }, (_, index) =>
        `zia_list_policy_${String(index).padStart(3, "0")}`,
      ),
      ...Array.from({ length: 35 }, (_, index) =>
        `zia_update_policy_${String(index).padStart(3, "0")}`,
      ),
    ];
    const provider = new InMemoryTestToolProvider({
      sourceName: "zscaler",
      tools: names.map((name) => ({ ...echoTool(), name })),
    });
    const codeMode = createCodeMode(provider);

    const catalog = await codeMode.getTypeScriptCatalog();
    expect(catalog.sources).toHaveLength(1);
    const source = catalog.sources[0];
    expect(source).toMatchObject({ source: "zscaler", toolCount: 140 });
    expect(source?.declarations).toContain("readonly zscaler:");
    expect(source?.shards.map((shard) => shard.key)).toEqual([
      "zia-get-policy-part-01",
      "zia-get-policy-part-02",
      "zia-list",
      "zia-update",
    ]);
    expect(source?.shards.every((shard) => shard.toolCount <= 50)).toBe(true);
    expect(source?.shards[0]?.declarations).toContain("zia_get_policy_000");
    expect(source?.shards[0]?.declarations).not.toContain("zia_list_policy_000");
  });

  it("bounds startup warnings and resolves duplicate definitions by last occurrence", async () => {
    const { execute: _execute, ...validEcho } = echoTool();
    const invalid = (name: string): NormalizedTool => ({
      name,
      inputSchema: { type: "not-a-json-type" },
    });
    const provider = new StaticTestToolProvider(
      "duplicates",
      [
        ...Array.from({ length: 10 }, (_, index) =>
          invalid(`invalid-${String(index).padStart(2, "0")}`),
        ),
        invalid("duplicate-valid"),
        { ...validEcho, name: "duplicate-valid" },
        { ...validEcho, name: "duplicate-invalid" },
        invalid("duplicate-invalid"),
      ],
    );
    const codeMode = createCodeMode(provider);

    const startup = await codeMode.start();
    expect(startup).toMatchObject({
      status: "ready",
      sources: [
        {
          source: "duplicates",
          toolCount: 1,
          rejectedToolCount: 11,
          diagnosticsTruncated: true,
        },
      ],
    });
    expect(startup.sources[0]?.diagnostics).toHaveLength(8);
    expect(await codeMode.getCatalogDiagnostics({ limit: 3 })).toMatchObject({
      total: 11,
      returned: 3,
      truncated: true,
      diagnostics: [
        { tool: "duplicate-invalid" },
        { tool: "invalid-00" },
        { tool: "invalid-01" },
      ],
    });

    const result = await codeMode.run({
      code: `
        const active = await tools.duplicates["duplicate-valid"]({ value: "last wins" });
        let rejected;
        try {
          await tools.duplicates["duplicate-invalid"]({ value: "blocked" });
        } catch (error) {
          rejected = error.code;
        }
        return { value: active.structuredContent.value, rejected };
      `,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { value: "last wins", rejected: "TOOL_SCHEMA_UNSUPPORTED" },
    });
    expect(provider.calls).toBe(1);
  });

  it("reconnects an unavailable source and atomically publishes its tools", async () => {
    const stable = fixtureProvider();
    const recovering = new LifecycleTestProvider({
      sourceName: "recovering",
      failedStarts: 1,
    });
    const codeMode = createCodeModeWithProviders(
      [stable, recovering],
      allowAllToolCalls(),
      undefined,
      fastReconnect,
    );

    const startup = await codeMode.start();
    expect(startup).toMatchObject({
      status: "degraded",
      sources: [
        { source: "test", status: "healthy", toolCount: 1 },
        { source: "recovering", status: "unavailable", toolCount: 0 },
      ],
    });

    const recovered = await waitForReport(codeMode, "ready");
    expect(recovered.catalogRevision).not.toBe(startup.catalogRevision);
    expect(recovered.sources).toEqual([
      { source: "test", status: "healthy", toolCount: 1 },
      { source: "recovering", status: "healthy", toolCount: 1 },
    ]);

    const result = await codeMode.run({
      code: `
        const [stable, recovered] = await Promise.all([
          tools.test.echo({ value: "stable" }),
          tools.recovering.echo({ value: "back" }),
        ]);
        return [stable.structuredContent.value, recovered.structuredContent.value];
      `,
    });
    expect(result).toMatchObject({ ok: true, value: ["stable", "back"] });
    expect(recovering.startCalls).toBe(2);
  });

  it("cancels scheduled reconnects during shutdown", async () => {
    const unavailable = new LifecycleTestProvider({
      sourceName: "offline",
      failedStarts: Number.POSITIVE_INFINITY,
    });
    const codeMode = createCodeModeWithProviders(
      [unavailable],
      allowAllToolCalls(),
      undefined,
      { initialDelayMs: 20, maxDelayMs: 20, jitterRatio: 0 },
    );

    await codeMode.start();
    await codeMode.close();
    await pause(60);

    expect(unavailable.startCalls).toBe(1);
  });

  it("recovers a lost source for later calls without replaying the failed call", async () => {
    const provider = new LifecycleTestProvider({
      sourceName: "unstable",
      failFirstCall: true,
    });
    const codeMode = createCodeModeWithProviders(
      [provider],
      allowAllToolCalls(),
      undefined,
      fastReconnect,
    );
    await codeMode.start();

    const failed = await codeMode.run({
      code: 'return await tools.unstable.echo({ value: "once" });',
    });
    expect(failed).toMatchObject({
      ok: false,
      diagnostic: { code: "TOOL_EXECUTION_FAILED" },
    });
    expect(provider.calls).toBe(1);

    await waitForReport(codeMode, "ready");
    expect(provider.calls).toBe(1);

    const later = await codeMode.run({
      code: 'return await tools.unstable.echo({ value: "later" });',
    });
    expect(later).toMatchObject({
      ok: true,
      value: { structuredContent: { value: "later" } },
    });
    expect(provider.calls).toBe(2);
  });

  it("generates revisioned conservative TypeScript declarations from active schemas", async () => {
    const referenceTool: InMemoryTool = {
      name: "ref-tool",
      description: "Use a local schema reference */ without breaking docs",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Input: {
            type: "object",
            properties: {
              kind: { enum: ["alpha", "beta"] },
              count: { type: "integer", minimum: 1 },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        $ref: "#/$defs/Input",
      },
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      sideband: { secret: "must-not-enter-declarations" },
      execute: () => ({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { ok: true },
      }),
    };
    const impreciseTool: InMemoryTool = {
      name: "imprecise",
      inputSchema: {
        if: { properties: { mode: { const: "strict" } } },
        then: { required: ["value"] },
      },
      execute: () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const provider = new InMemoryTestToolProvider({
      sourceName: "deployment-api",
      tools: [referenceTool, impreciseTool],
    });
    const codeMode = createCodeMode(provider);

    const startup = await codeMode.start();
    const catalog = await codeMode.getTypeScriptCatalog();

    expect(catalog.catalogRevision).toBe(startup.catalogRevision);
    expect(catalog.declarations).toContain('readonly "deployment-api":');
    expect(catalog.declarations).toContain('readonly "ref-tool":');
    expect(catalog.declarations).toContain(
      'readonly kind: "alpha" | "beta"; readonly count?: number',
    );
    expect(catalog.declarations).toContain("Promise<ToolResult<{ readonly ok: boolean }>>");
    expect(catalog.declarations).toMatch(
      /readonly imprecise: \(input: unknown\) => Promise<ToolResult<unknown>>/,
    );
    expect(catalog.declarations).not.toContain("must-not-enter-declarations");
    expect(catalog.declarations).not.toMatch(/\bany\b/);

    const diagnostics = ts.transpileModule(catalog.declarations, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, strict: true },
      reportDiagnostics: true,
    }).diagnostics;
    expect(
      diagnostics?.filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      ) ?? [],
    ).toEqual([]);
  });

  it("searches the active catalog deterministically with bounded TypeScript detail", async () => {
    const matchingTools = Array.from({ length: 7 }, (_, index) => ({
      ...echoTool(),
      name: index === 0 ? "create-issue" : `issue-helper-${index}`,
      description: `Issue workflow helper ${index}`,
    }));
    const healthy = new InMemoryTestToolProvider({
      sourceName: "linear-api",
      tools: matchingTools,
    });
    const unavailable = new InMemoryTestToolProvider({
      sourceName: "offline",
      tools: [],
      startError: new Error("offline"),
    });
    const codeMode = createCodeModeWithProviders([healthy, unavailable]);

    const detailed = await codeMode.searchTools({
      query: "issue",
      detail: "typescript",
      limit: 8,
    });
    expect(detailed.returned).toBe(5);
    expect(detailed.truncated).toBe(true);
    expect(detailed.results[0]).toMatchObject({
      source: "linear-api",
      tool: "issue-helper-1",
      callable: 'tools["linear-api"]["issue-helper-1"]',
    });
    expect(detailed.results.every((result) => result.typescript !== undefined)).toBe(true);
    expect(detailed.resultContract).toMatchObject({
      declaration: expect.stringContaining("interface ToolResult"),
      guidance: expect.arrayContaining([
        expect.stringContaining("never resolves directly"),
        expect.stringContaining("structuredContent.result"),
        expect.stringContaining("one run_typescript execution"),
      ]),
      example: expect.stringContaining("JSON.parse"),
    });
    expect(JSON.stringify(detailed)).not.toContain("host-only");

    const exact = await codeMode.searchTools({ query: "create-issue" });
    expect(exact.results[0]?.tool).toBe("create-issue");
    expect(exact).not.toHaveProperty("resultContract");

    const sourceFailure = await codeMode.searchTools({
      query: "issue",
      source: "offline",
    });
    expect(sourceFailure).toMatchObject({
      returned: 0,
      diagnostic: { code: "SOURCE_UNAVAILABLE", source: "offline" },
    });

    const unknownSource = await codeMode.searchTools({
      query: "linear",
      source: "linear",
    });
    expect(unknownSource).toMatchObject({
      returned: 0,
      suggestions: ["linear-api", "offline"],
    });
  });

  it("keeps bounded log head and tail records with a truncation marker", async () => {
    const codeMode = createCodeMode(fixtureProvider(), allowAllToolCalls(), {
      logEntries: 5,
      logBytes: 1_024,
    });
    const result = await codeMode.run({
      code: `
        for (let index = 0; index < 20; index += 1) console.log("entry", index);
        return "done";
      `,
    });

    expect(result.ok).toBe(true);
    expect(result.logs).toHaveLength(5);
    expect(result.logs.map((entry) => entry.message)).toEqual([
      "entry 0",
      "entry 1",
      "[logs truncated]",
      "entry 18",
      "entry 19",
    ]);
  });
});

function fixtureProvider(): InMemoryTestToolProvider {
  return new InMemoryTestToolProvider({
    sourceName: "test",
    tools: [echoTool()],
  });
}

function createCodeMode(
  provider: ToolProvider,
  toolPolicy: ToolPolicy = allowAllToolCalls(),
  limits?: Partial<ExecutionLimits>,
): CodeMode {
  return createCodeModeWithProviders([provider], toolPolicy, limits);
}

function createCodeModeWithProviders(
  providers: readonly ToolProvider[],
  toolPolicy: ToolPolicy = allowAllToolCalls(),
  limits?: Partial<ExecutionLimits>,
  reconnect?: Partial<ReconnectOptions>,
): CodeMode {
  const codeMode = new CodeMode({
    compiler: new TypeScriptCompiler(),
    sandbox: new QuickJsSandbox(),
    toolPolicy,
    providers,
    ...(limits === undefined ? {} : { limits }),
    ...(reconnect === undefined ? {} : { reconnect }),
  });
  instances.push(codeMode);
  return codeMode;
}

const fastReconnect: Partial<ReconnectOptions> = {
  initialDelayMs: 5,
  maxDelayMs: 5,
  jitterRatio: 0,
};

class LifecycleTestProvider implements ToolProvider {
  readonly sourceName: string;
  startCalls = 0;
  calls = 0;

  readonly #failedStarts: number;
  readonly #failFirstCall: boolean;
  #onUnavailable: (() => void) | undefined;
  #closed = false;

  constructor(options: {
    readonly sourceName: string;
    readonly failedStarts?: number;
    readonly failFirstCall?: boolean;
  }) {
    this.sourceName = options.sourceName;
    this.#failedStarts = options.failedStarts ?? 0;
    this.#failFirstCall = options.failFirstCall ?? false;
  }

  async start(context: ProviderStartContext): Promise<readonly NormalizedTool[]> {
    this.startCalls += 1;
    if (this.#closed) {
      throw new Error("closed");
    }
    if (this.startCalls <= this.#failedStarts) {
      throw new Error("temporarily unavailable");
    }
    this.#onUnavailable = context.onUnavailable;
    const { execute: _execute, ...definition } = echoTool();
    return [definition];
  }

  async call(context: ProviderCallContext): Promise<ProviderToolResult> {
    this.calls += 1;
    if (this.#failFirstCall && this.calls === 1) {
      this.#onUnavailable?.();
      throw new Error("connection lost after dispatch");
    }
    return {
      content: [{ type: "text", text: String(context.input.value) }],
      structuredContent: { value: context.input.value ?? null },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#onUnavailable = undefined;
  }
}

class SchemaRefreshTestProvider implements ToolProvider {
  readonly sourceName = "schemas";
  calls = 0;

  #onToolsChanged: ((tools: readonly NormalizedTool[]) => void) | undefined;
  #repaired = false;

  async start(context: ProviderStartContext): Promise<readonly NormalizedTool[]> {
    this.#onToolsChanged = context.onToolsChanged;
    return this.#tools();
  }

  async call(context: ProviderCallContext): Promise<ProviderToolResult> {
    this.calls += 1;
    return {
      content: [{ type: "text", text: String(context.input.value) }],
      structuredContent: { value: context.input.value ?? null },
    };
  }

  repairSchemas(): void {
    this.#repaired = true;
    this.#onToolsChanged?.(this.#tools());
  }

  async close(): Promise<void> {
    this.#onToolsChanged = undefined;
  }

  #tools(): readonly NormalizedTool[] {
    const objectSchema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    } as const;
    const outputSchema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    } as const;
    return [
      {
        name: "echo",
        inputSchema: objectSchema,
        outputSchema,
      },
      {
        name: "bad-input",
        inputSchema: this.#repaired ? objectSchema : { type: "not-a-json-type" },
        outputSchema,
      },
      {
        name: "bad-output",
        inputSchema: objectSchema,
        outputSchema: this.#repaired
          ? outputSchema
          : { type: "not-a-json-type" },
      },
      {
        name: "external-ref",
        inputSchema: this.#repaired
          ? objectSchema
          : { $ref: "https://example.invalid/schema.json" },
        outputSchema,
      },
      {
        name: "recursive-node",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $defs: {
            Node: {
              type: "object",
              properties: {
                value: { type: "string" },
                next: {
                  anyOf: [{ $ref: "#/$defs/Node" }, { type: "null" }],
                },
              },
              required: ["value"],
              additionalProperties: false,
            },
          },
          $ref: "#/$defs/Node",
        },
      },
    ];
  }
}

class StaticTestToolProvider implements ToolProvider {
  calls = 0;

  constructor(
    readonly sourceName: string,
    readonly tools: readonly NormalizedTool[],
  ) {}

  async start(): Promise<readonly NormalizedTool[]> {
    return this.tools;
  }

  async call(context: ProviderCallContext): Promise<ProviderToolResult> {
    this.calls += 1;
    return {
      content: [{ type: "text", text: String(context.input.value) }],
      structuredContent: { value: context.input.value ?? null },
    };
  }

  async close(): Promise<void> {}
}

async function waitForReport(
  codeMode: CodeMode,
  status: "ready" | "degraded",
): Promise<Awaited<ReturnType<CodeMode["start"]>>> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const report = await codeMode.start();
    if (report.status === status) {
      return report;
    }
    await pause(5);
  }
  throw new Error(`Timed out waiting for Code Mode status ${status}`);
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
