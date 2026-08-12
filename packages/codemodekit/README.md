# CodeModeKit

Batteries-included server facade for CodeModeKit. TypeScript compilation and QuickJS are configured internally; callers choose MCP sources, application-owned Local Tools, policy, and any overrides.

Create an editable weather server and Agent Plugin with no credentials:

```sh
npm create codemodekit@latest weather-code-mode -- --example weather
```

```js
import {
  allowAllToolCalls,
  mcp,
  serveCodeModeStdio,
} from "codemodekit";

await serveCodeModeStdio({
  name: "my-code-mode",
  version: "0.1.0",
  toolPolicy: allowAllToolCalls(),
  sources: [
    mcp.stdio({
      name: "upstream",
      command: "my-mcp-server",
    }),
  ],
  observer: (event) => console.error(JSON.stringify(event)),
});
```

Use `serveCodeModeHttp` for a Streamable HTTP endpoint, or `createCodeModeMcp` when another host owns the downstream transport. The optional observer receives timing, identity, size, outcome, and stable-error metadata; it never receives authored code, tool payloads, logs, or diagnostic messages, and observer failures cannot affect execution.

The lower-level `@codemodekit/core`, `@codemodekit/mcp`, and `@codemodekit/sandbox-quickjs` packages remain available for expert composition.

Give CodeModeKit to a coding agent with `npx skills add stjbrown/codemodekit`. The repository exposes `build-codemodekit-server` and `author-codemode-skill`; pass `--skill <name>` to install either independently. Generated projects receive both automatically from the programmatic `@codemodekit/skills` package.

## Local Tools

```ts
import { z } from "zod";
import { allowAllToolCalls, defineTool, local, serveCodeModeStdio } from "codemodekit";

const greet = defineTool({
  description: "Greet someone",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
  execute: ({ name }) => ({ greeting: `Hello, ${name}!` }),
});

await serveCodeModeStdio({
  name: "local-code-mode",
  version: "0.1.0",
  toolPolicy: allowAllToolCalls(),
  sources: [local({ name: "app", tools: { greet } })],
});
```

Schemas may be plain JSON Schema or a Standard JSON Schema implementation; Zod 4 is covered by the compatibility tests. Execution stays in the trusted host; only validated JSON inputs and outputs cross the QuickJS bridge.
