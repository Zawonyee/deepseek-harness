# Agent Note: Serialize capability request and revoke transitions

Status: implemented

English | [中文](2026-08-25-serialize-capability-request-and-revoke.zh.md)

## Problem

Independent pending-grant and pending-release indexes let overlapping transitions disagree about one Lease. After a release started but before the Session log committed `revoked`, a request for the same exact Agent and capability could observe the Lease as active and return it with `reused: true`. Runtime deactivation could then finish before the caller used that grant. A concurrent release could also retry against the terminal row instead of sharing the first operation's result.

## Decision

The Controller serializes request, release, expiry, and lifecycle reconciliation through one FIFO transition queue for each exact Agent and capability. A release marks the Lease closing before it enters the queue, so prompt assembly and execution stop exposing authority while in-flight calls drain. A later request decides between reuse and activation only after the preceding transition settles. Concurrent owner releases of one Lease share the same deactivation and result, while identity-checked cleanup removes only the operation that installed each pending entry. Session events remain the committed authority; the queue and closing marker coordinate only process-local work.

## Alternatives considered

**Add a durable `revoking` lease status.** Rejected because the race is process-local quiescence. Persisting it would add a third authority state and restart recovery rules even though the durable log needs only active and terminal facts.

**Allow requests to reuse an active row until revoke commits.** Rejected because the returned grant can lose its runtime tools before the caller can use it.

**Retry a concurrent release after the first operation settles.** Rejected because both calls joined the same authorized transition and need the same result; retrying changes the follower into a new sequential release.

## Consequences

Transitions are linearized for one exact Agent and capability without serializing unrelated capabilities or Agents. Weak Agent-keyed indexes do not retain disposed Agents, every successful physical teardown produces at most one terminal event, and a failed deactivation or append leaves authority hidden and the transition retryable. Restart, Agent disposal, Goal, turn, TTL, Provider, Registry, and Controller reconciliation use the same expiry path.
