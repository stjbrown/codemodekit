# ADR 0005: Execute Code as an Async Function Body

**Status:** Accepted  
**Date:** 2026-08-09

## Context

LLM-authored Code Mode snippets need to orchestrate asynchronous tool calls without module boilerplate. Requiring the model to emit a complete module or exported function adds syntax that does not contribute to the task and creates more failure modes.

The runtime also needs an unambiguous convention for selecting the execution result. Inferring the last expression is convenient for a REPL but becomes surprising for multi-statement programs and requires additional syntax transformation.

## Decision

The `run_typescript` MCP input includes a `code` string. `CodeCompiler` treats that string as the body of an SDK-generated async entry function.

Model-authored code can therefore use `await` and `return` directly:

```ts
const issues = await tools.github.searchIssues({
  query: "is:open",
});

return issues;
```

An executed `return value` supplies the program result. If control reaches the end of the body, the result is `undefined`. The compiler does not implicitly return the final expression.

The wrapper is an implementation detail. Compiler diagnostics, stack locations, and source maps exposed to consumers must refer to locations in the original unwrapped `code` string.

ADR 0006 defines the public result and diagnostic envelope. ADR 0007 defines the module/import restrictions and safe-global surface. The cross-boundary value format remains a separate decision.

## Consequences

- Common Code Mode snippets require no async IIFE or exported entrypoint.
- Examples and generated skills should teach explicit `return`.
- The compiler must parse and type-check the input in function-body context.
- Wrapper-generated offsets must not leak into model-facing diagnostics.
- Reaching the end and `return undefined` are semantically equivalent at execution time.

## Alternatives considered

### Require a complete module with a default export

This uses ordinary TypeScript module syntax but adds repetitive boilerplate and creates module-loading questions before they are needed.

### Execute a complete script with top-level await

This supports asynchronous work but cannot use top-level `return`, making the result convention less direct.

### Implicitly return the final expression

This feels REPL-like but requires nonstandard transformation and can accidentally return logging, assignment, or helper expressions.
