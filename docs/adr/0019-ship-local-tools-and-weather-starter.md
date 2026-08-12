# ADR 0019: Ship Local Tools and a Weather-First Starter

**Status:** Accepted
**Date:** 2026-08-12

## Context

The first CodeModeKit release proved that the normalized catalog, sandbox bridge, and execution lifecycle could compose MCP sources. The private provider described in ADR 0018 proved the core was not coupled to MCP, but application developers still had to create or operate an MCP server to expose a trusted function.

The generator also required source flags on its first run. That made the shortest successful path less representative of the broader SDK: CodeModeKit is intended to compose MCP, local functions, and later OpenAPI operations, not only wrap MCP commands.

## Decision

CodeModeKit ships a public local-tool surface:

- `defineTool` defines one trusted host-side function with an input schema, optional output schema, metadata, and an async executor;
- `local` groups those definitions under a named source for the batteries-included facade;
- `LocalToolProvider` is exported for expert-level construction;
- schemas may be plain JSON Schema or implement Standard JSON Schema, including Zod 4;
- local tools return plain JSON values, which the provider exposes as both text content and `structuredContent`.

Local executors run on the trusted host. Model-authored TypeScript remains inside the configured sandbox and can reach a local function only through the normal tool bridge. Tool policy, schema validation, execution limits, cancellation, output validation, serialization bounds, and sanitized diagnostics continue to apply.

The default `create-codemodekit` flow becomes an interactive, weather-first starter. It generates two local tools backed by Open-Meteo: location search and current weather. The pair is deliberate because it demonstrates multiple tool calls composed inside one `run_typescript` execution. It uses keyless public endpoints by default, documents the non-commercial service constraint, and permits endpoint overrides for customer or self-hosted deployments.

Noninteractive generation remains available through `--example weather`, `--mcp-command`, and `--mcp-url`. The weather starter includes a companion Agent Plugin by default so the generated skill and catalog references demonstrate progressive disclosure immediately.

OpenAPI ingestion remains separate future work. Shipping local tools does not commit the project to treating arbitrary network calls as trusted or to deriving tool contracts from an OpenAPI document before that provider has its own security and compatibility review.

## Consequences

- A useful Code Mode MCP server can be created with one package command and edited in one source file.
- Application functions and MCP tools compose through the same model-facing `tools.*` surface.
- The provider-neutral core now has two supported production provider kinds.
- The public local-tool API becomes a `0.x` compatibility commitment and requires direct conformance, package, and generated-project tests.
- Host-side local functions retain the authority of the embedding process; CodeModeKit isolates model-authored code, not trusted application code.
- The starter depends on a third-party public service for live results, so deterministic tests use local HTTP fixtures and the documentation calls out production terms.

## Alternatives considered

### Require every function to be wrapped in MCP

This preserves one integration path but adds a process or network boundary where an application already owns the function and obscures the provider-neutral design.

### Expose the complete custom provider contract as the primary API

That maximizes flexibility but makes the common case responsible for normalized definitions, lifecycle, and provider result envelopes. `defineTool` and `local` provide a smaller supported surface while keeping the expert API available.

### Use a single weather tool

One tool is simpler but does not demonstrate the central Code Mode advantage: composing multiple focused operations in one sandbox execution and returning only the final value.

### Make the default starter another MCP wrapper

That would continue to require users to select and configure a separate server before they can see CodeModeKit work. MCP command and URL starters remain available explicitly.
