# Generator reference

## Minimal server

```sh
npm create codemodekit@latest my-code-mode -- \
  --mcp-name upstream \
  --mcp-command 'uvx upstream-mcp'
```

Dependency installation is automatic. Use `--no-install` only when installation must happen later. The generator also installs this development-time skill at `.agents/skills/build-codemodekit-plugin`; use `--no-authoring-skill` to omit it.

## Agent Plugin

Add `--agent-plugin` to generate the portable manifests, companion Agent Skill, catalog references, and self-contained `dist/plugin` artifact. After installation, the generator attempts a live catalog sync. Use `--no-sync` to leave the references pending intentionally.

The generated package includes:

```json
{
  "scripts": {
    "start": "node src/server.mjs",
    "plugin:sync": "node src/server.mjs --sync-plugin",
    "plugin:build": "codemodekit-plugin build",
    "plugin:install:cursor": "codemodekit-plugin install cursor",
    "plugin:status:cursor": "codemodekit-plugin status cursor",
    "plugin:uninstall:cursor": "codemodekit-plugin uninstall cursor"
  }
}
```

`plugin:install:cursor` rebuilds the artifact, copies it into Cursor's local plugin directory, and resolves concrete Node and server paths for Cursor. Reload Cursor after install. Re-run the command after source or catalog changes.

## Tool policy

`--policy allow-all` is the runnable default. It allows every tool advertised by configured sources, subject to restrictions enforced by the upstream server itself.

Use `--policy deny-all` when the generated server must begin closed. Replace the policy in `src/server.mjs` with an explicit application policy before expecting tool calls to succeed.

## Command parsing

`--mcp-command` is parsed into one executable and an argument array without a shell. Quotes and backslash escaping are supported. Pipes, redirects, command substitution, and leading environment assignments are rejected.
