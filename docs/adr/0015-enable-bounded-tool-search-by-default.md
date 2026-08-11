# ADR 0015: Enable Bounded Tool Search by Default

**Status:** Accepted  
**Date:** 2026-08-09

## Context

The Code Mode MCP surface deliberately avoids placing every upstream tool declaration in model context. Focused skills can teach common workflows and exact calls, but v0.1 also supports arbitrary consumer-configured MCP servers, changing catalogs, incomplete skill coverage, and recovery when a remembered tool name is stale.

Requiring a separate search and describe call adds latency and another model-facing tool. Returning full schemas for many matches defeats progressive disclosure. Semantic search would add embeddings, indexing dependencies, nondeterminism, and potentially external calls that are unnecessary for the first release.

## Decision

The downstream MCP adapter registers `search_tools` by default beside `run_typescript`. A consumer may explicitly disable it:

```ts
registerCodeModeTools(server, { codeMode });

// Opt out when complete, maintained skills provide all required discovery.
registerCodeModeTools(server, { codeMode, search: false });
```

The v0.1 input contract is conceptually:

```ts
interface SearchToolsInput {
  query: string; // 1–256 Unicode scalar values after trimming
  source?: string; // exact configured source name
  detail?: "summary" | "typescript"; // default: "summary"
  limit?: number; // default: 5; maximum: 8
}
```

Search behavior:

- Search only the atomically published active catalog and only tools visible to the model.
- Exclude app-only, quarantined, and currently unavailable catalog contributions.
- Apply an exact source filter without normalizing the configured name.
- Rank deterministically using exact address and tool-name matches first, then prefixes and token coverage across source name, exact tool name, description, and schema property names.
- Break ties by exact configured source name and exact tool name using a documented code-point ordering.
- Perform all indexing and search locally; do not use embeddings, network calls, or external search services.
- Update the index atomically with the catalog and include an opaque `catalogRevision` in every response.

Each result returns:

- exact address segments;
- a lossless callable expression, using bracket notation where required;
- exact source and tool names;
- a bounded description;
- in `typescript` detail mode, conservative generated input and `ToolResult<...>` declarations derived from the authoritative schema.

TypeScript detail responses also include one top-level `resultContract` containing the shared `ToolResult` declaration, concise extraction guidance, and a guarded JSON-text example. This makes bounded discovery self-contained: a bare `Promise<ToolResult<unknown>>` is not sufficient guidance when an upstream omits its output schema or nests data under `structuredContent.result`. The contract preserves the wrapper defined by ADR 0010; search guidance does not unwrap or rewrite provider results.

Summary mode permits up to eight results. TypeScript detail mode permits at most five even if a larger limit is requested. The complete response, including `resultContract`, is capped at 64 KiB; the adapter reduces the result count rather than truncating an individual declaration or the shared contract. It reports `truncated: true` and the number returned when the response bound changes the requested count.

There is no separate `describe_tool` in v0.1. `detail: "typescript"` supplies the callable declaration in the same round trip.

An exact source filter for a configured but unavailable source returns a bounded `SOURCE_UNAVAILABLE` diagnostic. An unknown source returns no matches with a safe suggestion list capped at three configured source names. Search never returns credentials, provider sideband, raw `_meta`, approval policy, or trusted diagnostics.

## Consequences

- Arbitrary upstream catalogs remain usable before bespoke skills are authored.
- The normal model-facing surface remains two tools.
- Skills still provide better workflow guidance than schema search and remain the preferred path.
- Deterministic lexical search is simpler and testable but may miss conceptual synonyms not present in metadata.
- TypeScript detail responses are larger, so both result count and total bytes are bounded.
- Catalog revisions make stale discovery diagnosable without promising persistence across process restarts.
- Consumers that want a strict skills-only surface can opt out explicitly.

## Alternatives considered

### Disable search by default

This produces the smallest surface but makes arbitrary or changing upstream sources difficult to use without pre-authored skills.

### Add separate search and describe tools

This keeps search results smaller but adds a model round trip and another top-level tool for a common recovery path.

### Use semantic vector search

This may improve conceptual recall but introduces an embedding model, index lifecycle, nondeterminism, cost, and possibly network access outside v0.1.

### Return the complete catalog

This defeats the context-efficiency goal of Code Mode.
