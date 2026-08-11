# ADR 0018: Prove Provider Neutrality with a Private Test Provider

**Status:** Accepted  
**Date:** 2026-08-09

## Context

v0.1 composes multiple upstream MCP servers, but every production source uses the same `McpToolProvider` implementation. That proves multi-source routing and lifecycle isolation; it does not prove that the normalized catalog, bridge, execution, and diagnostic contracts are independent of MCP.

Shipping a real `LocalToolProvider` or `OpenApiToolProvider` in v0.1 would expand the release beyond its intended vertical slice. Stabilizing a public custom-provider interface before at least two real provider kinds exist would also risk preserving abstractions shaped accidentally around MCP.

The architecture nevertheless needs executable evidence that provider-neutral behavior is real before v2.

## Decision

`McpToolProvider` is the only supported production provider in v0.1. Local-function and OpenAPI providers remain v2 work.

The v0.1 test suite will include a private deterministic `InMemoryTestToolProvider`. It is test infrastructure, is not exported, and is not documented as local-tool support. It implements the same internal provider boundary as `McpToolProvider` without using any MCP SDK types or behavior.

A shared provider conformance suite will exercise both implementations where the behavior applies. It will cover at least:

- discovery and normalization into a source catalog contribution;
- exact source and tool naming;
- authoritative input and output schemas;
- computation-facing content and structured results;
- opaque provider sideband and source provenance retention;
- provider-declared execution errors and SDK-owned diagnostic mapping;
- root cancellation and terminal-state races;
- atomic catalog replacement;
- independent source failure and recovery.

At least one end-to-end execution test will mix a real MCP test server and the private in-memory provider in the same `CodeMode` catalog, invoke both from one authored TypeScript program, and return one bounded final result.

The provider contract is an internal or explicitly experimental v0.1 seam, not a stable custom-extension promise. If TypeScript declarations require it to be exported, it is marked experimental and consumers are warned that it may change during `0.x`. v2 will use evidence from the real local-function and OpenAPI implementations before deciding which provider API to stabilize.

Provider-independent enforcement remains above the provider boundary. A test provider cannot bypass naming, visibility, schema validation, policy evaluation, execution limits, result bounds, or diagnostic sanitization merely because it does not use MCP.

## Consequences

- v0.1 gains executable evidence that the core is provider-neutral without adding another user-facing provider.
- The mixed-provider test catches MCP types, `_meta`, transport state, or error shapes leaking into the core contract.
- Test infrastructure must model discovery, failure, cancellation, sideband, and catalog changes rather than acting as a trivial function stub.
- Consumers do not receive a supported local-tool shortcut in v0.1.
- The eventual public provider extension API remains free to change based on real v2 implementations.

## Alternatives considered

### Test only multiple MCP servers

This proves source composition but can leave MCP-specific assumptions embedded in supposedly provider-neutral contracts.

### Ship `LocalToolProvider` in v0.1

This would provide stronger production evidence but expands product scope, documentation, security review, and compatibility obligations before the MCP vertical slice ships.

### Stabilize a public custom-provider interface immediately

One real provider is insufficient evidence that the interface has the right lifecycle, metadata, authentication, and invocation boundaries for other provider kinds.

### Defer all heterogeneity testing to v2

This postpones discovery of architectural coupling until changing the core is more expensive.
