# CodeModeKit Glossary

**Status:** Living document  
**Last updated:** 2026-08-12

| Term | Working definition |
|---|---|
| Code Mode | A tool-use pattern in which an LLM submits code that can orchestrate multiple tools behind a small model-facing interface. |
| Code Mode server | The downstream MCP server built with this SDK. It exposes `run_typescript` to an LLM client and delegates execution to `CodeMode`. |
| LLM client | The MCP client acting on behalf of an LLM and calling the Code Mode server. |
| Upstream MCP server | A source MCP server whose tools are discovered and invoked through `McpToolProvider`. |
| Managed MCP client | An official MCP TypeScript SDK client constructed, connected, and closed by this SDK from consumer-supplied configuration. |
| Guaranteed MCP matrix | The protocol revisions and transport paths exercised as contractual v0.1 compatibility: modern `2026-07-28`, legacy `2025-11-25`, stdio, Streamable HTTP, and the legacy SSE upstream-client path. Older behavior inherited from the pinned SDK is best effort. |
| Exact-pinned MCP SDK | The single prerelease version of the official split TypeScript SDK packages used and tested by a Code Mode release. It is upgraded only through an intentional SDK change. |
| Direct MCP configuration | Consumer-supplied TypeScript configuration for an upstream server, independent of an Agent Plugin package. |
| Agent Plugin | A portable package containing `plugin.json` and optional `mcp.json` and `skills/` components under the Agent Plugins specification. Compatible clients discover its runtime skills and MCP servers; CodeModeKit can also load its upstream MCP configuration directly. |
| Development skill | A project-level Agent Skill under `.agents/skills` that guides a coding agent while building CodeModeKit. It is not copied into the portable runtime plugin. |
| Runtime skill | A domain-aware Agent Skill under a plugin's `skills/` directory that teaches an end-user agent when and how to use the packaged Code Mode MCP server. |
| Mechanical skill baseline | The generator-owned initial runtime skill containing Code Mode execution mechanics and generated catalog references but no claim to understand the integration's users or domain workflows. |
| Plugin MCP server key | A member name in an Agent Plugin's `mcpServers` object. It identifies a configured server but is not guaranteed to be a TypeScript identifier. |
| Downstream MCP surface | The small set of tools exposed by the Code Mode server to the LLM client. |
| Protocol-native surface | An MCP exposure that owns its own wire-level semantics, such as a direct tool, MCP App, task-capable operation, or future MCP Skills delivery. It may coexist with Code Mode without being tunneled through it. |
| Multi-projection capability | One underlying application capability deliberately exposed through more than one surface, such as both a sandbox `tools.*` call and a direct MCP App tool. Each projection has a separate contract and registration. |
| `run_typescript` | The primary downstream MCP tool. Its `code` input is treated as an async function body for bounded execution, allowing top-level `await` and explicit `return`; its result exposes the `CodeMode.run` success/failure union through MCP. |
| Execution result | The `ok: true` or `ok: false` value resolved by `CodeMode.run` for an attempted execution. Expected authored-code failures are values, not thrown SDK exceptions. |
| Sandbox tool result | The computation-facing `{ content, structuredContent? }` value returned by a successful `tools.*` call. It excludes opaque provider sideband such as MCP `_meta`. |
| Tool-call error | A sanitized, catchable error raised inside the sandbox when a provider reports execution failure. If uncaught, it becomes the model-visible tool-phase diagnostic for the whole execution. |
| Model-visible diagnostic | A bounded, sanitized, source-mapped explanation returned to the LLM for a compilation, sandbox, or uncaught tool failure. |
| SDK error code | A stable, SDK-owned classification in a model-visible diagnostic, such as `TOOL_INPUT_INVALID`. Its meaning is independent of any compiler or upstream provider code. |
| Upstream error code | A sanitized compiler, protocol, or provider-specific code retained as secondary diagnostic context. It never replaces the SDK error code. |
| Trusted diagnostic | A fuller host-side error record linked to the model-visible diagnostic by correlation identifier and never placed in the sandbox or model result. |
| `CodeMode` | The public orchestration facade coordinating compilation, sandbox execution, tool access, and result production. |
| `CodeCompiler` | The boundary that turns model-authored TypeScript into executable JavaScript and returns diagnostics. |
| `CodeSandbox` | The portable isolation boundary in which compiled model-authored code executes. |
| Safe globals | The versioned, runtime-independent allowlist of JavaScript intrinsics and SDK bindings available to model-authored code. It excludes module loading, dynamic code generation, and ambient host capabilities. |
| Execution limits | The finite trusted-host policy bounding source size, compute and wall time, tool calls, concurrency, memory, bridge traffic, final output, and logs for one `CodeMode.run`. |
| Compute time | Cumulative time actively executing sandbox JavaScript, excluding suspension while awaiting host-side tool calls. |
| Bridge volume | The cumulative UTF-8 serialized bytes crossing between sandbox and trusted host for tool arguments and computation-facing tool results during one execution. |
| Root cancellation signal | The trusted `AbortSignal` for one execution, derived from the consumer or downstream MCP request and propagated to sandbox, bridge queue, and active provider work. |
| Execution progress | A bounded provider-independent lifecycle event for the outer Code Mode run. Nested upstream progress may inform its message but does not supply its token or numeric sequence. |
| `ToolBridge` | The trusted host-side boundary that resolves, authorizes, validates, invokes, and correlates tool calls originating in the sandbox. |
| Tool policy | The required trusted-host callback that returns a final allow or deny decision for each validated sandbox-originated tool call before provider dispatch. |
| Explicit allow-all policy | The SDK helper consumers must deliberately configure when every active model-visible tool is authorized without per-call review. It is never the implicit default. |
| `ToolProvider` | An adapter that supplies normalized tool metadata and invocation behavior. |
| `McpToolProvider` | A `ToolProvider` backed by an upstream MCP connection. Multiple instances can contribute tools to one Code Mode catalog. |
| `LocalToolProvider` | A `ToolProvider` backed by trusted host-side functions. Inputs and JSON outputs cross the same policy, validation, cancellation, limits, and diagnostic boundaries as other tool calls. |
| `defineTool` | An identity helper that preserves schema-derived input and output types for one local tool definition. It accepts JSON Schema or a Standard JSON Schema-compatible library such as Zod. |
| `local` | The batteries-included factory that groups application-owned functions under one named tool source. |
| In-memory test provider | A private deterministic v0.1 fixture used to prove that provider-neutral contracts do not depend on MCP. It is not exported or supported as a local-tool feature. |
| Provider conformance suite | Shared behavioral tests for discovery, normalization, invocation, results, errors, cancellation, and catalog lifecycle that apply to each provider implementation where relevant. |
| Tool source | A configured origin of normalized tools. MCP and local-function sources are implemented; OpenAPI sources are planned. |
| Source name | A unique configured name that identifies a tool source and becomes its top-level `tools` namespace. It is preserved exactly and is distinct from upstream server metadata. |
| Source health | The host-side lifecycle state of one configured tool source: connecting, healthy, unavailable, or stopped, with a sanitized reason when unavailable. |
| Degraded state | An operational Code Mode instance in which at least one configured source is unavailable, including the case where no source is currently healthy. |
| Source catalog contribution | The tools currently supplied by one source to the aggregated catalog; it is replaced atomically after successful reconnection and discovery. |
| Aggregated catalog | The unified, provider-independent view of tools contributed by every configured tool source. |
| Catalog revision | An opaque identifier for one atomically published catalog snapshot, included in search results and stale-catalog diagnostics. |
| `search_tools` | The default bounded model-facing fallback for deterministic local discovery of active tools and their exact TypeScript call shapes. It may be disabled by the consumer. |
| Normalized tool | The SDK's provider-independent representation of a tool's address, schemas, metadata, and invocation target. |
| Authoritative schema | The preserved provider JSON Schema used for trusted runtime validation. Generated TypeScript is a conservative projection of this schema, not its replacement. |
| Quarantined tool | A discovered tool excluded from the active sandbox catalog because a declared schema is invalid or cannot be enforced safely. Its source and valid sibling tools remain operational. |
| Catalog diagnostic | A bounded host-side report explaining why a discovered tool was quarantined or imprecisely typed. It can be surfaced through startup health and trusted inspection without injecting the complete catalog into model context. |
| Protocol sideband | Provider- or extension-specific metadata such as MCP `_meta` that must be retained with source provenance but is not automatically exposed to sandboxed code or model context. |
| Downstream projection | The extension-aware mapping from internal tool definitions, results, resources, and protocol sideband onto the Code Mode server's MCP surface. |
| MCP Apps projection | A post-v0.1 downstream capability that preserves UI capability negotiation, `_meta.ui` linkage and visibility, proxied `ui://` resources, app-scoped calls, and complete tool results. It is not achieved by copying `_meta` alone. |
| MCP Task projection | Protocol-native durable execution semantics applied to one downstream operation. A future task-capable `run_typescript` call would track the complete code execution, not expose nested upstream tasks as equivalent downstream handles. |
| Tool namespace | The path used by sandboxed code to address a normalized tool, such as `tools.github.searchIssues` or `tools["deployment-api"].deploy`. Names are never silently rewritten. |
| Model-authored code | Untrusted TypeScript supplied as the body of the `run_typescript` async entry function; it must execute only inside the configured sandbox. |
| Progressive disclosure | Supplying focused tool instructions only when relevant instead of placing the complete catalog in model context. |
