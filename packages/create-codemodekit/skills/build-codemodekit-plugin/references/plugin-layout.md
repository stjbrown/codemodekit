# Generated plugin layout

```text
my-code-mode/
├── .agents/skills/build-codemodekit-plugin/
├── dist/plugin/
│   ├── emscripten-module.wasm
│   ├── mcp.json
│   ├── plugin.json
│   ├── server.mjs
│   └── skills/
├── package.json
├── plugin.json
├── mcp.json
├── src/
│   └── server.mjs
└── skills/
    └── use-upstream-codemode/
        ├── SKILL.md
        └── references/
            ├── catalog-metadata.json
            ├── examples.md
            ├── result-contract.md
            ├── runtime.md
            └── tools.d.ts
```

## Ownership

- The developer owns `src/server.mjs`, tool policy, provider configuration, and plugin metadata.
- CodeModeKit owns generated `tools.d.ts`, `catalog-metadata.json`, and `dist/plugin`.
- The generated runtime `SKILL.md` contains stable procedure and should stay small.
- `runtime.md`, `result-contract.md`, and `examples.md` are scaffolded reference templates and may be tailored when an integration needs additional guidance.
- `.agents/skills/build-codemodekit-plugin` is development-time authoring guidance and is intentionally excluded from the portable plugin artifact.

`mcp.json` exposes the bundled Code Mode server to an Agent Plugins client. The upstream MCP remains configured inside `src/server.mjs`; it is not exposed as a second direct server that would bypass Code Mode policy and sandboxing.

The portable `dist/plugin/mcp.json` uses `${PLUGIN_ROOT}` as required by Agent Plugins. Cursor installation produces a separate concrete copy because Cursor currently needs absolute executable and server paths for local plugins.
