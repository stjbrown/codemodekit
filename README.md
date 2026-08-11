# CodeModeKit

CodeModeKit is a TypeScript toolkit for turning MCP, OpenAPI, and local tool sources into safe, programmable Code Mode servers. Its current public provider integrates MCP; OpenAPI and local-tool adapters are planned. Model-authored TypeScript runs in a bounded QuickJS/WASM sandbox while `tools.*` calls are routed to trusted host-side providers.

The repository currently contains the M0 walking skeleton, the M1 upstream MCP vertical slice, and the first M2 downstream adapter slice.

## Create a server

Scaffold a runnable Code Mode MCP directly from an upstream MCP command:

```sh
npm create codemodekit@latest zscaler-code-mode -- \
  --mcp-name zscaler \
  --mcp-command 'uvx --env-file .env zscaler-mcp'

cd zscaler-code-mode
npm start
```

The generator installs dependencies and creates one source file. It parses the MCP command into an executable and argument array; it never starts a shell. The generated project uses the explicit `allow-all` tool policy for a working starting point. Choose `--policy deny-all` when the server should start closed while you define a narrower policy, and use `--no-install` to generate without running `npm install`.

The hand-written equivalent is intentionally small:

```js
import {
  allowAllToolCalls,
  mcp,
  serveCodeModeStdio,
} from "codemodekit";

await serveCodeModeStdio({
  name: "zscaler-code-mode",
  version: "0.1.0",
  toolPolicy: allowAllToolCalls(),
  sources: [
    mcp.stdio({
      name: "zscaler",
      command: "uvx",
      args: ["--env-file", ".env", "zscaler-mcp"],
    }),
  ],
});
```

TypeScript compilation and QuickJS are the batteries-included runtime and stay out of the beginner API. Source helpers are available for `mcp.stdio`, `mcp.http` / `mcp.streamableHttp`, and `mcp.sse`. Limits, reconnect behavior, transport settings, search, and policy remain configurable. The facade defaults to a 120-second execution wall time, a 60-second upstream call timeout, 60-second MCP connect/discovery timeouts, and a 32 MiB stdio buffer; the lower-level packages retain their existing defaults.

To serve Streamable HTTP instead, switch the host function:

```js
import {
  allowAllToolCalls,
  mcp,
  serveCodeModeHttp,
} from "codemodekit";

const server = await serveCodeModeHttp({
  name: "zscaler-code-mode",
  version: "0.1.0",
  toolPolicy: allowAllToolCalls(),
  sources: [mcp.stdio({ name: "zscaler", command: "zscaler-mcp" })],
  port: 3000,
});

console.error(`Listening at ${server.url}`);
```

HTTP binds to `127.0.0.1` at `/mcp` by default. A non-loopback bind must explicitly set `allowUnauthenticatedRemoteAccess: true`; that flag acknowledges exposure but does not add authentication.

## Workspace

- `@codemodekit/core`: compiler, orchestration, normalized provider contracts, policy enforcement, schema validation, limits, diagnostics, and execution results.
- `@codemodekit/mcp`: SDK-owned MCP clients, upstream transport configuration, tool discovery, model-visibility filtering, invocation, cancellation, and host-only MCP sideband.
- `@codemodekit/sandbox-quickjs`: isolated QuickJS/WASM implementation with a pruned global surface and asynchronous host bridge.
- `codemodekit`: batteries-included Code Mode construction plus stdio and Streamable HTTP hosts.
- `create-codemodekit`: command-driven one-file project scaffolder.
- `tests/support/InMemoryTestToolProvider`: private deterministic provider fixture. It is not a supported local-tool provider.

## Development

Requirements: Node.js 20+ and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

The test suite runs the walking skeleton against both the release QuickJS build and its leak-detecting debug build.

## Runnable stdio server

The compiled example loads every valid MCP source from an already-installed Agent Plugins 1.0 package and exposes the small Code Mode surface over stdio:

```sh
pnpm run build
pnpm run example:stdio -- /path/to/plugin /path/to/plugin-data
```

It deliberately passes only `PATH` to plugin subprocesses and uses the explicit allow-all policy for demonstration. A production host should select any additional ambient state deliberately and replace that policy with its authorization rules. The example owns its upstream clients and Code Mode lifecycle; the official stdio entrypoint owns the downstream transport.

## Low-level consumer configuration

Each upstream MCP server gets the exact `name` that authored code will use beneath `tools`:

```ts
import { CodeMode, TypeScriptCompiler, allowAllToolCalls } from "@codemodekit/core";
import { McpToolProvider } from "@codemodekit/mcp";
import { QuickJsSandbox } from "@codemodekit/sandbox-quickjs";

const codeMode = new CodeMode({
  compiler: new TypeScriptCompiler(),
  sandbox: new QuickJsSandbox(),
  toolPolicy: allowAllToolCalls(),
  providers: [
    new McpToolProvider({
      name: "github",
      transport: {
        type: "stdio",
        command: "github-mcp-server",
        args: ["stdio"],
      },
    }),
    new McpToolProvider({
      name: "linear",
      transport: {
        type: "streamable-http",
        url: "https://mcp.example.com/linear",
      },
    }),
  ],
  reconnect: {
    initialDelayMs: 250,
    maxDelayMs: 30_000,
    multiplier: 2,
    jitterRatio: 0.2,
  },
});

await codeMode.start();
const catalog = await codeMode.getTypeScriptCatalog();
// Give catalog.declarations to the model as revisioned tools.* guidance.

const catalogHealth = await codeMode.getCatalogDiagnostics();
// Trusted, bounded details for tools excluded because their schemas are unsafe.

const result = await codeMode.run({
  code: `
    const issue = await tools.linear.get_issue({ id: "ENG-123" });
    return tools.github.create_issue({
      owner: "acme",
      repo: "product",
      title: issue.structuredContent.title,
    });
  `,
});
```

The SDK owns the MCP client and transport lifecycle. Consumers supply source configuration; model-authored code receives no module loader, credentials, transport objects, or host libraries. Generated declarations are conservative guidance tied to `catalog.catalogRevision`; host-side JSON Schema validation remains authoritative.

Register the small Code Mode surface on a consumer-owned MCP server:

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { registerCodeModeTools } from "@codemodekit/mcp";

const server = new McpServer({ name: "my-server", version: "1.0.0" });

// The consumer may register unrelated tools, resources, and Apps too.
registerCodeModeTools(server, { codeMode });

// The consumer chooses and owns the downstream server transport.
await server.connect(transport);
```

This exposes `run_typescript` plus bounded local `search_tools` discovery by default. TypeScript-detail searches include the self-contained `ToolResult` contract and extraction example so authored code knows to inspect `structuredContent` (including common nested `structuredContent.result` payloads) before falling back to guarded JSON text in `content`. Pass `{ codeMode, search: false }` to opt out of search without changing the internal catalog. Execution failures are returned as structured MCP tool errors so the LLM can inspect diagnostics and revise its code; downstream cancellation reaches the sandbox and active upstream calls.

An already-installed Agent Plugins 1.0.0 package can supply the same providers without manual translation:

```ts
import { loadAgentPlugin } from "@codemodekit/mcp";

const plugin = await loadAgentPlugin({
  root: "/opt/agent-plugins/deployment",
  dataDir: "/var/lib/my-app/plugins/deployment",
  // The consumer deliberately selects what ambient state plugin subprocesses inherit.
  baseEnv: { PATH: process.env.PATH ?? "" },
});

const codeMode = new CodeMode({
  compiler: new TypeScriptCompiler(),
  sandbox: new QuickJsSandbox(),
  toolPolicy: allowAllToolCalls(),
  providers: plugin.mcp.providers,
});
```

The loader reads only local root `plugin.json` and `mcp.json` files. It does not discover, download, install, update, or trust plugins on the consumer's behalf. A plugin stdio server executes host code, so consumers must load only packages they trust.

## Implemented

- TypeScript compiled as an async function body with explicit-return semantics.
- Asynchronous and concurrent `tools.<source>.<tool>()` calls across the WASM boundary.
- JSON Schema input/output enforcement and host-only provider sideband.
- JSON Schema draft-07, 2019-09, and 2020-12 validation.
- Per-tool schema quarantine with bounded startup/inspection diagnostics, deterministic duplicate handling, and automatic recovery after catalog refresh.
- Required host-side policy with catchable sandbox errors and fail-closed invalid decisions.
- Cancellation and per-tool timeout propagation into providers.
- Compute, memory, concurrency, call-count, bridge, final-result, and log bounds.
- No module loader, ambient host APIs, or dynamic function constructors in the sandbox.
- Degraded startup when one provider fails without disabling healthy siblings.
- Multiple MCP sources using consumer-defined names and SDK-owned clients.
- MCP stdio, Streamable HTTP, and legacy SSE transport configuration.
- Automatic MCP protocol-version negotiation and bounded connect/discovery timeouts.
- Independent bounded reconnect with jitter, atomic catalog replacement, and no failed-call replay.
- Atomic refresh after upstream `tools/list_changed`, with each execution pinned to one catalog revision.
- Stable `SOURCE_UNAVAILABLE`, `SOURCE_NOT_FOUND`, `TOOL_NOT_FOUND`, and `TOOL_SCHEMA_UNSUPPORTED` diagnostics through a lazy namespace.
- Revisioned, conservative TypeScript declarations for the active `tools` catalog, including exact bracket-notation names and local schema references.
- Deterministic bounded local catalog search with summary and TypeScript detail modes.
- Consumer-owned downstream MCP registration for `run_typescript` and optional `search_tools`.
- Downstream MCP cancellation and bounded lifecycle progress propagation.
- A compiled Agent Plugin-to-stdio server example proven through a process-level MCP client integration test.
- A shared provider-conformance suite run against both real MCP stdio and the private provider-neutral fixture.
- Agent Plugins 1.0.0 `plugin.json` and `mcp.json` loading with contained paths, `PLUGIN_ROOT`/`PLUGIN_DATA`, literal remote headers, and per-entry isolation.
- MCP Apps model-visibility filtering: app-only tools are not exposed to authored code.
- Actionable, catchable upstream MCP tool errors and cancellation propagation.
- Actionable compile and sandbox diagnostics returned as values.

## Not implemented yet

- Agent Plugin skill discovery and delivery.
- Complete v0.1 progress, health, diagnostic, and conformance surfaces.
- Public local-function and OpenAPI providers; these remain v2 work.

See [the v0.1 plan](docs/plan/v0.1.md) and [architecture](docs/architecture/code-mode.md) for the accepted design.
