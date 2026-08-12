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
npm run plugin:sync
npm run plugin:build
npm run plugin:install:cursor
npm run plugin:status:cursor
npm run plugin:uninstall:cursor
```

Catalog sync owns `references/tools.d.ts` and `references/catalog-metadata.json`. Plugin build owns `dist/plugin`. The developer or `$author-codemode-skill` owns the runtime `SKILL.md`, domain workflows, and examples.
