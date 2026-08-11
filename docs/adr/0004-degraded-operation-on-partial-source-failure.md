# ADR 0004: Continue Operating and Reconnect after Source Failure

**Status:** Accepted  
**Date:** 2026-08-09

## Context

A Code Mode server aggregates independently operated upstream MCP servers. Requiring every source to be healthy would make the combined server less available than any individual dependency. Agent Plugins also specifies narrow per-server failure isolation.

Consumers and operators still need explicit evidence that the catalog is incomplete. Silently omitting a failed source would make generated code and skill documentation fail in confusing ways.

## Decision

When some upstream sources fail to validate, start, connect, authenticate, or complete protocol negotiation, `CodeMode` continues operating with healthy sources in a degraded state. If every source is initially unavailable, the Code Mode server still starts in a degraded state so it can recover without a process restart.

Startup produces a structured report containing a sanitized status for every configured source. The exact startup method name remains part of the public API design, but the report distinguishes at least healthy and unavailable sources and makes the overall degraded state explicit.

The active catalog contains tools discovered from healthy sources. The configured source identity is retained even while unavailable so a call addressed to that namespace can fail deterministically with `SOURCE_UNAVAILABLE` and the source name. Unrelated tool calls continue normally.

The SDK reconnects each unavailable source independently in the background using bounded exponential backoff with jitter. Exact default delays and configuration limits remain implementation details until testing. Stopping `CodeMode` cancels pending reconnect attempts.

After a successful reconnect and tool discovery, the SDK atomically replaces that source's catalog contribution and marks the source healthy. Other source contributions are unchanged.

A failed tool invocation is never replayed automatically. The tool may have completed its side effect before the connection failed, so transparent replay could duplicate an operation. Reconnection only restores availability for later calls.

## Consequences

- Readiness is not a single boolean; the SDK exposes overall and per-source state.
- Startup and runtime diagnostics must be sanitized and must not leak credentials or unsafe subprocess details.
- Catalog and documentation consumers must be able to distinguish configured sources from currently available tools.
- Tests must prove that one failed source does not block discovery or invocation through healthy sources.
- The bridge needs a stable `SOURCE_UNAVAILABLE` error independent of the underlying transport failure.
- The source lifecycle needs explicit connecting, healthy, unavailable, and stopped states.
- Retry scheduling is per source and must avoid synchronized reconnect storms.
- Catalog replacement must be atomic at the source boundary.
- Callers, not the SDK, decide whether an individual failed tool invocation is safe to retry.
- Future local and OpenAPI providers inherit the same source-level isolation model.

## Alternatives considered

### Fail startup when any source fails

This is simple and strict but unnecessarily disables unrelated tools and conflicts with Agent Plugins' per-server failure isolation.

### Silently omit failed sources

This preserves availability but hides an important operational condition and produces confusing missing-property failures inside model-authored code.

### Fail startup when every source is unavailable

This provides a strict readiness signal but forces an external process restart to recover from temporary dependency outages.

### Replay failed tool calls after reconnecting

This may appear seamless but can duplicate non-idempotent external effects when the upstream completed a call before the connection failure became visible.
