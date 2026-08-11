# ADR 0011: Use JSON Schema as the Runtime Authority

**Status:** Accepted  
**Date:** 2026-08-09

## Context

Upstream MCP servers describe tool inputs and optional structured outputs with JSON Schema. The SDK needs those schemas for trusted runtime validation, generated TypeScript guidance, catalog documentation, and later provider conformance. TypeScript types alone cannot enforce runtime values or express every JSON Schema constraint.

Schemas are untrusted input. Resolving arbitrary external references during discovery would add network access, nondeterminism, authentication ambiguity, and SSRF risk. Rejecting a whole upstream source because one tool publishes a malformed schema would conflict with the SDK's independent-failure design.

## Decision

The preserved provider JSON Schema is authoritative for runtime behavior. Generated TypeScript is a conservative projection used for model guidance and documentation.

The schema pipeline follows these rules:

- Preserve an explicit `$schema`. When it is absent, choose the default defined by the upstream MCP protocol version; the [current MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) defaults to JSON Schema 2020-12.
- Support fragment references within the same schema document, including local `$defs`.
- Do not retrieve network, filesystem, or other external `$ref` targets. v0.1 has no ambient reference resolver.
- Compile validators and TypeScript declarations in the trusted host during catalog construction, never inside the sandbox.
- Validate tool inputs immediately before provider dispatch, regardless of TypeScript compilation success.
- Always validate provider results for supported content-block structure, serializability, and configured size bounds.
- When a declared output schema exists, validate `structuredContent` against it. Without an output schema, retain its type as `unknown` while still applying structural and bounds checks.
- Preserve JSON Schema constraints that TypeScript cannot express for runtime validation. Generate `unknown` for a valid portion that cannot be projected precisely rather than widening it silently to `any` or rejecting the tool.

A tool is quarantined only when a declared input or output schema is invalid or cannot be compiled into the required runtime validator. Quarantine behavior is per tool:

- exclude it from the active sandbox catalog and generated normal tool documentation;
- retain its source identity and bounded diagnostic in a rejected-tool index;
- return `TOOL_SCHEMA_UNSUPPORTED` if stale model-authored code addresses that exact rejected tool;
- keep its source connection and valid sibling tools operational;
- reconsider it on the next successful source catalog refresh, allowing automatic recovery if the upstream schema is fixed.

Failure to generate a precise TypeScript declaration does not quarantine a tool when runtime validation remains enforceable. It produces a catalog warning and a conservative type instead.

The concrete validator and type-generation libraries are implementation choices evaluated during the contract spike. Their behavior must satisfy a shared conformance corpus so replacing a library does not silently change the public contract.

## Consequences

- Runtime safety does not depend on model-authored TypeScript being correct.
- Type documentation can be helpful without pretending to encode every runtime constraint.
- Catalog construction performs schema compilation work up front, making invocation behavior predictable.
- External references are unsupported in v0.1 unless their targets are already embedded in the same schema document.
- One malformed tool cannot disable an otherwise usable upstream source.
- Source-health and startup reporting need bounded per-tool warnings in addition to connection state.
- The conformance suite needs valid, malformed, recursive-local-reference, external-reference, and TypeScript-imprecision fixtures.

## Alternatives considered

### Trust TypeScript checking as validation

Model-authored code is untrusted, TypeScript types are erased at runtime, and many JSON Schema constraints have no TypeScript equivalent.

### Resolve arbitrary external references

This supports more schemas but introduces network and filesystem authority, nondeterministic startup, and security policy outside the v0.1 scope.

### Reject the entire source when one schema fails

This is simple but violates per-tool failure isolation and needlessly removes valid sibling tools.

### Quarantine tools whose TypeScript projection is imprecise

This rejects runtime-valid tools for a documentation limitation. Falling back to `unknown` preserves safety and availability.
