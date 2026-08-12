# ADR 0009: Keep Protocol-Native Capabilities Outside the Code Mode Core

**Status:** Accepted  
**Date:** 2026-08-09

## Context

Code Mode reduces a large tool catalog to a small model-facing computation interface. MCP also defines or is developing protocol-native capabilities with their own discovery, negotiation, lifecycle, and presentation semantics, including [MCP Apps](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [MCP Tasks](https://tasks.extensions.modelcontextprotocol.io/), and the experimental [MCP Skills work](https://github.com/modelcontextprotocol/experimental-ext-skills).

Forcing those semantics through the result of a nested `tools.*` call creates false equivalence. A downstream host sees one `run_typescript` invocation, not each provider call made inside the sandbox. It therefore cannot automatically treat a nested UI result as a directly invoked App or a nested durable operation as the task representing the complete code execution.

At the same time, the same application service may legitimately support more than one exposure. A local reporting capability might be callable from sandboxed TypeScript and also have a directly registered interactive MCP App.

## Decision

`CodeMode` remains a computation core. Protocol-native features are explicit sibling projections or adapters around application capabilities and the consumer-owned MCP server.

The MCP adapter is composable: it registers the Code Mode surface without taking exclusive ownership of the server, unrelated tools, resources, extensions, or server lifecycle.

An underlying application capability may have multiple deliberate projections:

- a normalized `ToolProvider` entry callable through sandboxed TypeScript;
- a direct downstream MCP tool;
- a direct MCP App with owned UI resources and app-only tools;
- a task-capable downstream operation;
- documentation delivered through a future MCP Skills adapter.

Each projection is separately configured, named, authorized, negotiated, and tested. The SDK never creates a protocol-native projection merely because an upstream or normalized result contains related metadata.

Specific rules follow:

- A consumer-owned tool registered directly as an MCP App can render a View. Calling the same service through `LocalToolProvider` inside `run_typescript` is computation-only.
- A future Tasks adapter may make the outer `run_typescript` call task-capable. That task represents the whole code execution. A task used by a nested upstream provider call is managed internally and is not surfaced as the downstream execution's task handle.
- Canonical skill content remains independent of the core. Agent Plugins package it today; a future MCP Skills adapter may expose it once the protocol is stable.
- Unsupported upstream extension data remains preserved as protocol sideband according to ADR 0008, without implying passthrough.

## Consequences

- The core compiler, sandbox, bridge, and provider contracts stay independent of changing MCP extension wire formats.
- Consumers can compose Code Mode with direct MCP tools and extensions on one server.
- Local capabilities can support rich protocol-native experiences without making every sandbox call carry UI or lifecycle semantics.
- Dual exposure can introduce naming, authorization, and behavioral drift, so it must be explicit and covered by projection-specific tests.
- Transparent upstream extension projection, if added later, remains a distinct adapter with stronger routing and compatibility obligations.
- Tasks support for `run_typescript` can be added without changing what nested `tools.*` calls return to sandboxed code.

## Alternatives considered

### Tunnel every extension through `run_typescript`

This preserves the smallest apparent surface but loses the host's direct protocol interaction and creates ambiguous composition when one execution invokes several extended tools.

### Automatically expose every normalized tool through every supported projection

This expands the model-facing surface, can accidentally expose app-only operations, and makes authorization and naming behavior implicit.

### Put extension behavior in `ToolProvider`

This couples provider-independent computation to MCP-specific presentation and lifecycle semantics, complicating future local and OpenAPI providers.
