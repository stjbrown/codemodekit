# Generator and lifecycle

## New weather Local Tools project

```sh
npm create codemodekit@latest
```

The noninteractive equivalent is:

```sh
npm create codemodekit@latest weather-code-mode -- --example weather
```

## Wrap a stdio MCP server

```sh
npm create codemodekit@latest my-code-mode -- \
  --mcp-name upstream \
  --mcp-command 'uvx upstream-mcp' \
  --agent-plugin
```

The command is parsed into one executable and an argument array. Do not pass pipes, redirection, command substitution, or leading environment assignments.

## Wrap a remote MCP server

```sh
npm create codemodekit@latest my-code-mode -- \
  --mcp-name upstream \
  --mcp-url https://example.com/mcp \
  --mcp-bearer-env UPSTREAM_TOKEN \
  --agent-plugin
```

Use `--mcp-header-env Header-Name=ENV_NAME` for custom headers. Credential values remain in the host environment; the generated `.env.example` lists names but does not load them automatically.

## Combine sources

Repeat a complete source group. Each `--mcp-name` becomes one namespace beneath `tools`:

```sh
npm create codemodekit@latest work-code-mode -- \
  --mcp-name issues --mcp-command 'uvx issues-mcp' \
  --mcp-name knowledge --mcp-url https://example.com/mcp \
  --mcp-bearer-env KNOWLEDGE_TOKEN \
  --agent-plugin
```

## Useful options

- `--policy deny-all`: scaffold closed while a narrower policy is implemented.
- `--no-install`: write files without installing dependencies.
- `--no-sync`: defer live catalog capture when credentials or connectivity are not ready.
- `--no-agent-plugin`: omit portable plugin packaging.
- `--plugin-name`, `--skill-name`, `--plugin-description`, `--plugin-license`: override portable metadata.
- `--no-authoring-skill`: omit both project development skills.

## Generated project lifecycle

```sh
npm start
npm run verify
npm run plugin:sync
npm run plugin:build
npm run plugin:install:cursor
npm run plugin:status:cursor
npm run plugin:uninstall:cursor
```

`npm run verify` checks the downstream Code Mode surface and sandbox without invoking provider tools. For one semantic live-provider assertion, set `CODEMODEKIT_VERIFY_CODE_FILE` to bounded TypeScript that returns `{ verified: true }`.

Catalog sync owns `references/tools.d.ts`, every generated `references/tools.*.d.ts` shard, and `references/catalog-metadata.json`. It stages the complete file set before replacing the prior snapshot. Plugin build owns `dist/plugin`. The developer or `$author-codemode-skill` owns the runtime `SKILL.md`, domain workflows, and examples.
