---
name: author-codemode-skill
description: Author, refine, or evaluate the domain-aware runtime Agent Skill inside a CodeModeKit Agent Plugin. Use after a Code Mode MCP server is scaffolded or its catalog changes, when generated skill guidance is too generic, when adding user workflows and exact multi-tool examples, when defining safe write behavior and result expectations, or when updating plugin.json, skill references, catalog sync, build, and release metadata for an Agent Plugins package.
---

# Author a Code Mode Skill

Turn a mechanically valid CodeModeKit plugin into a useful domain product. The catalog explains what calls exist; infer how people should use them from repository evidence and the user, never from tool names alone.

## 1. Establish current truth

1. Locate `plugin.json`, `mcp.json`, `src/server.mjs`, `package.json`, and every immediate `skills/*/SKILL.md`.
2. Run `npm run plugin:sync` when the configured sources are available. If it fails, preserve the current generated files and report the connectivity or credential blocker.
3. Read `references/catalog-metadata.json` and search focused sections of `references/tools.d.ts`. Never edit either file; CodeModeKit owns them.
4. Inspect project documentation, tests, source configuration, tool descriptions, policy, and existing examples for domain evidence.
5. Read [references/discovery.md](references/discovery.md) and create a concise authoring brief. Ask the user only for high-impact facts that cannot be recovered locally. Do not invent organization policy, approval boundaries, or intended users.

Current truth is established when every configured source and runtime skill is accounted for, generated catalog status is known, and the brief separates evidence from unanswered consequential questions.

## 2. Design around jobs, not inventory

Choose the few user jobs that justify activating this skill. For each one, identify:

- the user intent and expected answer or artifact;
- the exact source tools and required sequence;
- which calls are independent versus dependent;
- ambiguity that requires clarification;
- write, destructive, external-communication, or privacy risk;
- the smallest useful final value; and
- common failure and recovery behavior.

Read [references/runtime-skill-design.md](references/runtime-skill-design.md) before editing. A good runtime skill teaches decisions and workflows that cannot be derived from `tools.d.ts`; it does not restate the whole catalog.

Design is complete when each selected job maps to exact current tools, a result contract, its ambiguity and safety decisions, and a checkable completion condition.

## 3. Author the runtime package

Edit the companion runtime skill under `skills/<name>/`:

- Rewrite `SKILL.md` with a specific trigger description and compact workflow routing.
- Preserve the stable Code Mode execution rules or link to `references/runtime.md` and `references/result-contract.md`.
- Replace generic `references/examples.md` with real, type-correct compositions for the selected jobs.
- Add focused references such as `workflows.md`, `domain-rules.md`, or `write-safety.md` only when each has a clear loading condition from `SKILL.md`.
- Delete obsolete agent-authored references. Do not add README, changelog, or process-history files inside the skill.
- Keep references one level below `SKILL.md` and use relative links.

Update the root Agent Plugin when the semantic product changed. Read [references/plugin-maintenance.md](references/plugin-maintenance.md) before editing `plugin.json`, `mcp.json`, or the plugin version.

Authorship is complete when every line in `SKILL.md` changes runtime behavior, every context pointer says when to load its target, and each meaning has one source of truth.

## 4. Evaluate behavior

Use [references/evaluation.md](references/evaluation.md) to create realistic should-trigger, should-not-trigger, read, composition, ambiguity, failure, and write-safety cases. Test the skill through an agent with the built plugin when available; do not judge it only by reading Markdown.

Run the project checks, then:

```sh
npm run plugin:sync
npm run plugin:build
```

Re-read the built `dist/plugin/skills/<name>/SKILL.md` and references. Confirm the build contains the authored files and current generated catalog but no secrets or development-only authoring skills.

Evaluation is complete when every minimum case has an observed result and each failed assertion is either fixed or recorded as a specific remaining limitation.

## Quality gate

Do not report the runtime skill as polished unless:

- its description names concrete triggering requests and avoids claiming unrelated tasks;
- every documented tool call exists in the current `tools.d.ts` and matches its input shape;
- examples return bounded user-relevant values rather than raw provider payloads;
- write workflows state when to clarify, preview, confirm, or stop based on the user's actual policy;
- live `search_tools` remains the recovery path for stale or dynamic catalogs;
- plugin and MCP manifests still target the same Agent Plugins version; and
- at least one realistic evaluation demonstrates a multi-tool Code Mode advantage.
