# Domain discovery

Build an authoring brief before changing the runtime skill.

## Recover locally first

Inspect:

- product README and examples;
- `src/server.mjs` source names, Local Tool implementations, annotations, and policy;
- generated declaration shards indexed by `catalog-metadata.json`;
- tests and evaluation prompts;
- existing skill instructions and references;
- plugin name, description, keywords, version, and license; and
- domain documentation already committed to the project.

## Authoring brief

Record concise answers for:

1. Who invokes this skill?
2. What jobs should reliably trigger it?
3. What nearby jobs should not trigger it?
4. Which two or three workflows provide the most value?
5. What must the agent clarify before acting?
6. Which operations read, write, delete, communicate externally, spend money, or affect access?
7. What authorization or confirmation policy did the user actually specify?
8. What result shape is useful to the user?
9. What domain vocabulary or identifiers are easy to confuse?
10. Which upstream failures have a meaningful recovery path?

## Ask only consequential questions

Ask one to three short questions when missing answers would materially change the skill. Prioritize intended users and jobs, write/approval boundaries, and required output. Do not block on naming or prose preferences that can be revised safely.

Never infer a permissive write policy from tool availability. Never describe an organization-specific workflow as required unless repository evidence or the user establishes it.
