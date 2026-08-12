# ADR 0020: Separate Skill Mechanics from Semantic Authorship

**Status:** Accepted
**Date:** 2026-08-12

## Context

CodeModeKit can deterministically generate a valid Agent Plugin, a companion runtime skill, and exact TypeScript declarations for the active tool catalog. It cannot infer the plugin's intended users, valuable jobs, organization-specific safety rules, ambiguity thresholds, or preferred result shapes from schemas alone.

Making the generator invent those semantics produces generic skills that restate tool inventory and Code Mode mechanics. Adding more templates cannot recover context the generator does not possess. A coding agent can inspect the surrounding repository, reason over the live catalog, and ask the user for the few consequential facts that remain missing.

## Decision

Maintain two model-invoked project development skills in the public repository and publish the same source files in `@codemodekit/skills`:

- `build-codemodekit-server` builds a walking skeleton from Local Tools or MCP sources, configures policy, and verifies the downstream MCP execution boundary.
- `author-codemode-skill` turns the generated runtime baseline into domain-aware guidance, maintains semantic Agent Plugin metadata, and evaluates real agent behavior.

The open skills CLI is the primary human-facing installation path: `npx skills add stjbrown/codemodekit` discovers both, and `--skill <name>` installs either independently. The npm package is the deterministic programmatic distribution used by the generator, which installs both under `.agents/skills` by default. They are development dependencies and are excluded from `dist/plugin`.

Ownership is explicit:

- CodeModeKit owns the complete `references/tools.d.ts`, generated per-source and tool-prefix declaration shards, `references/catalog-metadata.json`, manifest scaffolding, catalog synchronization, and `dist/plugin` construction.
- The coding agent and developer own the runtime `SKILL.md`, domain workflows, safety guidance, and worked examples.
- Catalog synchronization updates only generated catalog files and never overwrites semantic authorship.

The generated runtime skill remains usable as a mechanical baseline, but it identifies itself as incomplete for distribution. The authoring skill must establish current catalog truth, recover domain evidence locally, ask only consequential unanswered questions, map user jobs to exact tool calls and safety decisions, write progressively disclosed guidance, and evaluate observed behavior before calling the skill polished.

The skills target the open Agent Skills format and maintain Agent Plugins 1.0 package rules. Their writing discipline optimizes for predictable process: distinct invocation branches, checkable completion criteria, conditional reference loading, one source of truth, and pruning of duplicated, stale, or behavior-neutral prose.

## Consequences

- A coding agent can take CodeModeKit from package installation to a working server and useful runtime plugin without requiring the generator to understand every domain.
- Generated projects contain two focused development skills rather than one broad skill that mixes implementation and semantic authorship.
- The workspace publishes a sixth package and npm Trusted Publishing must be configured for `@codemodekit/skills` before release.
- Runtime skill quality remains dependent on available repository evidence and user input; the authoring skill must report unresolved domain assumptions rather than fabricate them.
- Skill package conformance, installation, packed contents, and generator integration become release-tested contracts.
- Compatibility with the skills CLI is tested against the local checkout before release and against GitHub after publication.

## Alternatives considered

### Expand the generated runtime template

This can improve generic mechanics but cannot infer user jobs or organization policy. More template prose also competes with the domain guidance an agent should author.

### Use one development skill for both phases

Building a server and authoring a user-facing skill have different invocation triggers, evidence, and completion criteria. Splitting them lets the server-builder hand off only after the execution surface works and keeps each skill's context focused.

### Put development guidance inside every runtime plugin

End-user agents do not need instructions for scaffolding, package builds, or editing plugin manifests. Shipping those instructions would increase runtime context and expose irrelevant maintenance behavior.
