# Generator reference

## Minimal server

```sh
npm create codemodekit@latest my-code-mode -- \
  --mcp-name upstream \
  --mcp-command 'uvx upstream-mcp'
```

Dependency installation is automatic. Use `--no-install` only when installation must happen later.

## Agent Plugin

Add `--agent-plugin` to generate the portable manifests, companion Agent Skill, and catalog references. After installation, the generator attempts a live catalog sync. Use `--no-sync` to leave the references pending intentionally.

The generated package includes:

```json
{
  "scripts": {
    "start": "node src/server.mjs",
    "plugin:sync": "node src/server.mjs --sync-plugin"
  }
}
```

## Tool policy

`--policy allow-all` is the runnable default. It allows every tool advertised by configured sources, subject to restrictions enforced by the upstream server itself.

Use `--policy deny-all` when the generated server must begin closed. Replace the policy in `src/server.mjs` with an explicit application policy before expecting tool calls to succeed.

## Command parsing

`--mcp-command` is parsed into one executable and an argument array without a shell. Quotes and backslash escaping are supported. Pipes, redirects, command substitution, and leading environment assignments are rejected.
