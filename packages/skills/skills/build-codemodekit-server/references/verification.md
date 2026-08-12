# Verification

Verify from the downstream MCP boundary because direct provider calls bypass compilation, sandboxing, policy, bridge limits, and result projection.

## Minimum smoke

1. Start the generated server over stdio.
2. List tools and assert `run_typescript` is present. Expect `search_tools` unless disabled intentionally.
3. Call `search_tools` with a narrow capability query and inspect its generated TypeScript call shape.
4. Call `run_typescript` with one realistic workflow:

   ```ts
   const result = await tools.source.tool({ value: "test" });
   return result.structuredContent;
   ```

5. Compose two dependent calls when the source supports it; pass only the required fields from the first result into the second.
6. Send one schema-invalid input and assert the provider is not invoked.
7. Exercise one denied call when a custom or deny-all policy is used.
8. Confirm errors contain bounded safe diagnostics rather than credentials, stack traces, or raw upstream payloads.

## Agent Plugin

Run:

```sh
npm run plugin:sync
npm run plugin:build
```

Then verify:

- `dist/plugin/plugin.json`, `mcp.json`, `server.mjs`, QuickJS WASM, and runtime skill exist;
- `dist/plugin` contains no `.env`, source tree, or `node_modules`;
- the bundled server starts from outside the project directory; and
- a downstream MCP client can execute the same realistic `run_typescript` call through the artifact.

Use `$author-codemode-skill` after this mechanical verification to author and evaluate the user-facing runtime guidance.
