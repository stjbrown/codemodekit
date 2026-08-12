# Changelog

## 2026-08-12

Package versions: `codemodekit@0.4.0`, `create-codemodekit@0.5.0`, `@codemodekit/core@0.3.0`, `@codemodekit/mcp@0.3.0`, `@codemodekit/sandbox-quickjs@0.3.0`, and `@codemodekit/skills@0.2.0`.

### Added

- Native multi-source project scaffolding through `sources` and repeated CLI source groups.
- Host-environment bearer-token and custom-header configuration for generated Streamable HTTP MCP sources.
- Generated `npm run verify` checks, with an optional semantic live-provider composition.
- Complete, per-source, and bounded tool-prefix TypeScript declaration files with collision-safe filenames and transactional catalog commits.
- A packed-package canary covering 306 prefixed tools from one MCP source.

### Changed

- Generated runtime skills and downstream tool descriptions now treat synchronized declarations as primary discovery and `search_tools` as a fallback.
- Runtime guidance explicitly asks authored code to project requested fields, cap collections, summarize large results, and avoid returning raw provider payloads.
- QuickJS teardown now disposes unresolved deferred host calls; repeated debug-runtime timeout coverage guards the lifecycle.

### Compatibility

- Existing singular `source` and legacy `mcpName`/`mcpCommand` generator inputs remain supported.
- Agent Plugin catalog metadata advances to schema version 2 and indexes every generated declaration file. Refresh existing generated plugins with `npm run plugin:sync`.
