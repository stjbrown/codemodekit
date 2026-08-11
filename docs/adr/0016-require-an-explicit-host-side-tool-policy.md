# ADR 0016: Require an Explicit Host-Side Tool Policy

**Status:** Accepted  
**Date:** 2026-08-09

## Context

An MCP host sees and may approve the outer `run_typescript` call, but the authored program can make several nested calls to tools the host does not see as separate MCP invocations. Treating outer dispatch as proof that every possible nested call was individually authorized would hide meaningful side-effect decisions.

Upstream MCP annotations can describe read-only, destructive, idempotent, or open-world behavior, but they are untrusted metadata. They cannot be the sole security boundary.

Current [MCP multi-round-trip interaction](https://blog.modelcontextprotocol.io/posts/2026-07-28/#multi-round-trip-requests-mrtr) returns an `input_required` result and asks the client to retry the original call with responses and opaque request state. A QuickJS execution cannot be serialized and resumed portably. Restarting the authored program after approval could replay tool calls and external side effects that occurred before the approval point.

## Decision

`CodeMode` construction requires an explicit host-side tool policy:

```ts
interface ToolPolicyRequest {
  executionId: string;
  callId: string;
  source: string;
  tool: string;
  input: JsonValue;
  annotations?: NormalizedToolAnnotations;
  signal: AbortSignal;
}

type ToolPolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason?: string };

type ToolPolicy = (
  request: ToolPolicyRequest,
) => ToolPolicyDecision | Promise<ToolPolicyDecision>;
```

There is no implicit policy. Omitting it is invalid SDK configuration and fails construction.

The SDK supplies explicit helpers:

- `allowAllToolCalls()` for examples or environments where source registration and outer invocation are sufficient authorization;
- `denyAllToolCalls()` for locked-down or diagnostic environments;
- a rule-composition helper may be included if it remains small, but the callback is the stable public seam.

Policy evaluation occurs for every attempted active tool call:

1. Resolve the exact source and tool.
2. Validate and bound the input.
3. Count and queue the call under execution limits.
4. Invoke the policy with validated arguments and the root cancellation signal.
5. Dispatch to the provider only after an allow decision.

The policy may use static rules or wait for an embedding application's out-of-band approval UI. Waiting counts against the execution wall-time limit but not the provider's `toolCallTimeMs`; that timer begins at provider dispatch. The concurrency cap includes policy evaluation so parallel authored code cannot create an unbounded number of simultaneous approval prompts.

Upstream annotations are passed as explicitly untrusted hints. The policy receives no provider credentials or sandbox authority. SDK decisions are not cached automatically because authorization may depend on arguments, identity, time, or external state.

A deny decision becomes a sanitized, catchable `TOOL_APPROVAL_DENIED`. A policy exception, invalid decision, or unavailable approval service also fails closed with that model-visible code while retaining the fuller cause only in trusted diagnostics. Root cancellation remains `EXECUTION_CANCELLED` rather than an approval denial.

v0.1 does not use MCP elicitation for nested approval and never restarts the authored program to satisfy an approval request. Protocol-native resumable approval may be reconsidered with MCP Tasks or another design that cannot replay prior side effects.

The downstream adapter advertises conservative standard annotations:

- `run_typescript`: `readOnlyHint: false`, `destructiveHint: true`, and `openWorldHint: true`;
- `search_tools`: `readOnlyHint: true`, `destructiveHint: false`, and `openWorldHint: false`.

These annotations help a host make its outer-call decision but do not replace the nested tool policy.

## Consequences

- Every consumer makes an explicit authorization choice.
- Examples remain concise while visibly acknowledging their authority with `allowAllToolCalls()`.
- Sensitive deployments can inspect exact validated arguments or integrate their own approval UI.
- v0.1 behaves consistently across modern stateless MCP and legacy transports without attempting to snapshot QuickJS.
- Approval waits consume wall time and may require a trusted limit override for human-paced workflows.
- Policy failures deny calls rather than risking unauthorized dispatch.
- Consumers are responsible for the trust and availability of their policy implementation.

## Alternatives considered

### Implicitly allow every configured tool

This is convenient but hides a consequential authorization decision and lets one outer call perform arbitrary nested writes.

### Trust upstream annotations for automatic approval

Annotations are useful hints but can be missing, incorrect, or malicious.

### Use MCP elicitation during the running sandbox

Modern MCP retries the original request. Without portable sandbox continuation, a retry would either lose execution state or replay earlier side effects.

### Require all decisions to be synchronous

This simplifies timing but prevents integration with an embedding application's existing approval workflow.
