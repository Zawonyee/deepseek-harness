# Agent Note: Session-backed capability authority

Status: implemented

English | [中文](2026-08-25-session-backed-capability-controller.zh.md)

## Problem

A model-facing tool is executable authority, not only prompt context. Dynamically adding a schema without durable ownership leaves restart and replay unable to explain why the Tool was visible; hiding a schema without guarding execution leaves direct ToolRuntime and Code Mode calls able to bypass the policy. Process-wide plugin activation also lets one Agent's grant leak into siblings.

## Decision

`@deepseek-ai/dsh-capability-controller` owns one closed Registry, policy evaluation, exact-Agent Lease lifecycle, trusted Provider activation, and execution enforcement. Loader configuration declares capability id, Provider, risk, approval requirement, default and allowed scopes, idle TTL, and successful-use expiry. Host plugins register Provider descriptors through one effect; they cannot shadow existing Tools, claim Controller or `cordis_*` names, or share Provider, Tool, or Prompt section ownership.

The required-on-read `capability/change` V1 Session event is the only authoritative state. Requests transition from `requested` to `denied`, a new `granted`, or `reused`; Leases transition once from `active` to explicit `revoked` or automatic `expired`. The event envelope supplies time. A `WeakMap<Session, incremental fold>` accelerates reads without becoming another store, and process-local indexes retain only weak Agent ownership and live Provider Fibers.

One exact Agent and capability have one serialized transition queue and at most one active Lease. Exact scope and lifecycle binding reuse the Lease without refreshing TTL; any mismatch is denied. Turn, Goal, Agent, Session, TTL, Provider, Controller, restart, and definition-change paths converge on one expiry operation. Closing hides authority synchronously, drains in-flight calls, disposes the exact Fiber, and then commits one terminal event. A failed deactivation or append remains fail closed and retryable.

Provider activation runs below `agent.ctx`. A new grant activates the Fiber before the durable grant append, and an append failure disposes it; only the committed Lease makes it model-visible. Prompt assembly filters controlled Tools and Provider guidance, `agent/pre-step` retries assembly when authority changed after the snapshot, and Tool execution requires the exact owner, committed non-closing Lease, current schema generation, and matching unsettled call record. Code Mode nested calls also require their dispatch record. Logged active Leases never reactivate after a process restart; reconciliation expires them as lost process-local authority.

The shipped `controlled-doc` preset demonstrates the composition with document Tools available initially, approval-required `web.search` behind a session Lease, and approval-required `shell.execute` behind a turn Lease that expires after a successful call. Shell capability approval is independent from command-level sandbox escalation approval.

## Alternatives considered

**Use raw Dynamic Cordis activation.** Rejected because its Host effects are rooted outside an exact Agent scope, its control Tools expose arbitrary runtime modification, and its activation record does not establish durable Lease authority.

**Treat prompt filtering as enforcement.** Rejected because direct ToolRuntime execution, stale request generations, same-step forged calls, and Code Mode nested calls do not need to rediscover a Tool through the current schema.

**Keep Lease state in a process-memory store and restore it best-effort.** Rejected because replay and crash recovery would disagree with the authority that produced historical Tool calls. Re-activating a logged Lease after restart would also skip current policy, approval, Provider definition, and exact Fiber identity.

**Persist a general `closing` state.** Rejected because closing is process-local quiescence, not durable authority. The log records only committed active and terminal facts; recovery treats a surviving active fact without its Fiber as expired.

## Consequences

Optional Tool exposure is attributable to durable events and remains isolated by exact Agent identity across schema discovery and execution. Revocation costs an awaited in-flight drain and Provider teardown, and restart deliberately discards persistent-scope authority. Provider definitions must be installed with the Controller and remain stable for a Lease generation. Registry-miss generation, Marketplace installation, Agent Runtime rewriting, live preset switching, and visual composition remain outside V1.

Focused lifecycle, concurrency, HMR, replay, invariant, Provider, Loader, preset, and scripted evaluation tests pin these rules. The reproducible evaluator compares Full, Raw Cordis, and Controller compositions using task success, intervention, visible Tool count, risk exposure, schema churn, lifecycle counts, and token/cache usage without committing real-engine results.
