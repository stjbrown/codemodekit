# create-codemodekit

Scaffold a runnable, one-file Code Mode MCP server from an upstream MCP command.

```sh
npm create codemodekit@latest my-code-mode -- \
  --mcp-name upstream \
  --mcp-command 'uvx my-mcp-server'

cd my-code-mode
npm start
```

The command is parsed directly into an executable and argument array. Shell operators, shell expansion, and leading environment assignments are rejected; no shell is invoked. Dependency installation is automatic unless `--no-install` is supplied.

Generated servers use `--policy allow-all` by default so the project runs immediately. Use `--policy deny-all` when you want the generated server to start closed while you define a narrower tool policy.

## Generate an Agent Plugin

Add `--agent-plugin` to create a portable Agent Plugins 1.0 package around the Code Mode server:

```sh
npm create codemodekit@latest my-code-mode -- \
  --mcp-name upstream \
  --mcp-command 'uvx my-mcp-server' \
  --agent-plugin
```

This adds root `plugin.json` and `mcp.json` files plus `skills/use-upstream-codemode/`. The companion skill teaches an agent to compose calls through `run_typescript`; its `references/tools.d.ts` is generated from CodeModeKit's live normalized catalog.

The generator attempts catalog sync after dependency installation. If the upstream MCP still needs credentials or connectivity, the project remains valid with pending references. Configure the source and run:

```sh
npm run plugin:sync
```

Use `--no-sync` to skip the initial attempt intentionally. Programmatic consumers can call `scaffoldAgentPlugin` and `syncAgentPluginSkill` directly.
