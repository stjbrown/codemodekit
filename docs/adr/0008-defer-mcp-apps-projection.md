# ADR 0008: Defer MCP Apps Projection

**Status:** Accepted  
**Date:** 2026-08-09

## Context

The Code Mode server consumes upstream MCP servers but exposes their tools to an LLM through one downstream `run_typescript` computation surface. This changes the protocol topology and cannot transparently preserve an upstream MCP App by forwarding its tool result alone.

A complete projection would need to negotiate downstream capabilities, re-expose selected tool definitions, enforce model-versus-app visibility, rewrite and proxy `ui://` resources, route app-only calls to the originating source, forward complete results to the View, and define which UI—if any—represents a TypeScript execution that combines several tool calls.

This work is separable from the v0.1 goal of safely orchestrating tools from multiple upstream MCP servers. The provider and normalization boundaries must nevertheless avoid destroying information that a later projection will need.

## Decision

v0.1 does not provide transparent MCP Apps/UI projection for upstream MCP servers.

It does:

- retain unknown tool-definition metadata, result metadata, annotations, extension fields, and source provenance losslessly in trusted host-side representations;
- keep protocol sideband distinct from the documented sandbox computation view and model-visible result;
- recognize and exclude app-only upstream tools from the model-facing catalog;
- document that preservation of extension data does not make the extension operational downstream.

It does not:

- advertise upstream UI-bearing tools as downstream tools;
- rewrite or proxy upstream UI resource URIs;
- proxy View-to-server app calls;
- copy opaque `_meta` into sandbox or model context by default;
- claim transparent MCP Apps compatibility.

A later extension-aware adapter may add these capabilities without changing the core `ToolProvider`, normalized catalog, or `CodeSandbox` contracts. Its design must explicitly resolve capability propagation, identifier rewriting, visibility, authorization, CSP, lifecycle, and multi-tool composition.

## Consequences

- The v0.1 implementation remains focused on the Code Mode computation path.
- Unknown extension data survives for future adapters and diagnostic inspection.
- UI-enabled upstream tools can still be invoked for their computation-facing behavior when model-visible, but their upstream View is not presented by the Code Mode server.
- Consumers cannot rely on upstream MCP Apps rendering through v0.1.
- The normalized representation needs a lossless protocol-sideband envelope even though the sandbox API exposes a smaller result shape.
- Tests must prove both preservation and non-exposure: extension fields round-trip internally, while app-only tools and opaque sideband do not enter the model-facing surface.

## Alternatives considered

### Project selected upstream UI tools beside `run_typescript`

This can preserve individual MCP App semantics, but it expands the downstream tool surface and requires capability, resource, app-call, and identity proxying before the main Code Mode path is proven.

### Give `run_typescript` one generic multiplexing UI

This retains a small tool surface but introduces a new trusted UI host and ambiguous presentation semantics for executions that combine or transform multiple upstream results.

### Discard unsupported extension metadata

This simplifies internal types but makes future projection lossy and can erase useful provider data without warning.
