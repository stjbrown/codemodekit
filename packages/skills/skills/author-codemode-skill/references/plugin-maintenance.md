# Agent Plugin maintenance

Target the current Agent Plugins schema already declared by the project. For Agent Plugins 1.0:

- `plugin.json` is required at the plugin root.
- Skills are immediate child directories of `skills/`, each with a conforming `SKILL.md` whose name matches its directory.
- `mcp.json` is the only portable MCP configuration location.
- `plugin.json` and `mcp.json` must target the same specification version.
- Package-owned paths must stay inside the plugin root.
- stdio `command` is one bare executable or plugin-relative token; arguments remain separate.
- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are supported only in the fields defined by the specification.
- Portable `env` and HTTP headers are visible package data, not secret storage.

## What to edit

Update `plugin.json` description and keywords when the plugin's user-facing purpose becomes more specific. Preserve its name unless the user intends an identity change. Use Semantic Versioning: workflow additions are normally minor; corrections are patch; removing or incompatibly changing a promised workflow is major.

Edit `mcp.json` only when the server connection itself changes. Runtime-skill improvements do not require an MCP configuration change.

Do not add portable manifest fields outside the closed schema. Client-specific behavior belongs under a reverse-domain extension namespace and should be added only for a client the user explicitly targets.

## Build boundary

`npm run plugin:build` recreates `dist/plugin`. Never hand-edit the artifact. Verify it contains root manifests, the bundled server, QuickJS WASM, and runtime skills. It must exclude `.env`, source files, `node_modules`, and `.agents/skills` development guidance.

Cursor uses a concrete installed copy rather than the portable `${PLUGIN_ROOT}` configuration. Re-run `npm run plugin:install:cursor` and reload Cursor after rebuilding for local testing.
