---
name: build-codemodekit-server
description: Build, retrofit, debug, or verify CodeModeKit Code Mode MCP servers from application-owned Local Tools, stdio MCP commands, or remote MCP URLs. Use when scaffolding a CodeModeKit project, defining local tools and schemas, composing multiple sources, setting tool policy and limits, packaging an Agent Plugin, or troubleshooting run_typescript, search_tools, plugin sync, build, or Cursor installation.
---

# Build a CodeModeKit Server

Build a walking skeleton for the user's actual source, then verify it through the downstream MCP surface. Keep model-authored code in CodeModeKit's sandbox and host integrations behind tool providers.

## Build workflow

1. Inspect the repository, package manager, local instructions, existing MCP configuration, and relevant application functions. Do not overwrite unrelated work.
2. Choose the source boundary:
   - Use Local Tools for functions or APIs the application owns.
   - Use `mcp.stdio` for a shell-free executable and argument array.
   - Use `mcp.http` for a Streamable HTTP MCP endpoint.
   - Compose sources when one authored program needs more than one namespace.
3. For a new project, prefer the generator. Read [references/generator.md](references/generator.md) for commands and generated-file ownership.
4. For a retrofit or custom server, read [references/server-api.md](references/server-api.md), preserve the batteries-included facade, and expose compiler or sandbox configuration only when the user needs an expert override.
5. Define an explicit tool policy. Read [references/policy-and-security.md](references/policy-and-security.md) before enabling writes, handling credentials, or binding Streamable HTTP beyond loopback.
6. Keep the initial implementation compact. A single `src/server.mjs` is the default; split it only when domain code already has a natural module boundary.
7. If the project includes an Agent Plugin, run catalog sync and build, but do not pretend the generated runtime skill understands the domain. Invoke `$author-codemode-skill` after the server works.
8. Verify the downstream behavior using [references/verification.md](references/verification.md). Exercise `run_typescript`, not merely imports or direct provider functions.

The walking skeleton is complete when one realistic downstream execution crosses compilation, QuickJS, policy, the bridge, and the chosen provider and returns the expected bounded value.

## Local Tool quality bar

- Give tools stable action-oriented names and descriptions that distinguish them from siblings.
- Use bounded input and output schemas. Prefer Standard JSON Schema-compatible schemas when the project already uses one; plain JSON Schema requires no extra dependency.
- Return plain JSON values and declare an output schema when the result has a stable shape.
- Use the execution context's `signal` for fetches and other cancellable work.
- Throw `ToolError` only when its message is safe for model-authored code. Keep credentials, raw upstream responses, stack traces, and internal paths out of it.
- Keep authentication and network access in the trusted host function. Never add ambient `fetch`, filesystem, process, or package access to the sandbox to make a tool work.
- Mark read-only, destructive, idempotent, and open-world annotations accurately. Treat annotations as policy hints, not authorization.

## Completion criteria

Do not call the server ready until:

- dependencies install and typecheck or syntax checks pass;
- the server advertises `run_typescript` and, unless intentionally disabled, `search_tools`;
- at least one realistic TypeScript execution calls the configured source and returns a bounded value;
- policy denials and a representative invalid input fail safely;
- plugin catalog sync is current or its exact connectivity blocker is documented;
- `dist/plugin` builds when an Agent Plugin is requested; and
- the domain-aware runtime skill has either been authored or is explicitly reported as a generated baseline requiring `$author-codemode-skill`.
