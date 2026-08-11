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

Installation and the project authoring skill default to enabled. Pass `install: false` or `authoringSkill: false` only when intentionally deferring those steps.

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

Use `buildAgentPlugin` to create the dependency-free `dist/plugin` artifact. Use `installCursorPlugin`, `getCursorPluginStatus`, and `uninstallCursorPlugin` for Cursor's concrete local copy.

Use `installProjectAuthoringSkill` to add the bundled development-time skill to an existing project at `.agents/skills/build-codemodekit-plugin`.

## Refresh references

Call `syncAgentPluginSkill` with a started or startable CodeModeKit `CodeMode` instance. The function reads the revisioned TypeScript catalog, rejects degraded or unstable snapshots, and atomically replaces `references/tools.d.ts` and `references/catalog-metadata.json`.

Close the Code Mode application in a `finally` block after syncing.

## Observe execution

The high- and low-level constructors accept an `observer` callback. Use it for metrics, tracing, and audit correlation. Events contain IDs, source/tool names, byte counts, durations, outcomes, and stable error codes; they intentionally exclude authored code, arguments, results, logs, and diagnostic messages. Keep payload logging as a separate, explicit host decision.
