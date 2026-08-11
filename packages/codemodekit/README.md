# CodeModeKit

Batteries-included server facade for CodeModeKit. TypeScript compilation and QuickJS are configured internally; callers choose sources, policy, and any overrides.

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
});
```

Use `serveCodeModeHttp` for a Streamable HTTP endpoint, or `createCodeModeMcp` when another host owns the downstream transport. The lower-level `@codemodekit/core`, `@codemodekit/mcp`, and `@codemodekit/sandbox-quickjs` packages remain available for expert composition.
