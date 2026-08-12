# Server API

## Application-owned Local Tools

```ts
import {
  allowAllToolCalls,
  defineTool,
  local,
  serveCodeModeStdio,
  ToolError,
} from "codemodekit";

const lookup = defineTool({
  description: "Look up one record by identifier",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { id: { type: "string" }, status: { type: "string" } },
    required: ["id", "status"],
    additionalProperties: false,
  },
  execute: async ({ id }, { signal }) => {
    const response = await fetch(`https://example.com/records/${id}`, { signal });
    if (!response.ok) throw new ToolError(`Record lookup failed with HTTP ${response.status}`);
    return await response.json();
  },
});

await serveCodeModeStdio({
  name: "records-code-mode",
  version: "0.1.0",
  toolPolicy: allowAllToolCalls(),
  sources: [local({ name: "records", tools: { lookup } })],
});
```

`defineTool` accepts plain JSON Schema or Standard JSON Schema-compatible schemas. Local executors run in the trusted host; the model's TypeScript still runs in QuickJS.

## MCP source

```ts
import { allowAllToolCalls, mcp, serveCodeModeStdio } from "codemodekit";

await serveCodeModeStdio({
  name: "github-code-mode",
  version: "0.1.0",
  toolPolicy: allowAllToolCalls(),
  sources: [
    mcp.stdio({
      name: "github",
      command: "docker",
      args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
    }),
  ],
});
```

Use `mcp.http({ name, url })` for Streamable HTTP. Source names become the first segment below `tools`; preserve them exactly and use bracket notation for names that are not TypeScript identifiers.

## Composition

Every source is a provider in one normalized catalog:

```ts
sources: [
  local({ name: "application", tools: { lookup } }),
  mcp.http({ name: "tickets", url: "https://example.com/mcp" }),
]
```

The low-level `CodeMode`, compiler, sandbox, and provider classes are expert APIs. Stay on the facade unless a custom host or sandbox is an explicit requirement.
