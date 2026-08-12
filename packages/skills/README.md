# CodeModeKit skills

Install CodeModeKit's two project-level Agent Skills with the open skills CLI:

```sh
npx skills add stjbrown/codemodekit
```

The repository contains:

- `build-codemodekit-server` builds and verifies Code Mode MCP servers from Local Tools or MCP sources.
- `author-codemode-skill` turns a generated companion skill into domain-aware runtime guidance and maintains its Agent Plugin package.

Install either one independently:

```sh
npx skills add stjbrown/codemodekit --skill build-codemodekit-server
npx skills add stjbrown/codemodekit --skill author-codemode-skill
```

For an explicit, non-interactive install of both into Cursor:

```sh
npx skills add stjbrown/codemodekit \
  --skill '*' \
  --agent cursor \
  --copy \
  --yes
```

## npm and programmatic installation

The `@codemodekit/skills` npm package backs `create-codemodekit` and can also copy both skills directly into the current project's portable `.agents/skills` directory:

```sh
npx @codemodekit/skills
```

Install one from the npm package with `--skill`:

```sh
npx @codemodekit/skills --skill build-codemodekit-server
```

CodeModeKit-generated projects install both automatically. Use the skills CLI for agent-specific destinations, global installation, symlinks, updates, or discovery through [skills.sh](https://skills.sh/).
