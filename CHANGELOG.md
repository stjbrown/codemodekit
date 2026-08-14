# Changelog

## 2026-08-14

Package versions: `codemodekit@0.5.0`, `create-codemodekit@0.6.0`, `@codemodekit/core@0.4.0`, `@codemodekit/mcp@0.3.1`, `@codemodekit/sandbox-quickjs@0.4.0`, and `@codemodekit/skills@0.2.1`.

### Security

- `serveCodeModeHttp` now validates `Host` and `Origin` headers, enabled by default on loopback binds, blocking DNS-rebinding and cross-site requests from local web pages. New `dnsRebindingProtection`, `allowedHosts`, and `allowedOrigins` options cover proxied or renamed deployments; requests without an `Origin` header (non-browser MCP clients) are unaffected.
- The `mcp.http` and `mcp.sse` source constructors now default `headerPolicy` to `same-origin`, matching the Agent Plugin loader, so configured credential headers no longer follow cross-origin redirects. Pass `headerPolicy: "all"` to restore the previous behavior.

### Fixed

- Provider results containing shared, non-circular references are no longer rejected as circular; true cycles still fail with `TOOL_RESULT_INVALID`.
- Catalog discovery now runs under the manager lifetime only, so one execution's wall-time limit or cancellation can no longer abort shared source discovery or hang `run()` past its wall limit on an unresponsive provider handshake.
- Abrupt HTTP client disconnects now cancel in-flight executions instead of letting them run to the wall limit, and multiple `Set-Cookie` headers are forwarded intact.
- Awaiting a source namespace (`await tools.someSource`) resolves immediately instead of hanging until the wall limit.
- Uncaught tool errors preserve the `SOURCE_UNAVAILABLE` and `TOOL_SCHEMA_UNSUPPORTED` diagnostic codes; the sandbox now derives its recognized-code set from the canonical `SDK_ERROR_CODES` export in `@codemodekit/core`.

### Changed

- Stdio transport `env` documentation now states the SDK-inherited minimal base environment (`PATH`, `HOME`, and similar); `env` and Agent Plugin `baseEnv` are overlays, not full isolation.
- `@codemodekit/skills` ships its Apache-2.0 LICENSE file.
- Scaffolded projects now install `codemodekit@^0.5.0`; a workspace test guards the generated version constants against future drift.

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
