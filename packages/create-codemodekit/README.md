# create-codemodekit

Scaffold a runnable, one-file Code Mode MCP server from an upstream MCP command.

```sh
npm create codemodekit@latest my-code-mode -- \
  --mcp-name upstream \
  --mcp-command 'uvx my-mcp-server'

cd my-code-mode
npm start
```

The command is parsed directly into an executable and argument array. Shell operators, shell expansion, and leading environment assignments are rejected; no shell is invoked. Dependency installation is automatic unless `--no-install` is supplied. A project-level CodeModeKit authoring skill is installed at `.agents/skills/build-codemodekit-plugin` by default; use `--no-authoring-skill` to omit it.

Generated servers use `--policy allow-all` by default so the project runs immediately. Use `--policy deny-all` when you want the generated server to start closed while you define a narrower tool policy.

## Generate an Agent Plugin

Add `--agent-plugin` to create a portable Agent Plugins 1.0 package around the Code Mode server:

```sh
npm create codemodekit@latest my-code-mode -- \
  --mcp-name upstream \
  --mcp-command 'uvx my-mcp-server' \
  --agent-plugin
```

This adds root `plugin.json` and `mcp.json` files plus `skills/use-upstream-codemode/`. The companion skill teaches a runtime agent to compose calls through `run_typescript`; its `references/tools.d.ts` is generated from CodeModeKit's live normalized catalog. After installation, the generator also builds a self-contained `dist/plugin` artifact containing the server bundle, QuickJS WASM, manifests, and runtime skill.

The generator attempts catalog sync after dependency installation. If the upstream MCP still needs credentials or connectivity, the project remains valid with pending references. Configure the source and run:

```sh
npm run plugin:sync
npm run plugin:build
```

Use `--no-sync` to skip the initial attempt intentionally. The artifact deliberately excludes `node_modules`, `.env`, source files, and the development-time authoring skill.

## Cursor lifecycle

Cursor currently requires concrete executable and server paths for local plugins. The generated commands handle that adapter without changing the portable artifact:

```sh
npm run plugin:install:cursor
npm run plugin:status:cursor
npm run plugin:uninstall:cursor
```

Installation rebuilds first, copies the artifact beneath `~/.cursor/plugins/local`, resolves the active Node executable, and reports that Cursor should be reloaded. Reinstall after source, policy, metadata, or catalog changes.

## Plugin metadata

Use `--plugin-name`, `--skill-name`, `--plugin-description`, and `--plugin-license` with `--agent-plugin` to override the portable defaults.

Programmatic consumers can call `scaffoldCodeModeMcp`, `scaffoldAgentPlugin`, `syncAgentPluginSkill`, `buildAgentPlugin`, `installProjectAuthoringSkill`, and the Cursor lifecycle functions directly.
