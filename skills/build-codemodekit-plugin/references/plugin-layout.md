# Generated plugin layout

```text
my-code-mode/
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
- CodeModeKit owns generated `tools.d.ts` and `catalog-metadata.json`.
- The generated `SKILL.md` contains stable runtime procedure and should stay small.
- `runtime.md`, `result-contract.md`, and `examples.md` are scaffolded reference templates and may be tailored when an integration needs additional guidance.

`mcp.json` exposes the generated Code Mode server to an Agent Plugins client. The upstream MCP remains configured inside `src/server.mjs`; it is not exposed as a second direct server that would bypass Code Mode policy and sandboxing.
