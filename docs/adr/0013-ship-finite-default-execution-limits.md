# ADR 0013: Ship Finite Default Execution Limits

**Status:** Accepted  
**Date:** 2026-08-09

## Context

Model-authored code is untrusted and may loop forever, allocate excessive memory, issue unbounded tool calls, retain large provider results, or return more data than an LLM client can safely consume. Requiring every SDK consumer to configure every bound would make an unsafe deployment the easiest deployment.

Silent truncation is also dangerous for structured computation. A truncated JSON array or tool response can look valid enough for an LLM to act on while omitting important records. Logs are different: they are diagnostic context rather than the computation result and can be usefully sampled when bounded.

## Decision

v0.1 defines these defaults for one `CodeMode.run` execution:

```ts
interface ExecutionLimits {
  sourceBytes: number;
  computeTimeMs: number;
  wallTimeMs: number;
  toolCallTimeMs: number;
  memoryBytes: number;
  maxToolCalls: number;
  maxConcurrentToolCalls: number;
  toolResultBytes: number;
  totalBridgeBytes: number;
  finalResultBytes: number;
  logBytes: number;
  logEntries: number;
  progressMessageBytes: number;
  maxProgressEvents: number;
  progressEventsPerSecond: number;
}

const defaults: ExecutionLimits = {
  sourceBytes: 128 * 1024,
  computeTimeMs: 5_000,
  wallTimeMs: 60_000,
  toolCallTimeMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  maxToolCalls: 32,
  maxConcurrentToolCalls: 8,
  toolResultBytes: 2 * 1024 * 1024,
  totalBridgeBytes: 8 * 1024 * 1024,
  finalResultBytes: 256 * 1024,
  logBytes: 64 * 1024,
  logEntries: 100,
  progressMessageBytes: 1024,
  maxProgressEvents: 100,
  progressEventsPerSecond: 10,
};
```

Definitions and behavior:

- Byte limits count UTF-8 bytes of the supported serialized representation, not JavaScript string length.
- `sourceBytes` applies before compilation.
- `computeTimeMs` accumulates time actively running sandbox JavaScript and excludes time suspended on host tool promises.
- `wallTimeMs` starts when execution begins and includes compilation, sandbox compute, queueing, and upstream waits.
- Each tool call receives the smaller of `toolCallTimeMs` and the remaining wall-time budget.
- `maxToolCalls` counts attempted bridge calls, including calls that fail validation or provider execution.
- `maxConcurrentToolCalls` is a queueing cap, not an immediate error. Queued calls still consume the wall-time budget and count toward `maxToolCalls`.
- `toolResultBytes` bounds each computation-facing tool result; `totalBridgeBytes` counts the cumulative serialized tool arguments and results crossing the boundary.
- The final successful value must be supported JSON and fit within `finalResultBytes`.
- Source, tool-result, bridge, and final-result data is never silently truncated. Exceeding a limit fails with the corresponding SDK code from ADR 0012.
- Logs are bounded by both entries and bytes. The SDK retains bounded head and tail records, inserts a synthetic truncation marker with dropped counts where possible, and reports truncation metadata on both success and failure.
- Progress messages are at most 1 KiB and delivery is limited to 10 events per second and 100 events per run. Excess intermediate events are coalesced or dropped; terminal results do not depend on progress delivery.

Trusted consumers may override these values at `CodeMode` construction. The default downstream `run_typescript` input does not expose limit overrides to the LLM. All effective values must be finite positive safe integers. A sandbox adapter must reject unsupported requested limits during construction rather than silently ignoring them.

Changing an existing default downward can alter whether the same program succeeds. Patch releases do not lower defaults. Consumers requiring invariant values should configure them explicitly; major releases may revise defaults with migration notes.

When a hard limit is reached, the SDK stops sandbox execution, rejects queued bridge work, signals cancellation to active provider calls where supported, and performs deterministic cleanup. Provider-side side effects already accepted before cancellation may still complete and are never automatically replayed.

## Consequences

- A default installation has bounded resource consumption.
- Separating compute from wall time permits useful remote tool waits without allowing tight JavaScript loops to consume the whole request timeout.
- Parallel code can issue up to eight provider calls at once while remaining bounded by total count and traffic.
- Large intermediate tool data has more room than final LLM-facing output.
- Log truncation remains visible and preserves context from both ends of execution.
- Consumers with long-running or data-heavy workloads must opt into larger limits or later use MCP Tasks for the outer operation.
- Every sandbox adapter needs conformance tests for enforcement and cleanup, even if its internal mechanism differs.

## Alternatives considered

### Require all limits from the consumer

This is explicit but makes missing or incomplete security configuration likely.

### Allow unlimited values

This weakens the default security boundary and makes denial-of-service behavior easy to configure accidentally.

### Silently truncate every oversized value

This preserves apparent success but can produce materially incorrect computation and downstream decisions.

### Fail immediately above the concurrency cap

Queueing bounded calls is more useful for ordinary `Promise.all` code while total call, traffic, and wall-time limits still prevent unbounded execution.
