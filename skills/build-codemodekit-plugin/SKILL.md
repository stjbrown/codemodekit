---
name: build-codemodekit-plugin
description: Scaffold, retrofit, or maintain CodeModeKit servers and portable Agent Plugins with companion runtime skills. Use when creating a Code Mode MCP wrapper from an MCP command, adding Agent Plugins 1.0 packaging, refreshing generated tool TypeScript, configuring tool policy, or diagnosing a generated CodeModeKit project.
---

# Build a CodeModeKit Plugin

Prefer CodeModeKit's generator and programmatic builders over hand-writing manifests or generated tool declarations.

## Create a new project

1. Identify a short source name and a shell-free MCP executable plus arguments.
2. Run:

   ```sh
   npm create codemodekit@latest <directory> -- \
     --mcp-name <source-name> \
     --mcp-command '<executable> [args...]' \
     --agent-plugin
   ```

3. Inspect `src/server.mjs`, `plugin.json`, `mcp.json`, and the generated skill before changing defaults.
4. Keep credentials outside committed files. Pass an env-file argument to the upstream executable when it supports one; do not embed secrets in `mcp.json`.
5. Run `npm run plugin:sync` after credentials and the upstream MCP are available.
6. Test `npm start` through an MCP client and confirm both `run_typescript` and `search_tools` are advertised.

Read [references/generator.md](references/generator.md) for flags and policy behavior.

## Update an existing project

Preserve the one-file server unless the integration genuinely needs more structure. Use `scaffoldAgentPlugin` for portable manifests and the companion skill, and use `syncAgentPluginSkill` with the project's `CodeMode` instance to refresh catalog-derived references. Never hand-edit `tools.d.ts`; it is generated output.

Read [references/programmatic-api.md](references/programmatic-api.md) for the builder contracts and [references/plugin-layout.md](references/plugin-layout.md) for generated-file ownership.

## Validate

- Treat a failed dependency install as a generator failure; do not report the project as ready.
- Treat a failed catalog sync as recoverable when the upstream MCP merely needs credentials or connectivity. Keep the pending references and report the exact `npm run plugin:sync` follow-up.
- Reject partial snapshots when any source is unavailable.
- Keep `SKILL.md` procedural and compact. Put generated schemas, TypeScript declarations, result semantics, and examples in `references/`.
- Tell runtime agents to search large declaration references for focused matches instead of loading an entire catalog into context.
- Preserve `search_tools` as a live fallback for pending, stale, or dynamic catalogs.
