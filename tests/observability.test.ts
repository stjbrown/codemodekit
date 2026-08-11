import {
  CodeMode,
  TypeScriptCompiler,
  allowAllToolCalls,
  denyAllToolCalls,
  type CodeModeObservation,
} from "@codemodekit/core";
import { QuickJsSandbox } from "@codemodekit/sandbox-quickjs";
import { afterEach, describe, expect, it } from "vitest";

import {
  InMemoryTestToolProvider,
  echoTool,
} from "./support/in-memory-provider.js";

const instances: CodeMode[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
});

describe("Code Mode observability", () => {
  it("reports bounded lifecycle metadata without code or tool payloads", async () => {
    const events: CodeModeObservation[] = [];
    const codeMode = observedCodeMode(events, allowAllToolCalls(), true);
    const secret = "payload-that-must-not-enter-observation-events";

    const result = await codeMode.run({
      code: `
        const result = await tools.test.echo({ value: ${JSON.stringify(secret)} });
        return result.structuredContent.value;
      `,
    });
    await flushObservations();

    expect(result).toMatchObject({ ok: true, value: secret });
    expect(events.map((event) => event.type)).toEqual([
      "execution_started",
      "tool_call_queued",
      "tool_call_started",
      "tool_call_completed",
      "execution_completed",
    ]);
    const executionId = result.executionId;
    expect(events.every((event) => event.executionId === executionId)).toBe(true);
    expect(events.every((event) => Object.isFrozen(event))).toBe(true);
    expect(events[0]).toMatchObject({
      type: "execution_started",
      sourceBytes: expect.any(Number),
    });
    expect(events[1]).toMatchObject({
      type: "tool_call_queued",
      source: "test",
      tool: "echo",
      inputBytes: expect.any(Number),
    });
    expect(events[3]).toMatchObject({
      type: "tool_call_completed",
      ok: true,
      resultBytes: expect.any(Number),
    });
    expect(events[4]).toMatchObject({
      type: "execution_completed",
      ok: true,
      logEntries: 0,
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("reports a caught policy denial as a failed call inside a successful execution", async () => {
    const events: CodeModeObservation[] = [];
    const codeMode = observedCodeMode(events, denyAllToolCalls("private reason"));

    const result = await codeMode.run({
      code: `
        try {
          await tools.test.echo({ value: "blocked payload" });
        } catch {}
        return "recovered";
      `,
    });
    await flushObservations();

    expect(result).toMatchObject({ ok: true, value: "recovered" });
    expect(events.find((event) => event.type === "tool_call_completed")).toMatchObject({
      ok: false,
      errorCode: "TOOL_APPROVAL_DENIED",
      phase: "policy",
    });
    expect(events.at(-1)).toMatchObject({
      type: "execution_completed",
      ok: true,
    });
    expect(JSON.stringify(events)).not.toContain("private reason");
    expect(JSON.stringify(events)).not.toContain("blocked payload");
  });
});

function observedCodeMode(
  events: CodeModeObservation[],
  toolPolicy: ReturnType<typeof allowAllToolCalls>,
  throwFromObserver = false,
): CodeMode {
  const codeMode = new CodeMode({
    compiler: new TypeScriptCompiler(),
    sandbox: new QuickJsSandbox(),
    toolPolicy,
    providers: [
      new InMemoryTestToolProvider({ sourceName: "test", tools: [echoTool()] }),
    ],
    observer: (event) => {
      events.push(event);
      if (throwFromObserver && event.type === "tool_call_started") {
        throw new Error("observer failure must be isolated");
      }
    },
  });
  instances.push(codeMode);
  return codeMode;
}

async function flushObservations(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
