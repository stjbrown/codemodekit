# ADR 0012: Use Stable SDK-Owned Error Codes

**Status:** Accepted  
**Date:** 2026-08-09

## Context

Failures cross several independently evolving boundaries: the TypeScript compiler, sandbox runtime, tool bridge, upstream MCP servers, and downstream MCP adapter. Returning only an upstream or implementation-specific code would make consumers depend on unstable external taxonomies. Replacing every error with a generic code would remove the information an LLM needs to repair its code.

## Decision

Every model-visible failure has one stable SDK-owned `code` and one phase:

```ts
interface ModelDiagnostic {
  code: CodeModeErrorCode;
  phase: "compile" | "sandbox" | "tool";
  message: string;
  correlationId: string;
  // Phase-specific safe details omitted here.
}
```

The initial catalog is:

| Code | Phase | Meaning |
|---|---|---|
| `COMPILE_ERROR` | `compile` | Model-authored TypeScript did not compile. |
| `SANDBOX_EXCEPTION` | `sandbox` | Authored code raised an uncaught runtime exception. |
| `EXECUTION_TIMEOUT` | `sandbox` | The execution exceeded its wall-clock limit. |
| `EXECUTION_CANCELLED` | `sandbox` | The caller cancelled the execution. |
| `SOURCE_LIMIT_EXCEEDED` | `compile` | Model-authored source exceeded the configured byte limit. |
| `COMPUTE_LIMIT_EXCEEDED` | `sandbox` | Active sandbox JavaScript exceeded its compute-time budget. |
| `MEMORY_LIMIT_EXCEEDED` | `sandbox` | The sandbox exceeded its configured memory bound. |
| `OUTPUT_NOT_SERIALIZABLE` | `sandbox` | The final authored value could not be represented as supported JSON output. |
| `OUTPUT_LIMIT_EXCEEDED` | `sandbox` | Authored output exceeded a configured serialization or size bound. |
| `SOURCE_UNAVAILABLE` | `tool` | The addressed source is configured but currently unavailable. |
| `TOOL_NOT_FOUND` | `tool` | No configured active or rejected tool matches the address. |
| `TOOL_SCHEMA_UNSUPPORTED` | `tool` | The addressed tool is quarantined because its declared schema cannot be enforced. |
| `TOOL_INPUT_INVALID` | `tool` | Tool arguments failed trusted runtime validation. |
| `TOOL_OUTPUT_INVALID` | `tool` | Provider output failed structural, serialization, bounds, or declared-schema validation. |
| `TOOL_CALL_TIMEOUT` | `tool` | A tool call exceeded its individual time limit. |
| `TOOL_CALL_LIMIT_EXCEEDED` | `tool` | Authored code attempted more than the configured number of tool calls. |
| `TOOL_OUTPUT_LIMIT_EXCEEDED` | `tool` | One computation-facing tool result exceeded its byte limit. |
| `BRIDGE_LIMIT_EXCEEDED` | `tool` | Aggregate sandbox-to-host tool traffic exceeded its byte budget. |
| `TOOL_EXECUTION_FAILED` | `tool` | The provider reported an execution failure not covered by a more specific SDK code. |
| `TOOL_APPROVAL_DENIED` | `tool` | Required host approval was denied or unavailable. |
| `INTERNAL_ERROR` | current phase | An unexpected SDK failure occurred after execution began; only a safe message and correlation identifier are model-visible. |

Compiler, sandbox, protocol, and provider codes remain optional secondary details:

- compilation diagnostics may include `compilerCode`;
- tool diagnostics may include `tool.upstreamCode` as a string or number;
- safe validation paths and bounded provider details may be included in `details`;
- the stable SDK `code` is never replaced by an upstream value.

For a tool error caught by model-authored code, the injected catchable error exposes the same SDK code and safe tool details. If uncaught, those fields map directly into the `CodeMode.run` failure.

Invalid SDK configuration and programmer misuse detected before execution begins may throw typed SDK exceptions rather than producing a `ModelDiagnostic`. Unexpected failures after execution begins become `INTERNAL_ERROR` and are linked to full trusted diagnostics by `correlationId`.

The downstream MCP adapter represents authored-code and tool-execution failures as tool execution errors, not MCP protocol errors. Invalid `run_typescript` request framing remains the MCP server framework's protocol/input-validation responsibility.

### Compatibility

- The meaning of an existing SDK code does not change incompatibly within a major version.
- A minor release may add a new SDK code.
- Consumers should branch on known codes and retain an unknown/default case.
- Removing, renaming, or incompatibly redefining a code requires a major release.

## Consequences

- Consumer behavior remains stable when TypeScript, sandbox, MCP, or upstream-server codes change.
- The LLM still receives safe upstream context needed to revise a failed call.
- Every boundary needs an explicit mapping into the SDK catalog.
- Tests must verify codes, phases, sanitization, secondary details, and caught-versus-uncaught behavior.
- `INTERNAL_ERROR` protects internals but is intentionally less actionable; operators use its correlation identifier to inspect trusted diagnostics.

## Alternatives considered

### Expose only upstream codes

This maximizes fidelity but produces no portable contract across compilers, sandboxes, or providers.

### Use free-form string codes

This is flexible but encourages accidental public codes and inconsistent spellings without compatibility review.

### Return only a generic execution error

This is stable but prevents useful programmatic recovery and model self-correction.
