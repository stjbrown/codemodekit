# ADR 0006: Return Actionable Model-Visible Diagnostics

**Status:** Accepted  
**Date:** 2026-08-09

## Context

Model-authored code often needs more than one attempt to discover the exact input shape or behavior of an upstream tool. Compiler errors, sandbox exceptions, schema-validation messages, and upstream MCP errors are valuable feedback that lets the LLM correct its code.

Treating these failures as opaque SDK exceptions would prevent that iteration. Returning raw host exceptions would expose credentials, environment data, absolute paths, implementation frames, or unbounded upstream content.

## Decision

`CodeMode.run` resolves every attempted execution to a discriminated result:

```ts
type CodeModeResult =
  | {
      ok: true;
      value?: JsonValue;
      logs: ModelLogRecord[];
    }
  | {
      ok: false;
      error: ModelDiagnostic;
      logs: ModelLogRecord[];
    };
```

An absent success `value` represents JavaScript `undefined`; an explicit `null` remains `value: null`.

Expected failures inside an attempted execution resolve as `ok: false`. Invalid SDK configuration and programmer misuse may throw before execution begins.

A model-visible diagnostic contains the useful subset appropriate to its phase:

```ts
interface ModelDiagnostic {
  code: string;
  phase: "compile" | "sandbox" | "tool";
  message: string;
  correlationId: string;
  location?: {
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
  };
  stack?: ModelStackFrame[];
  tool?: {
    source: string;
    name: string;
    upstreamCode?: string | number;
  };
  details?: JsonValue;
}
```

Compiler locations and sandbox stack frames are mapped to the original unwrapped `code` string. Tool diagnostics identify the configured source and exact tool name and preserve safe upstream error codes, messages, validation paths, and bounded details.

Sanitization removes credentials, authorization material, configured secret values, host filesystem paths, internal wrapper frames, and unsafe or excessive upstream content. Sanitization must preserve actionable information; a generic `Tool call failed` message is insufficient when a safe validation or protocol error is available.

Captured model-visible logs are sanitized, bounded, and returned on both success and failure. A separate trusted diagnostic records the fuller cause and host context and shares the model-visible `correlationId`. Trusted diagnostics never enter the sandbox or MCP tool result.

The MCP adapter projects `ok: false` as an MCP tool error while including a concise text rendering and the structured diagnostic. This ensures both text-oriented and structured-result clients expose the failure to the LLM.

An upstream tool failure that model-authored code catches does not fail the overall execution. If the code returns a fallback value, the result is `ok: true`.

## Consequences

- LLMs can correct syntax, type, schema, runtime, and upstream-tool mistakes using direct feedback.
- Error formatting becomes part of the public compatibility surface.
- Source maps and error normalization need conformance tests across sandbox adapters and providers.
- Redaction and bounding need adversarial tests because upstream error content is untrusted.
- Operators can correlate a model-visible failure with full trusted telemetry without exposing that telemetry to the model.
- `CodeMode.run` consumers can handle ordinary execution failures without `try`/`catch`.

## Alternatives considered

### Throw every execution failure

This mixes expected untrusted-code outcomes with SDK faults and forces every adapter to reconstruct a stable diagnostic contract.

### Return only a generic safe error

This protects internal data but removes the feedback the LLM needs to repair its code.

### Return raw exceptions and upstream error payloads

This maximizes detail but can leak secrets, host internals, or unbounded attacker-controlled content.
