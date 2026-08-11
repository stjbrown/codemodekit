# ADR 0010: Return Computation-Focused Tool Results to the Sandbox

**Status:** Accepted  
**Date:** 2026-08-09

## Context

An MCP `CallToolResult` is a protocol envelope. It may contain model-facing content, typed `structuredContent`, an `isError` marker, and opaque `_meta` intended for hosts or extensions. Returning that object unchanged to sandboxed TypeScript would expose protocol sideband to model-authored code and couple future local and OpenAPI providers to MCP wire details.

Automatically returning only `structuredContent` would be more ergonomic for some tools, but it would discard text, image, audio, embedded-resource, and resource-link content. It would also make a tool's runtime return shape change depending on whether its upstream server happened to provide structured output.

## Decision

A successful call through the sandbox `tools` proxy resolves to:

```ts
interface ToolResult<TStructured = unknown> {
  content: ToolContentBlock[];
  structuredContent?: TStructured;
}
```

`ToolContentBlock` is a bounded, provider-independent rich-content union structurally compatible with the content needed from supported MCP tool results. Provider adapters map their output into this computation shape.

For an MCP-backed tool:

- `content` is preserved and normalized;
- `structuredContent`, when present, is validated against the tool's output schema and returned without automatic unwrapping;
- unknown `_meta` and the complete original result remain in the trusted host-side invocation envelope with source provenance;
- `_meta` is not exposed to sandboxed code or model context by default;
- `isError: true` raises a sanitized, catchable tool-call error inside the sandbox rather than resolving a nominal success wrapper.

The catchable error exposes only the stable safe fields needed for recovery, including a code, message, source name, exact tool name, and bounded safe details. If model-authored code catches it and returns a fallback, the overall execution succeeds. If it escapes, `CodeMode.run` returns an `ok: false` tool-phase diagnostic under ADR 0006.

The downstream MCP adapter receives the final `CodeMode.run` result. It does not attach an arbitrary nested call's protocol sideband to the outer `run_typescript` result.

## Consequences

- Sandbox programs have one predictable return shape across tools and providers.
- Rich non-structured content is not silently discarded.
- Generated TypeScript can specialize `structuredContent` from each normalized output schema.
- Accessing structured data requires `.structuredContent`, which is slightly more verbose than automatic unwrapping.
- Bounded `search_tools` responses with `detail=typescript` include the shared `ToolResult` declaration, extraction guidance, and a guarded JSON-text example so a model does not have to infer the wrapper from a bare `ToolResult<unknown>` reference.
- `run_typescript` metadata tells models to keep calls, extraction, and transformation inside one sandbox execution instead of spilling raw results into host files or commands.
- Protocol extension data remains available for trusted diagnostics and future projection without entering the sandbox.
- Tool execution errors support model-authored recovery with `try`/`catch` and actionable uncaught diagnostics.
- Local and OpenAPI providers added in v2 must map results into the same computation shape or explicitly document a compatible adapter helper.

## Alternatives considered

### Return the complete MCP `CallToolResult`

This preserves every field but exposes opaque protocol sideband and makes MCP wire format the provider-independent sandbox contract.

### Automatically unwrap `structuredContent`

This is concise for structured tools but loses other content and gives tools inconsistent return behavior when structured output is absent.

### Return `isError` as ordinary result data

This makes every call site manually check a protocol flag and makes ignored execution failures look like successful computation.
