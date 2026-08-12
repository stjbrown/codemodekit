# Policy and security

## Tool authorization

CodeModeKit requires a host-side tool policy. `allowAllToolCalls()` is suitable for a runnable starter only when every visible tool is authorized for the model's users. `denyAllToolCalls()` starts closed. A custom policy receives validated source, tool, input, annotations, execution IDs, and cancellation signal.

For write-capable catalogs:

- prefer an upstream read-only mode or allowlist when available;
- authorize by source and exact tool, not by description text;
- inspect arguments for tenant, repository, channel, or resource boundaries when needed;
- fail closed when an approval or policy dependency is unavailable; and
- never infer authorization from read-only or destructive annotations.

## Secret handling

- Keep secrets in the host environment, an ignored `.env`, or the upstream provider's credential mechanism.
- Never write credentials into `plugin.json`, `mcp.json`, runtime skills, generated references, tool errors, or portable artifacts.
- Agent Plugins 1.0 has no portable credential-reference or OAuth configuration field.
- Treat configured plugin `env` and HTTP headers as visible package data.

## Sandbox boundary

Model-authored TypeScript receives `tools`, bounded console support, and safe JavaScript globals. Do not expose Node modules, `process`, filesystem access, ambient network access, dynamic imports, `eval`, or `Function` to solve an integration problem. Put the capability in a provider.

## HTTP exposure

`serveCodeModeHttp` binds to loopback by default. A non-loopback unauthenticated bind requires an explicit acknowledgement but does not create authentication. Put an authenticated gateway in front of it or integrate authentication at the owning host.
