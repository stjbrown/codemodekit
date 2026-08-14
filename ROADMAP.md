# CodeModeKit Roadmap

Planned feature work, roughly in priority order. Items are grouped into waves;
each wave is independently shippable. This file tracks direction, not
commitments — dates are deliberately absent.

## Wave 1 — Deployable auth

### Inbound: bearer-token authentication for `serveCodeModeHttp`

The HTTP server is anonymous by design today: loopback is the default bind and
anything beyond it requires the `allowUnauthenticatedRemoteAccess`
acknowledgment flag. `run_typescript` is a maximally privileged endpoint, so
there is currently no supported way to put CodeModeKit on a network.

- `authToken` / `authTokens` option (or a verifier callback) checked before the
  MCP handler sees the request.
- Constant-time comparison, 401 with `WWW-Authenticate` on failure.
- Non-loopback binds become legitimate when a verifier is configured; the
  acknowledgment flag remains only for the explicitly unauthenticated case.

### Identity-aware tool policy

`ToolPolicyRequest` carries no caller context, so policies cannot distinguish
callers ("interns get read-only tools"). Thread an authenticated principal
from the HTTP layer through `run` → bridge → policy so a policy decision can
depend on who is asking. This is what makes auth more than a lock on the door.

## Wave 2 — Source reach

### OpenAPI source provider

Already promised in the README ("OpenAPI is planned") and the highest-leverage
adoption feature: far more services describe themselves with OpenAPI than run
MCP servers, and Code Mode's pitch — compose many calls in one execution —
shines against REST APIs. The existing catalog, declaration-shard, and policy
machinery maps cleanly onto OpenAPI operations.

- Operations become catalog tools (`tools.<source>.<operationId>`).
- Schemas translate to the same bounded TypeScript declarations.
- Auth via the same host-side header/env indirection as HTTP MCP sources.

### Resources and prompts pass-through

Only tools are proxied today. MCP sources that return resource links produce
URIs the sandbox cannot dereference.

- A `resources.read(uri)` surface inside the sandbox, policy-gated and
  byte-bounded like tool results.
- Prompt listing/pass-through where the host client can use them.

## Wave 3 — Policy and control

### Declarative tool policy

The gap between `allowAllToolCalls`/`denyAllToolCalls` and a hand-written
policy function is too wide.

- Pattern-based allow/deny lists (`github.get_*`, `weather.*`).
- Read-only mode derived from MCP `readOnlyHint` annotations.
- Per-tool and per-source rate/count limits.
- An "ask" decision: policy can defer to human-in-the-loop approval
  (elicitation) instead of flat denial.

### Audit trail

Observer events deliberately exclude payloads — right for telemetry, but it
means no durable record of which tools were called with what inputs by whom.
Needed as soon as auth exists.

- Opt-in structured audit sink with redaction hooks.
- OpenTelemetry adapter over the existing observation events (the event model
  is already clean; this is mostly a mapping).

## Wave 4 — Outbound auth

### OAuth for upstream MCP sources

Static headers and bearer-token-from-env cover API keys, but not OAuth-based
MCP servers, token refresh, or per-user pass-through (calling an upstream as
the end user rather than one shared token). Build on the MCP SDK client's
OAuth support. Deliberately sequenced after the MCP SDK stabilizes, since this
is where its surface is churning most.

- OAuth client-credentials with refresh for server-to-server sources.
- Per-user token pass-through tied to the inbound principal (Wave 1).

## Wave 5 — Execution model

### Worker-thread sandbox execution

The sync QuickJS variant runs guest code on the host thread: a busy loop
stalls every concurrent request for up to the compute limit, and
provider-schema regex validation also runs on the host thread. Moving
execution (and validation) off-thread fixes both classes and is table stakes
for a multi-client server.

### Per-session execution state

A small, bounded, policy-visible KV the guest can read and write across
executions in a session, so multi-step agent workflows don't re-fetch
everything on each `run_typescript`.

## Explicitly out of scope

- Windows support.
- Pinning or conformance-testing the beta MCP SDK surface — revisit when the
  SDK ships a stable release and the churn settles.
