# create-codemodekit

Scaffold a runnable, one-file Code Mode MCP server from Local Tools, an upstream MCP command, or a remote MCP URL.

## Build with a coding agent

Install CodeModeKit's development skills, then ask your agent to build the server:

```sh
npx skills add stjbrown/codemodekit
```

The skills can also be installed separately with `--skill build-codemodekit-server` or `--skill author-codemode-skill`. The generator below installs both automatically, so this step is for existing projects or a skill-first workflow.

## Interactive weather starter

```sh
npm create codemodekit@latest
```

The default creates an editable Open-Meteo weather project, companion skill, and portable Agent Plugin. The equivalent non-interactive command is:

```sh
npm create codemodekit@latest weather-code-mode -- --example weather
```

The generated server uses two Local Tools—`findLocation` and `getCurrentWeather`—to demonstrate multi-call composition inside one `run_typescript` execution. No API key is required for Open-Meteo's limited non-commercial endpoint. Use the generated `.env.example` for customer or self-hosted endpoints.

## Wrap an MCP command

```sh
npm create codemodekit@latest my-code-mode -- \
  --mcp-name upstream \
  --mcp-command 'uvx my-mcp-server'

cd my-code-mode
npm run verify
npm start
```

The command is parsed directly into an executable and argument array. Shell operators, shell expansion, and leading environment assignments are rejected; no shell is invoked. Dependency installation is automatic unless `--no-install` is supplied. The `build-codemodekit-server` and `author-codemode-skill` development skills are installed under `.agents/skills` by default; use `--no-authoring-skill` to omit both.

Generated servers use `--policy allow-all` by default so the project runs immediately. Use `--policy deny-all` when you want the generated server to start closed while you define a narrower tool policy.

Use `--mcp-url https://example.com/mcp` instead of `--mcp-command` for a Streamable HTTP source. Add `--mcp-bearer-env MCP_TOKEN` or repeat `--mcp-header-env Header-Name=ENV_NAME` to assemble authentication headers from the host environment without writing credential values to source, manifests, or plugin artifacts.

Repeat a complete source group to combine MCPs in one generated catalog:

```sh
npm create codemodekit@latest work-code-mode -- \
  --mcp-name github --mcp-command 'docker run -i --rm ghcr.io/github/github-mcp-server' \
  --mcp-name tickets --mcp-url https://tickets.example.com/mcp \
  --mcp-bearer-env TICKETS_TOKEN
```

Every scaffold includes `npm run verify`. It validates source discovery, the two-tool downstream surface, invalid calls, and sandbox isolation without calling provider tools. For a semantic live check, set `CODEMODEKIT_VERIFY_CODE_FILE` to a bounded TypeScript composition that returns `{ verified: true }`. The generated `.env.example` is documentation; export its variables with your preferred environment manager.

## Generate an Agent Plugin

Add `--agent-plugin` to create a portable Agent Plugins 1.0 package around the Code Mode server:

```sh
npm create codemodekit@latest my-code-mode -- \
  --mcp-name upstream \
  --mcp-command 'uvx my-mcp-server' \
  --agent-plugin
```

This adds root `plugin.json` and `mcp.json` files plus `skills/use-upstream-codemode/`. The generated companion skill is a mechanically correct runtime baseline. Catalog sync writes a complete `references/tools.d.ts`, one file per source, and bounded tool-prefix shards for large sources; `catalog-metadata.json` indexes the set. Use the installed `author-codemode-skill` to add domain triggers, real workflows, safety decisions, and type-correct compositions. After installation, the generator builds a self-contained `dist/plugin` artifact containing the server bundle, QuickJS WASM, manifests, and runtime skill.

The generator attempts catalog sync after dependency installation. If the upstream MCP still needs credentials or connectivity, the project remains valid with pending references. Configure the source and run:

```sh
npm run plugin:sync
npm run plugin:build
```

Use `--no-sync` to skip the initial attempt intentionally. The artifact deliberately excludes `node_modules`, `.env`, source files, and both development-time authoring skills.

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

Programmatic consumers can call `scaffoldCodeModeMcp`, `scaffoldAgentPlugin`, `syncAgentPluginSkill`, `buildAgentPlugin`, `installProjectAuthoringSkills`, and the Cursor lifecycle functions directly. The singular `installProjectAuthoringSkill` remains available for compatibility.
