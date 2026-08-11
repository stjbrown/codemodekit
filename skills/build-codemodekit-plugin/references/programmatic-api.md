# Programmatic API

Import the builders from `create-codemodekit`.

## Scaffold the full project

```ts
import { parseMcpCommand, scaffoldCodeModeMcp } from "create-codemodekit";

const result = await scaffoldCodeModeMcp({
  targetDirectory: "my-code-mode",
  mcpName: "upstream",
  mcpCommand: parseMcpCommand("uvx upstream-mcp"),
  agentPlugin: true,
});
```

Installation defaults to `true`. Pass `install: false` only for an intentional source-only scaffold.

`agentPlugin` also accepts configuration:

```ts
agentPlugin: {
  pluginName: "my-code-mode",
  skillName: "use-my-code-mode",
  description: "Use the upstream service through Code Mode.",
  license: "Apache-2.0",
  sync: true,
}
```

## Scaffold only plugin components

Use `scaffoldAgentPlugin` when a project already owns its server entrypoint. It writes `plugin.json`, `mcp.json`, the companion `SKILL.md`, and pending references.

## Refresh references

Call `syncAgentPluginSkill` with a started or startable CodeModeKit `CodeMode` instance. The function reads the revisioned TypeScript catalog, rejects degraded or unstable snapshots, and atomically replaces `references/tools.d.ts` and `references/catalog-metadata.json`.

Close the Code Mode application in a `finally` block after syncing.
