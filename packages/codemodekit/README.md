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
  observer: (event) => console.error(JSON.stringify(event)),
});
```

Use `serveCodeModeHttp` for a Streamable HTTP endpoint, or `createCodeModeMcp` when another host owns the downstream transport. The optional observer receives timing, identity, size, outcome, and stable-error metadata; it never receives authored code, tool payloads, logs, or diagnostic messages, and observer failures cannot affect execution.

The lower-level `@codemodekit/core`, `@codemodekit/mcp`, and `@codemodekit/sandbox-quickjs` packages remain available for expert composition.
