import {
  allowAllToolCalls,
  createCodeModeMcp,
  defineTool,
  local,
  ToolError,
} from "codemodekit";
import { z } from "zod";
import { describe, expect, it } from "vitest";

describe("LocalToolProvider", () => {
  it("turns schema-typed application functions into a Code Mode source", async () => {
    const observedInputs: string[] = [];
    const application = createCodeModeMcp({
      name: "local-test",
      version: "1.0.0",
      toolPolicy: allowAllToolCalls(),
      sources: [
        local({
          name: "weather",
          tools: {
            findLocation: defineTool({
              description: "Find a location",
              inputSchema: z.object({ query: z.string() }),
              outputSchema: z.object({
                latitude: z.number(),
                longitude: z.number(),
              }),
              execute: ({ query }, context) => {
                observedInputs.push(query);
                expect(context).toMatchObject({
                  source: "weather",
                  tool: "findLocation",
                });
                return { latitude: 35.78, longitude: -78.64 };
              },
            }),
            getCurrentWeather: defineTool({
              description: "Get current weather for coordinates",
              inputSchema: z.object({
                latitude: z.number(),
                longitude: z.number(),
              }),
              outputSchema: z.object({ temperatureCelsius: z.number() }),
              execute: ({ latitude, longitude }) => ({
                temperatureCelsius: latitude + longitude,
              }),
            }),
          },
        }),
      ],
    });

    try {
      const startup = await application.start();
      expect(startup).toMatchObject({
        status: "ready",
        sources: [{ source: "weather", status: "healthy", toolCount: 2 }],
      });
      const catalog = await application.codeMode.getTypeScriptCatalog();
      expect(catalog.declarations).toContain("readonly findLocation");
      expect(catalog.declarations).toContain("readonly getCurrentWeather");
      expect(catalog.declarations).toContain("query: string");

      const result = await application.codeMode.run({
        code: `
          const location = await tools.weather.findLocation({ query: "Raleigh" });
          const weather = await tools.weather.getCurrentWeather(
            location.structuredContent,
          );
          return {
            city: "Raleigh",
            temperatureCelsius: weather.structuredContent.temperatureCelsius,
          };
        `,
      });

      expect(result).toMatchObject({
        ok: true,
        value: { city: "Raleigh", temperatureCelsius: -42.86 },
      });
      expect(observedInputs).toEqual(["Raleigh"]);
    } finally {
      await application.close();
    }
  });

  it("supports plain JSON Schema and safe application-declared errors", async () => {
    const application = createCodeModeMcp({
      name: "local-errors",
      version: "1.0.0",
      toolPolicy: allowAllToolCalls(),
      sources: [
        local({
          name: "local",
          tools: {
            echo: defineTool({
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
              execute: ({ value }) => ({
                value: typeof value === "string" ? value : "",
              }),
            }),
            fail: defineTool({
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              execute: () => {
                throw new ToolError("Weather service is temporarily unavailable");
              },
            }),
          },
        }),
      ],
    });

    try {
      const echoed = await application.codeMode.run({
        code: `
          const result = await tools.local.echo({ value: "plain schema" });
          return result.structuredContent;
        `,
      });
      expect(echoed).toMatchObject({
        ok: true,
        value: { value: "plain schema" },
      });

      const result = await application.codeMode.run({
        code: "return await tools.local.fail({});",
      });
      expect(result).toMatchObject({
        ok: false,
        diagnostic: {
          code: "TOOL_EXECUTION_FAILED",
          message: "Weather service is temporarily unavailable",
          source: "local",
          tool: "fail",
        },
      });
    } finally {
      await application.close();
    }
  });

  it("propagates cancellation and closes idempotently", async () => {
    let aborted = false;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider = local({
      name: "local",
      tools: {
        wait: defineTool({
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          execute: (_input, { signal }) => {
            markStarted?.();
            return new Promise<null>((_resolve, reject) => {
              const onAbort = (): void => {
                aborted = true;
                reject(signal.reason);
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            });
          },
        }),
      },
    });
    const application = createCodeModeMcp({
      name: "local-cancellation",
      version: "1.0.0",
      toolPolicy: allowAllToolCalls(),
      sources: [provider],
    });
    const controller = new AbortController();

    try {
      const pending = application.codeMode.run({
        code: "return await tools.local.wait({});",
        signal: controller.signal,
      });
      await started;
      controller.abort(new Error("cancel local tool"));
      const result = await pending;
      expect(result).toMatchObject({
        ok: false,
        diagnostic: { code: "EXECUTION_CANCELLED" },
      });
      expect(aborted).toBe(true);
    } finally {
      await application.close();
      await application.close();
    }

    await expect(
      provider.start({ signal: new AbortController().signal }),
    ).rejects.toThrow(/closed/);
  });
});
