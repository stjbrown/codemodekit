# ADR 0007: Expose Only Safe Sandbox Globals

**Status:** Accepted  
**Date:** 2026-08-09

## Context

The sandbox exists to let an LLM orchestrate registered tools, not to provide a general-purpose package or host execution environment. Supporting imports would require dependency resolution, package installation, bundling, version selection, and supply-chain policy. Ambient host APIs would bypass `ToolBridge`, where validation, approval, tracing, and credential isolation occur.

Runtime-specific globals would also make the same authored program behave differently across QuickJS and future sandbox adapters.

## Decision

Model-authored code receives only:

- a versioned allowlist of portable, safe JavaScript intrinsics;
- the namespaced `tools` proxy;
- a bounded and sanitized `console` implementation;
- explicitly documented data-only bindings, if the public execution input later defines them.

There is no module or package-loading capability. The compiler or sandbox rejects static imports, exports, dynamic `import()`, `require`, and equivalent module entry points.

There is no ambient host capability, including filesystem access, environment variables, host process access, child processes, sockets, or `fetch`. All external effects cross `ToolBridge` through registered tools.

Dynamic code-generation primitives such as `eval` and `Function` are not exposed. This keeps authored code within the compilation, source-mapping, policy, and diagnostic pipeline.

The exact intrinsic allowlist is specified and versioned as part of the `CodeSandbox` conformance contract. Sandbox adapters may implement the list differently but may not expose additional runtime-specific globals by default.

If a future use case needs reusable functionality, the preferred extension is a registered tool or an explicitly versioned, audited, data-only helper—not arbitrary package imports.

## Consequences

- Tool policy remains the exclusive boundary for external effects.
- The SDK does not need a package manager, resolver, or bundler in v0.1.
- Generated skills and examples can rely only on the documented safe-global set.
- Programs are more portable across sandbox adapters.
- Some data-processing tasks require more authored code or an upstream helper tool.
- The compiler must return clear model-visible diagnostics for prohibited syntax and unavailable globals.
- Each execution needs isolation sufficient to prevent mutation of built-in prototypes from affecting later executions.

## Alternatives considered

### Permit arbitrary npm imports

This is flexible but introduces supply-chain execution, dependency installation, filesystem access, and runtime portability problems that do not belong in this SDK.

### Bundle a large convenience standard library

This helps some tasks but increases context, compatibility, and maintenance costs before concrete needs are known.

### Allow host APIs but rely on the sandbox runtime

This bypasses the provider, policy, approval, and tracing boundary and creates adapter-specific security behavior.

