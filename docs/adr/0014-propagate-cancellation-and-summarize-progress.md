# ADR 0014: Propagate Cancellation and Summarize Progress

**Status:** Accepted  
**Date:** 2026-08-09

## Context

One `run_typescript` execution may compile code, run several sandbox segments, queue multiple tool calls, and invoke several upstream MCP servers in parallel. Downstream cancellation must stop this work coherently. Progress from those nested operations cannot be forwarded transparently because upstream tokens belong to different requests and their numeric values do not form one truthful total for the outer execution.

The [current MCP schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts) accepts an optional progress token on a request and permits progress notifications while that request remains active. Cancellation differs by transport and protocol era; the [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md#client-cancellation-on-streamable-http) abstracts current Streamable HTTP request-stream aborts and legacy or stdio cancellation notifications.

## Decision

### Core API

`CodeMode.run` accepts trusted cancellation and progress hooks:

```ts
interface CodeModeRunInput {
  code: string;
  context?: JsonValue;
  signal?: AbortSignal;
  onProgress?: (event: CodeModeProgress) => void;
}
```

`onProgress` is best-effort and non-blocking. Handler latency or failure does not delay or fail model-authored execution.

### Cancellation

Every execution has one root cancellation controller. A supplied consumer signal or downstream MCP request cancellation aborts it. The root signal fans out to:

- sandbox execution and interrupt handling;
- queued bridge calls, which are rejected before dispatch;
- each active provider call through a child signal;
- progress delivery and execution-owned cleanup.

Wall timeout and hard compute or memory limits use the same termination machinery but retain their limit-specific SDK codes. Each tool call also receives a child timeout bounded by the smaller of its configured timeout and remaining wall time. A per-tool timeout is a catchable `TOOL_CALL_TIMEOUT`; root cancellation and hard execution limits terminate the whole sandbox and cannot be caught to continue execution.

The MCP adapter uses the official TypeScript SDK's request signal rather than implementing transport messages itself. On current Streamable HTTP this follows request-stream abortion; supported stdio and older protocol paths use their SDK cancellation mechanism.

Cancellation is best-effort after provider dispatch. An upstream side effect may finish even after its response is abandoned. Cancelled or timed-out calls are never automatically replayed, and cancellation alone does not mark a source unhealthy or trigger reconnection.

A single atomic terminal state resolves completion-versus-cancellation races. If completion, final validation, and result serialization commit first, success wins. Otherwise cancellation wins. Progress and new bridge dispatch stop after the terminal state commits. When the downstream transport has already disappeared, cleanup still occurs even though `EXECUTION_CANCELLED` cannot be delivered.

### Progress

The core emits sanitized provider-independent lifecycle events for phases such as compilation, sandbox execution, tool queueing, tool start, and tool completion. Each event has an execution-local increasing sequence and may include a configured source name, exact tool name, call identifier, and bounded message.

The downstream MCP adapter emits progress only when the request supplied a progress token. It maps:

- the caller's token to every outer notification;
- the internal increasing sequence to MCP `progress`;
- no `total`, because the program can discover and issue calls dynamically;
- a bounded lifecycle or source-and-tool summary to `message`.

For an upstream call, the provider may request progress with its own unique token. Upstream tokens and numeric progress are never copied into the downstream stream. Safe upstream messages may be summarized as outer events, for example `github.searchIssues: processing page 3`.

Progress is rate-limited to 10 delivered events per second, 100 per execution, and 1 KiB per message. Excess intermediate updates are coalesced or dropped. Progress is advisory: execution behavior and the final result never depend on successful notification delivery.

## Consequences

- Consumers and MCP transports share one cancellation model.
- Parallel and nested tool activity cannot produce colliding or decreasing downstream progress values.
- Progress accurately communicates activity without pretending the dynamic execution has a known percentage.
- Cancellation cannot guarantee rollback of already accepted upstream side effects.
- Providers and sandboxes must accept abort signals and pass cancellation conformance tests.
- Progress handlers and upstream messages are additional untrusted-data boundaries requiring sanitization and bounding.
- Durable, reconnectable status remains the responsibility of a future MCP Tasks projection, not v0.1 progress notifications.

## Alternatives considered

### Forward upstream progress unchanged

Tokens can collide, numeric progress can move backward when calls overlap, and upstream messages may expose untrusted or irrelevant details.

### Invent one percentage for the execution

The total amount of work is unknowable because model-authored code can branch, loop, and create calls dynamically.

### Cancel only sandbox JavaScript

This leaves queued and active provider work consuming resources after the caller has abandoned the request.

### Treat cancellation as a source failure

Caller intent says nothing about source health and should not trigger reconnect churn.
