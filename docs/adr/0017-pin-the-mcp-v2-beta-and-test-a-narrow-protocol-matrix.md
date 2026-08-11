# ADR 0017: Pin the MCP v2 Beta and Test a Narrow Protocol Matrix

**Status:** Accepted  
**Date:** 2026-08-09

## Context

CodeModeKit needs current MCP client and server behavior before the official TypeScript SDK v2 reaches a stable release. The v2 SDK is split into client, server, core, and runtime-adapter packages, and its current releases are beta versions. Accepting a broad prerelease range would allow a dependency update to change protocol behavior or public types without a deliberate CodeModeKit release.

The current MCP TypeScript client can negotiate both the modern protocol era, beginning with `2026-07-28`, and the legacy era. It can explicitly use automatic version negotiation, probing modern MCP and falling back to legacy behavior. The SDK also retains a legacy SSE client for reaching older upstream servers, while the Code Mode registration adapter does not own or promise a downstream server transport.

Claiming conformance with every historical protocol revision would create a large test matrix without improving the primary v0.1 workflow. Conversely, merely inheriting whatever the MCP SDK happens to support would make the CodeModeKit's compatibility contract ambiguous.

## Decision

v0.1 may ship before the official MCP TypeScript SDK v2 is stable.

The implementation will:

- target Node.js 20 or later and ESM;
- use the official split v2 MCP packages;
- pin the exact MCP SDK beta version used by a published v0.1 release, initially `2.0.0-beta.5`, rather than using a caret, tilde, or open prerelease range;
- keep MCP SDK types and objects behind the provider and registration-adapter boundaries wherever practical;
- upgrade to another beta or stable v2 only through an intentional CodeModeKit change with the compatibility suite passing;
- explicitly configure upstream clients with automatic modern-to-legacy protocol negotiation rather than relying on the MCP SDK's default mode.

The guaranteed v0.1 protocol matrix is:

| Direction | Protocol or transport | Guarantee |
|---|---|---|
| Upstream | MCP `2026-07-28` over stdio | Required and tested |
| Upstream | MCP `2026-07-28` over Streamable HTTP | Required and tested |
| Upstream | MCP `2025-11-25` through legacy negotiation | Required and tested |
| Upstream | Legacy HTTP+SSE client connection | Compatibility path and tested |
| Upstream | Earlier legacy protocol revisions supported by the pinned SDK | Best effort, not individually guaranteed |
| Downstream | Registration on a consumer-owned MCP v2 server | Required and tested |
| Downstream | A particular server transport, including legacy SSE serving | Consumer-owned and not promised by this adapter |

Unknown or incompatible protocol versions fail through negotiation and produce a sanitized source-health diagnostic. They are never silently treated as the current protocol.

The exact MCP SDK version is documented in release metadata. Because Code Mode itself is still `0.x`, moving to a later beta or stable MCP SDK may require a Code Mode minor release, but will not occur invisibly inside an existing published version.

## Consequences

- Work on v0.1 is not blocked by the upstream SDK's prerelease status.
- Builds and conformance results are reproducible against one known MCP SDK version.
- Consumers may need to align the MCP server package used by their application with the version supported by the Code Mode adapter.
- The compatibility suite, rather than incidental transitive behavior, defines what the SDK promises.
- Earlier MCP servers may work through the official SDK but do not become permanent compatibility obligations without explicit tests.
- A later stable MCP v2 release requires a deliberate dependency update and may justify a new Code Mode minor release.

## Alternatives considered

### Wait for a stable MCP TypeScript SDK v2

This would reduce prerelease dependency risk but unnecessarily block a Code Mode `0.x` release and early integration feedback.

### Accept a broad v2 beta range

This is convenient for dependency updates but lets prerelease changes alter protocol behavior without a CodeModeKit release or compatibility run.

### Guarantee every legacy MCP revision

The official client may support them, but making each revision contractual would expand the v0.1 test matrix substantially. Older revisions remain best-effort until demand justifies adding them to the guaranteed matrix.

### Own downstream transport hosting

The Code Mode adapter registers tools on a consumer-owned MCP server. Taking ownership of its transport would reduce composability with the consumer's direct tools, Apps, and other protocol-native surfaces.
