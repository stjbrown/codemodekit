import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

function createServer() {
  const server = new McpServer({
    name: "codemodekit-test-server",
    version: "1.0.0",
  });

  server.registerTool(
    "echo",
    {
      description: "Echo a string from a real MCP server",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ value: z.string(), server: z.string() }),
      annotations: { readOnlyHint: true },
      _meta: { fixture: { definitionSecret: "definition-sideband" } },
    },
    async ({ value }) => ({
      content: [{ type: "text", text: value }],
      structuredContent: { value, server: "stdio" },
      _meta: { fixture: { resultSecret: "result-sideband" } },
    }),
  );

  server.registerTool(
    "hyphen-tool",
    {
      description: "A tool whose exact name requires bracket notation",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ value: z.string() }),
    },
    async ({ value }) => ({
      content: [{ type: "text", text: value.toUpperCase() }],
      structuredContent: { value: value.toUpperCase() },
    }),
  );

  server.registerTool(
    "fail",
    {
      description: "Return a model-actionable MCP tool error",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "The value was rejected; retry with a non-empty string.",
        },
      ],
      isError: true,
      _meta: { fixture: { errorSecret: "error-sideband" } },
    }),
  );

  server.registerTool(
    "wait",
    {
      description: "Wait until a delay elapses or the caller cancels",
      inputSchema: z.object({ delayMs: z.number().int().positive() }),
      outputSchema: z.object({ completed: z.boolean() }),
    },
    async ({ delayMs }, context) => {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, delayMs);
        context.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout);
            reject(context.signal.reason);
          },
          { once: true },
        );
      });
      return {
        content: [{ type: "text", text: "completed" }],
        structuredContent: { completed: true },
      };
    },
  );

  if (process.env.MCP_FIXTURE_ENABLE_DISCONNECT === "1") {
    server.registerTool(
      "disconnect",
      {
        description: "Terminate the fixture transport before returning a result",
        inputSchema: z.object({}),
      },
      async () => {
        process.exit(17);
      },
    );
  }

  if (process.env.MCP_FIXTURE_ENABLE_LIST_CHANGED === "1") {
    const dynamicTool = server.registerTool(
      "dynamic-tool",
      {
        description: "A tool enabled after a tools/list_changed notification",
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ value: z.string() }),
      },
      async ({ value }) => ({
        content: [{ type: "text", text: value }],
        structuredContent: { value },
      }),
    );
    dynamicTool.disable();

    server.registerTool(
      "enable-dynamic-tool",
      {
        description: "Enable the dynamic fixture tool",
        inputSchema: z.object({}),
      },
      async () => {
        dynamicTool.enable();
        server.sendToolListChanged();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { content: [{ type: "text", text: "enabled" }] };
      },
    );
  }

  server.registerTool(
    "app-only",
    {
      description: "Visible only to an MCP App",
      inputSchema: z.object({}),
      _meta: {
        ui: {
          resourceUri: "ui://fixture/app.html",
          visibility: ["app"],
        },
      },
    },
    async () => ({ content: [{ type: "text", text: "app only" }] }),
  );

  return server;
}

serveStdio(createServer, {
  onerror: (error) => console.error(error.message),
});
