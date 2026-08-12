import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

const server = new McpServer({
  name: "codemodekit-large-catalog-test-server",
  version: "1.0.0",
});

const families = [
  ["zia_url_filtering_list_rule", 120],
  ["zia_firewall_list_rule", 120],
  ["zpa_application_list", 66],
];

for (const [prefix, count] of families) {
  for (let index = 0; index < count; index += 1) {
    const toolName = `${prefix}_${String(index).padStart(3, "0")}`;
    server.registerTool(
      toolName,
      {
        description: `Return a bounded fixture result for ${toolName}`,
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ tool: z.string(), value: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ value }) => ({
        content: [{ type: "text", text: value }],
        structuredContent: { tool: toolName, value },
      }),
    );
  }
}

serveStdio(() => server, {
  onerror: (error) => console.error(error.message),
});
