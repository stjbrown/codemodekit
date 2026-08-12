# Runtime skill design

## Optimize for predictability

A runtime skill should make the agent follow a predictable process while allowing the answer to vary with the request and tool results.

- Front-load the description with the domain action users will actually request.
- Give each genuine invocation branch one trigger. Collapse synonyms that merely rename the same branch.
- Keep steps required on every run in `SKILL.md`. End each step with a condition the agent can verify before moving on.
- Move branch-specific rules and examples behind context pointers that state exactly when to read them.
- Co-locate a concept's rule, exception, and caveat instead of scattering them.
- Keep one source of truth for each behavior. Generated types define call shapes; domain references define domain rules; do not duplicate either in the body.
- Prune lines that merely tell a capable agent to be helpful, careful, or thorough. Remove stale instructions rather than layering corrections over them.

## Separate generated and authored truth

CodeModeKit owns:

- `references/tools.d.ts` and every generated `references/tools.*.d.ts` shard;
- `references/catalog-metadata.json`; and
- `dist/plugin`.

The skill author owns:

- the runtime `SKILL.md`;
- domain workflows and rules;
- worked examples; and
- routing to focused references.

`npm run plugin:sync` updates generated catalog files only. `npm run plugin:build` packages both generated and authored files.

## Description

Write the description for activation. Include what the skill enables and concrete request classes that should trigger it. Use domain language users will say. Avoid generic phrases such as “use upstream tools,” which collide with other skills and fail to disclose actual value.

## Body

Keep `SKILL.md` procedural and compact:

1. state the primary interface (`run_typescript`);
2. route the agent among the supported jobs;
3. specify critical clarification and safety decisions;
4. link to exact references with a condition for reading each; and
5. define the completion standard.

Do not paste the entire catalog into the body. Use `catalog-metadata.json` to select the narrowest prefix or source shard, then search it for exact names and shapes. Preserve `search_tools` as the live recovery path when declarations are pending, stale, or incomplete.

## Code Mode examples

Every example must compile as the body of an async function:

```ts
const first = await tools.source.firstTool({ query: "value" });
const second = await tools.source.secondTool({
  id: first.structuredContent.id,
});
return {
  name: first.structuredContent.name,
  status: second.structuredContent.status,
};
```

- Use exact names and schemas from the generated declaration shards.
- Prefer `structuredContent`; inspect text content defensively only when the provider lacks structured output.
- Use `Promise.all` only for independent calls.
- Pass the smallest necessary data between calls.
- Filter, join, aggregate, and reshape in the sandbox.
- Project only requested fields, omit empty metadata, and cap returned collections. Use counts or summaries when a full result set is not necessary.
- Catch a tool error only when the workflow can recover or add a useful bounded outcome.

## Write workflows

Document writes separately from reads. Base preview, clarification, confirmation, and execution rules on the user's policy and host behavior. The runtime skill cannot bypass CodeModeKit tool policy; explain a denial as a policy result rather than suggesting workarounds.
