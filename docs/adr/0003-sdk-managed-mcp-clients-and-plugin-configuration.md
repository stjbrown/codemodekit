# ADR 0003: Manage MCP Clients from Direct or Agent Plugin Configuration

**Status:** Accepted  
**Date:** 2026-08-09

## Context

CodeModeKit must aggregate multiple upstream MCP servers without requiring consumers to construct and coordinate low-level MCP clients themselves. Consumers need a simple declarative configuration surface.

Agent Plugins 1.0 provides a portable package format with `mcp.json` for upstream MCP server configuration and a sibling `skills/` component. Supporting that package format avoids inventing another required configuration file and preserves a path to plugin-supplied skill discovery later.

As of MCP 2026-07-28, the standard transports are stdio and Streamable HTTP. The official TypeScript SDK v2 also provides a legacy SSE client for backwards compatibility. Agent Plugins 1.0 represents stdio, `streamable-http`, and legacy `sse` entries.

## Decision

The SDK constructs an official MCP TypeScript SDK `Client` for every configured upstream server. It owns initial connection, protocol negotiation, tool discovery, and orderly close behavior. Reconnection policy remains a follow-up decision.

Upstream configuration has two public entry paths:

1. Direct consumer configuration using the SDK's typed TypeScript API.
2. The local filesystem root of an already-installed Agent Plugins 1.0 package whose `mcp.json` is validated and mapped into the same internal source configuration.

v0.1 does not discover, download, install, resolve dependencies for, or update Agent Plugin packages. Distribution and installation remain the consumer's responsibility.

The transport compatibility boundary is:

- stdio: required and first-class;
- Streamable HTTP: required and first-class;
- legacy HTTP+SSE: supported for backwards compatibility and Agent Plugin entries;
- custom transports: not promised by the declarative configuration contract; a future transport-factory escape hatch may be considered separately.

Agent Plugin loading follows the specification's narrow failure boundaries: a top-level invalid `mcp.json` disables MCP loading for that plugin, while an invalid or unavailable individual server does not disable valid siblings or other plugin components.

The plugin remains a first-class loaded object internally. v0.1 consumes its MCP configuration; a future iteration may expose its discovered Agent Skills without redesigning plugin loading.

## Consequences

- Consumers configure upstreams but do not manually create MCP clients.
- Consumers install Agent Plugins and pass their local root paths to the SDK.
- The SDK needs explicit startup, readiness, partial-failure reporting, and close semantics.
- stdio process launch and plugin path handling become part of the SDK's security surface.
- Agent Plugin variable expansion, filesystem containment, literal-header rules, and per-entry validation must be implemented or delegated to a conformant loader.
- Authentication cannot be taken from Agent Plugin headers as secrets; Agent Plugins leaves authorization and credentials to the client.
- Direct and plugin configuration must normalize into the same internal model and pass the same provider conformance tests.
- Skill loading is not part of v0.1 behavior, but the design retains plugin identity and paths for later use.

## Alternatives considered

### Require consumers to pass connected MCP clients

This maximizes lifecycle flexibility but makes the primary SDK workflow unnecessarily complex and duplicates coordination logic across consumers.

### Support only SDK-native configuration

This is simpler initially but creates a proprietary configuration island and loses the natural link between a plugin's MCP servers and its future skills.

### Flatten Agent Plugin `mcp.json` immediately

This can configure clients but discards plugin identity and makes later skill discovery harder to add coherently.

### Discover and install Agent Plugins inside the SDK

This would broaden a runtime SDK into a package manager and introduce distribution, trust, update, and dependency policies unrelated to executing Code Mode.
