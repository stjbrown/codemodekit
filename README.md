# CodeModeKit

CodeModeKit turns tool sources into safe, programmable Code Mode servers. It ships batteries-included MCP and application-owned Local Tool providers; OpenAPI is planned. Model-authored TypeScript runs in a bounded QuickJS/WASM sandbox while `tools.*` calls are routed to trusted host-side providers.

## Install the skills, then go

Give CodeModeKit to Cursor, Codex, Claude Code, or another compatible coding agent with the open [skills CLI](https://skills.sh/):

```sh
npx skills add stjbrown/codemodekit
```

Select both skills when prompted:

- `build-codemodekit-server` scaffolds, configures, and verifies Code Mode MCP servers from Local Tools or upstream MCPs.
- `author-codemode-skill` turns the generated companion skill into domain-aware runtime guidance and maintains the Agent Plugin package.

Then tell your agent what you want, for example: _Use the build-codemodekit-server skill to create a Code Mode MCP for my tools._ When the runtime works: _Use the author-codemode-skill skill to turn the companion skill into useful workflows for this domain._

Each skill can also be installed independently:

```sh
npx skills add stjbrown/codemodekit --skill build-codemodekit-server
npx skills add stjbrown/codemodekit --skill author-codemode-skill
```

For a non-interactive install of the complete set, select all skills and add the agent you use:

```sh
npx skills add stjbrown/codemodekit \
  --skill '*' \
  --agent cursor \
  --copy \
  --yes
```

## Start with weather

Run the interactive generator and accept its defaults:

```sh
npm create codemodekit@latest
```

Or generate the same editable, keyless starter non-interactively:

```sh
npm create codemodekit@latest weather-code-mode -- --example weather
cd weather-code-mode
npm start
```

The starter exposes `weather.findLocation` and `weather.getCurrentWeather` as host-side Local Tools. An agent can geocode a city, fetch current conditions, and reshape the result inside one `run_typescript` call. It also generates and builds a portable Agent Plugin by default. The example uses Open-Meteo's public non-commercial endpoints; its generated `.env.example` shows how to select customer or self-hosted endpoints.

## Wrap an MCP server

Scaffold a runnable Code Mode MCP and portable Agent Plugin around [GitHub's official MCP server](https://github.com/github/github-mcp-server):

```sh
export GITHUB_PERSONAL_ACCESS_TOKEN=your_token_here

npm create codemodekit@latest github-code-mode -- \
  --mcp-name github \
  --mcp-command 'docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN -e GITHUB_READ_ONLY=1 ghcr.io/github/github-mcp-server' \
  --agent-plugin

cd github-code-mode
npm start
```

The generator installs dependencies and creates one executable source file. With `--agent-plugin`, it also writes [Agent Plugins 1.0](https://agent-plugins.org/) `plugin.json` and `mcp.json`, a compact runtime Agent Skill, catalog-derived TypeScript references, and a self-contained `dist/plugin` artifact. It attempts the initial reference sync automatically; run `npm run plugin:sync` again whenever the upstream catalog changes. Use `--no-sync` when credentials or connectivity will be configured later.

Every scaffold also receives two project-level development skills: `.agents/skills/build-codemodekit-server` builds and verifies the server, while `.agents/skills/author-codemode-skill` turns the generated runtime baseline into domain-aware workflows and maintains the Agent Plugin. Use `--no-authoring-skill` to omit both. Development skills are not included in the runtime plugin artifact.

The generator obtains those files from `@codemodekit/skills`, which remains the programmatic and npm-packaged installer. The `npx skills add stjbrown/codemodekit` path above is the preferred way to add or update them in an existing project.

The MCP command is parsed into an executable and argument array; the generator never starts a shell. The generated project uses the explicit `allow-all` tool policy for a working starting point. In the GitHub example, the upstream server is independently placed in read-only mode. Choose `--policy deny-all` when the CodeModeKit server should start closed while you define a narrower policy, and use `--no-install` to generate without running `npm install`.

### Build and install the plugin

Generated Agent Plugin projects include a small lifecycle:

```sh
npm run plugin:sync             # refresh catalog-derived tool types
npm run plugin:build            # rebuild dist/plugin
npm run plugin:install:cursor   # build and install a concrete Cursor copy
npm run plugin:status:cursor
npm run plugin:uninstall:cursor
```

`dist/plugin` is dependency-free: it contains the bundled server, QuickJS WASM, manifests, and runtime skill, but never copies `node_modules`, `.env`, or source files. Its portable `mcp.json` uses `${PLUGIN_ROOT}`. Cursor currently needs concrete paths, so its installer copies the artifact under `~/.cursor/plugins/local`, resolves the active Node executable and server path, and asks you to reload the Cursor window. Re-run the install command after changing source, policy, metadata, or generated references.

The CLI also accepts `--plugin-name`, `--skill-name`, `--plugin-description`, and `--plugin-license` when preparing a distributable plugin.

The hand-written equivalent is intentionally small:

```js
import {
  allowAllToolCalls,
  mcp,
  serveCodeModeStdio,
} from "codemodekit";

await serveCodeModeStdio({
  name: "github-code-mode",
  version: "0.1.0",
  toolPolicy: allowAllToolCalls(),
  sources: [
    mcp.stdio({
      name: "github",
      command: "docker",
      args: [
        "run", "-i", "--rm",
        "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
        "-e", "GITHUB_READ_ONLY=1",
        "ghcr.io/github/github-mcp-server",
      ],
    }),
  ],
});
```

Application functions use the same provider-neutral surface without another MCP process:

```ts
import { z } from "zod";
import {
  allowAllToolCalls,
  defineTool,
  local,
  serveCodeModeStdio,
} from "codemodekit";

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

`defineTool` accepts plain JSON Schema or any schema library implementing Standard JSON Schema. Local tool functions receive validated input plus execution IDs and an `AbortSignal`, return plain JSON, and may throw `ToolError` when a bounded message is safe to expose to authored code.

TypeScript compilation and QuickJS are the batteries-included runtime and stay out of the beginner API. Source helpers are available for `mcp.stdio`, `mcp.http` / `mcp.streamableHttp`, and `mcp.sse`. Limits, reconnect behavior, transport settings, search, and policy remain configurable. The facade defaults to a 120-second execution wall time, a 60-second upstream call timeout, 60-second MCP connect/discovery timeouts, and a 32 MiB stdio buffer; the lower-level packages retain their existing defaults.

Add an observer when the host needs metrics, traces, or audit correlation:

```js
await serveCodeModeStdio({
  name: "my-code-mode",
  version: "0.1.0",
  toolPolicy: allowAllToolCalls(),
  sources,
  observer: (event) => console.error(JSON.stringify(event)),
});
```

Observation events include timestamps, execution and call IDs, source/tool names, byte counts, durations, outcomes, and stable error codes. They deliberately exclude authored code, tool inputs, tool results, logs, diagnostic messages, and credentials. Observer failures are isolated from execution.

To serve Streamable HTTP instead, switch the host function:

```js
import {
  allowAllToolCalls,
  mcp,
  serveCodeModeHttp,
} from "codemodekit";

const server = await serveCodeModeHttp({
  name: "my-code-mode",
  version: "0.1.0",
  toolPolicy: allowAllToolCalls(),
  sources: [mcp.stdio({ name: "upstream", command: "my-mcp-server" })],
  port: 3000,
});

console.error(`Listening at ${server.url}`);
```

HTTP binds to `127.0.0.1` at `/mcp` by default. A non-loopback bind must explicitly set `allowUnauthenticatedRemoteAccess: true`; that flag acknowledges exposure but does not add authentication.

## Workspace

- `@codemodekit/core`: compiler, orchestration, normalized provider contracts, policy enforcement, schema validation, limits, diagnostics, and execution results.
- `@codemodekit/mcp`: SDK-owned MCP clients, upstream transport configuration, tool discovery, model-visibility filtering, invocation, cancellation, and host-only MCP sideband.
- `@codemodekit/sandbox-quickjs`: isolated QuickJS/WASM implementation with a pruned global surface and asynchronous host bridge.
- `codemodekit`: batteries-included MCP and Local Tool sources plus stdio and Streamable HTTP hosts.
- `@codemodekit/skills`: installable server-building and domain-aware runtime-skill authoring guidance for coding agents.
- `create-codemodekit`: command-driven one-file project, Agent Plugin, skill installation, build, and Cursor-install tooling.
- `tests/support/InMemoryTestToolProvider`: private deterministic provider fixture; applications should use the public `local()` source.

## Development

Requirements: Node.js 20+ and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run test:package
pnpm run test:skills
```

The test suite runs the walking skeleton against both the release QuickJS build and its leak-detecting debug build. The package smoke test packs all six public packages, installs those tarballs into clean projects, and calls `run_typescript` through portable MCP-backed and Local Tool weather plugins.

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
- Agent Plugins 1.0 scaffolding with a companion Agent Skill and revisioned catalog-derived TypeScript references.
- Self-contained Agent Plugin bundling with portable manifests and QuickJS WASM.
- Project-local CodeModeKit authoring skills and concrete Cursor install/status/uninstall lifecycle commands.
- Official Agent Plugins schema checks, Agent Skills conformance checks, and clean packed-consumer smoke coverage.
- MCP Apps model-visibility filtering: app-only tools are not exposed to authored code.
- Actionable, catchable upstream MCP tool errors and cancellation propagation.
- Actionable compile and sandbox diagnostics returned as values.
- Payload-free execution/tool observation events for metrics, tracing, and audit correlation.

## Not implemented yet

- Agent Plugin skill discovery and delivery by CodeModeKit itself. Generated plugins already package skills for compatible clients.
- Complete v0.1 health and observability surfaces.
- OpenAPI providers; these remain future work.

See [the v0.1 plan](docs/plan/v0.1.md) and [architecture](docs/architecture/code-mode.md) for the accepted design.

## License

CodeModeKit is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Stephen Brown.
