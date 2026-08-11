# ADR 0001: Compose Multiple Tool Sources into One Catalog

**Status:** Accepted  
**Date:** 2026-08-09

## Context

A useful Code Mode server must let one TypeScript execution orchestrate tools that originate from multiple upstream systems. Restricting a server instance to one upstream MCP server would force the LLM or host application to coordinate several Code Mode surfaces and would undermine the purpose of code-level orchestration.

The initial release only needs MCP-backed sources. A later v2 must also compose local functions and OpenAPI operations with MCP tools at the same time.

## Decision

One `CodeMode` instance will combine multiple configured tool sources into a single normalized catalog.

For v0.1:

- multiple upstream MCP servers are a release requirement;
- each upstream connection is represented behind the `ToolProvider` boundary;
- one TypeScript execution can invoke tools from several upstream servers;
- routing metadata remains trusted host state and does not enter the sandbox;
- tool addresses must be unique and stable within the aggregated catalog.

For v2:

- local-function and OpenAPI providers can contribute to that same catalog alongside MCP providers;
- provider origin must not change the sandbox invocation model;
- provider-specific authentication and lifecycle behavior remain behind the provider boundary.

The source naming and collision-resolution scheme is defined by ADR 0002.

## Consequences

- Provider and catalog contracts must support composition from their first stable version.
- Catalog refresh and connection failure semantics must account for independently changing sources.
- Namespacing cannot rely on upstream tool names being globally unique.
- Tests must cover a single execution invoking tools from at least two upstream servers.
- The initial release does not need working local or OpenAPI providers, but it must avoid MCP-specific assumptions in the normalized catalog, sandbox proxy, and bridge.

## Alternatives considered

### One Code Mode server per upstream MCP server

This simplifies names and connection lifecycle but prevents a single TypeScript program from naturally orchestrating tools across servers.

### Merge raw upstream tool names into a flat catalog

This keeps calls short but cannot reliably handle common names or future heterogeneous providers.

### Defer provider composition until v2

This reduces the v0.1 surface but risks stabilizing MCP-specific contracts that later require breaking changes.

