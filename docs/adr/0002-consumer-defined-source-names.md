# ADR 0002: Use Configured Source Names as Tool Namespaces

**Status:** Accepted  
**Date:** 2026-08-09

## Context

Multiple upstream MCP servers may expose tools with identical names. Future local-function and OpenAPI sources introduce the same collision risk. The sandbox API therefore needs a stable source-level namespace.

An upstream MCP server's reported name is not sufficient because it may be absent, duplicated, or changed by the server. Agent Plugin `mcpServers` keys provide a portable configured identity, but they are not constrained to valid TypeScript identifiers. The public configuration should preserve those names while still using familiar terminology.

## Decision

Every configured tool source has a required public `name`. Direct configuration supplies it explicitly:

```ts
new McpToolProvider({
  name: "github",
  // connection configuration
});
```

That name becomes the top-level sandbox namespace:

```ts
await tools.github.searchIssues({ query: "is:open" });
```

For an Agent Plugin source, the `mcpServers` member key is the configured source name. The public term is `name`, not `alias`. A source name must be unique within one `CodeMode` instance. Duplicate names fail during configuration rather than during execution.

Names are preserved exactly; the SDK does not silently sanitize, camel-case, or otherwise rewrite them. A name that is a valid TypeScript identifier can use dot notation. Every name can use bracket notation:

```ts
await tools.github.searchIssues({ query: "is:open" });
await tools["deployment-api"].deploy({ environment: "production" });
```

The same lossless property-access rule applies to downstream tool-name segments when needed.

The SDK keeps separate concepts for:

- `source.name`: the configured stable public namespace;
- `serverInfo.name`: the name reported by an upstream MCP server;
- `sourceId`: an optional opaque internal identity if one is needed.

Provider type does not appear in the sandbox address. The same convention will support MCP, local-function, and OpenAPI sources.

## Consequences

- Cross-source tool-name collisions are resolved by construction.
- Renaming a configured source is a breaking change for generated TypeScript and skill documentation.
- Upstream server rebranding or metadata changes do not affect the model-facing API.
- Generated references must use the configured source name.
- Generated references use dot notation where valid and bracket notation otherwise.
- The SDK must validate uniqueness before accepting executions.
- Normalized tool addresses retain string segments rather than deriving identity from generated JavaScript syntax.

## Alternatives considered

### Call the public field `alias`

This emphasizes that it can differ from upstream metadata, but it adds terminology without improving the consumer experience.

### Use the upstream server-reported name

This requires less configuration but is not guaranteed to be unique, stable, or TypeScript-safe.

### Flatten all tool names

This produces shorter calls but makes collisions unavoidable across multiple sources.

### Normalize names into TypeScript identifiers

Transforming names such as `deployment-api` into `deploymentApi` makes dot notation convenient but creates hidden renames and possible normalization collisions. Consumers can explicitly choose a different direct-configuration name when they want that API.
