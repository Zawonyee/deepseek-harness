# Capability Control

English | [中文](capability.zh.md)

The [Capability Controller](../../packages/capability/capability-controller/README.md) is an optional authority layer for model Tools. A Loader composition declares a closed capability Registry and trusted Host plugins register Providers. An exact Agent receives a scoped Lease only after Registry, lifecycle, policy, and optional user-approval checks succeed. The Session log is authoritative for committed authority; Provider Fibers, in-flight counters, and schema generations remain process-local enforcement state.

Sources: [`index.ts`](../../packages/capability/capability-controller/src/index.ts), [`events.ts`](../../packages/capability/capability-controller/src/events.ts), [`provider.ts`](../../packages/capability/capability-controller/src/provider.ts), [`package.json`](../../packages/capability/capability-controller/package.json)

## Published entries and Registry configuration

The package publishes four code entries. It has no `./src/*` export and no compatibility alias for the former experimental package.

| Entry | Contract |
|---|---|
| `@deepseek-ai/dsh-capability-controller` | Loader-compatible default `CapabilityController`, the named service, the runtime `Config` schema, public request/Lease/event/fold types, and the Host-only `registerProvider()` service effect. |
| `@deepseek-ai/dsh-capability-controller/provider-web` | Registers the trusted `provider-web` descriptor; an active Lease contributes only `web_search` and its matching guidance. |
| `@deepseek-ai/dsh-capability-controller/provider-shell` | Registers the trusted `provider-shell` descriptor; an active Lease contributes `pwsh` on Windows or `bash` elsewhere and still uses the existing shell executor and sandbox policy. |
| `@deepseek-ai/dsh-capability-controller/invariant` | Installs relational validation for the required-on-read `capability/change` stream. |

The root `Config` export is statically discoverable by Loader. Its required `capabilities` array is the closed Registry: every row declares the capability and Provider identities, risk, approval policy, default and allowed scopes, and optional shortening rules. Validation rejects duplicate capability IDs, malformed Provider/risk/scope values, an empty scope set, or a default outside that set; a configured Provider that is still absent when an Agent starts also fails closed.

```ts type-equiv
/** One trusted Registry row and its policy-relevant metadata. */
interface CapabilityDefinition {
  /** Stable capability identifier requested by the model, for example `web.search`. */
  readonly capability: string
  /** Unique trusted Provider name that supplies this capability at runtime. */
  readonly provider: string
  /** Risk class used by approval policy and exposure reporting. */
  readonly risk: CapabilityRisk
  /** Whether every new activation must complete the user-approval flow. */
  readonly approvalRequired: boolean
  /** Lease scope selected when `request_capability` omits `requested_scope`. */
  readonly defaultScope: CapabilityLeaseScope
  /** Complete set of lease scopes callers may request for this capability. */
  readonly allowedScopes: CapabilityLeaseScope[]
  /** Optional idle timeout, in seconds, measured from grant or last successful use. */
  readonly idleTtlSec?: number
  /** Expire the lease after its first successful, non-aborted Provider tool call. */
  readonly expireAfterSuccessfulUse?: boolean
}
```

```ts type-equiv
/** Loader-facing static configuration. Providers are registered separately through the trusted Host service. */
interface Config {
  /** Trusted capability Registry rows available to this Controller instance. */
  readonly capabilities: CapabilityDefinition[]
}
```

## Provider descriptors

An `AgentScopedCapabilityProvider` declares one immutable Provider identity and the exact Tool and prompt-section names its plugin contributes. Registration does not activate the plugin. The Controller mounts it below the requesting Agent only while a committed Lease exists, and rejects duplicate ownership, existing-Tool shadowing, Controller Tool names, and `cordis_*` names.

```ts type-equiv
/**
 * One trusted Provider that the Host may register with the Controller.
 *
 * Registration only declares an activatable Cordis plugin. The Controller
 * mounts that plugin below the requesting Agent's scope after policy and
 * approval succeed; declaring a Provider never grants its tools by itself.
 */
interface AgentScopedCapabilityProvider {
  /** Unique Registry-facing Provider name. */
  readonly name: string
  /** Cordis plugin mounted in the exact requesting Agent's private scope. */
  readonly plugin: Plugin
  /** Optional configuration passed unchanged to the Provider plugin. */
  readonly config?: unknown
  /** Complete, exact set of model Tool names contributed by the plugin. */
  readonly toolNames: readonly string[]
  /** Complete, exact set of system-prompt section names contributed by the plugin. */
  readonly promptSectionNames?: readonly string[]
}
```

## Requests and scope

Lease scope is part of authority rather than presentation. A `turn` Lease expires with its turn, a `task` Lease binds to the current non-terminal Goal, and `session` and `persistent` Leases last until their exact Agent is disposed. `persistent` does not restore authority after a process restart. Idle TTL and successful-use expiry may shorten any configured lifetime.

```ts type-equiv
/** Lease lifetimes enforced by turn, Goal, Agent, idle-TTL, and explicit-release lifecycle owners. */
type CapabilityLeaseScope = 'turn' | 'task' | 'session' | 'persistent'
```

Every granted Lease captures exactly one required binding whose variant must match its scope. The binding, rather than a later lookup of mutable Agent state, determines which turn or Goal terminal edge owns cleanup.

```ts type-equiv
/** Durable lifetime owner captured when a lease is granted. */
type CapabilityLeaseBinding =
  | { readonly kind: 'turn'; readonly turn: number }
  | { readonly kind: 'task'; readonly goalId: string }
  | { readonly kind: 'session' }
  | { readonly kind: 'persistent' }
```

The materialized Lease keeps that binding required. When activation followed an approval question, `approvalRequestId` carries the durable receipt identity shared with the approval audit pair.

```ts type-equiv
/** Materialized capability lease stored by the deployment-selected backend. */
interface CapabilityLease {
  readonly leaseId: string
  readonly sessionId: string
  readonly capability: string
  readonly provider: string
  readonly risk: CapabilityRisk
  readonly scope: CapabilityLeaseScope
  readonly binding: CapabilityLeaseBinding
  readonly approvalRequestId?: ApprovalRequestId
  readonly reason: string
  readonly status: CapabilityLeaseStatus
  readonly toolNames: readonly string[]
  readonly grantedAt: string
  readonly lastUsedAt: string
  readonly revokedAt?: string
  readonly idleTtlSec?: number
  readonly expireAfterSuccessfulUse?: boolean
}
```

A request carries the live Agent as its authority identity. `requestedScope` is optional; omission selects the Registry row's default. `callId` associates a required approval with the originating model Tool call, while aborting `signal` withdraws a pending approval and prevents activation.

```ts type-equiv
/** Controller request authenticated by an exact Agent object. */
interface CapabilityRequest {
  readonly agent: Agent
  readonly capability: string
  readonly reason: string
  readonly requestedScope?: CapabilityLeaseScope
  /** Exact model tool call correlated with approval audit, when available. */
  readonly callId?: CallId
  /** Cancellation of the originating tool call also withdraws any approval question. */
  readonly signal?: AbortSignal
}
```

## Grant and denial results

`request()` returns only a committed grant or a fail-closed denial. A grant reports whether it reused the exact Agent's active Lease; reuse requires identical scope and lifecycle binding and does not refresh idle TTL. Denial codes separate missing Registry or Provider entries, policy and scope decisions, missing lifecycle context, approval outcomes, cancellation, Lease conflict, and activation failure.

```ts type-equiv
/** Structured grant or fail-closed denial returned after any required approval settles. */
type CapabilityRequestResult =
  | {
    readonly status: 'granted'
    readonly leaseId: string
    readonly capability: string
    readonly scope: CapabilityLeaseScope
    readonly reused: boolean
  }
  | {
    readonly status: 'denied'
    readonly capability: string
    readonly code:
      | 'registry-miss'
      | 'provider-unavailable'
      | 'policy-denied'
      | 'scope-not-allowed'
      | 'task-goal-required'
      | 'lease-scope-conflict'
      | 'approval-rejected'
      | 'approval-cancelled'
      | 'approval-unavailable'
      | 'request-cancelled'
      | 'lifecycle-context-missing'
      | 'activation-failed'
    readonly reason: string
  }
```

An explicit release names one opaque Lease and its live Agent owner. The Controller distinguishes an absent, foreign, terminal, or teardown-failed Lease without publishing a false terminal fact.

```ts type-equiv
/** Explicit release request for one opaque lease id. */
interface CapabilityReleaseRequest {
  readonly agent: Agent
  readonly leaseId: string
}
```

```ts type-equiv
/** Structured result of an owner-authorized release attempt. */
type CapabilityReleaseResult =
  | {
    readonly status: 'released'
    readonly leaseId: string
    readonly capability: string
  }
  | {
    readonly status: 'denied'
    readonly leaseId: string
    readonly code: 'lease-not-found' | 'lease-not-owned' | 'lease-not-active' | 'deactivation-failed'
    readonly reason: string
  }
```

## Durable authority and execution

Required-on-read [`capability/change`](../persistence-catalog.md#capabilitychange--log-only) events record requests, denials, new grants, reuse, successful use, explicit revocation, and automatic expiry. A request reaches one terminal request state, and a Lease reaches at most one terminal Lease state. Event-envelope time supplies all durable timestamps.

When policy asks, the Controller uses `ApprovalService.requestWithReceipt()`. Its `ApprovalReceipt.id` is copied to the resulting `denied` event or new `granted` event as `approvalRequestId`, matching the same `approval/asked` and `approval/decided` pair. Paths that did not ask omit the field; exact-Lease reuse happens without a second approval receipt.

```ts type-equiv
/**
 * Required-on-read transition for one request or lease. Event envelope time is
 * authoritative for request, grant, use, reuse, and terminal timestamps.
 */
type CapabilityChange =
  | {
    readonly kind: 'requested'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly requestId: CapabilityRequestId
    readonly agentId: string
    readonly capability: string
    readonly requestedScope: CapabilityLeaseScope
    readonly reason: string
  }
  | {
    readonly kind: 'denied'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly requestId: CapabilityRequestId
    /** Approval audit pair that resolved this request, when policy asked. */
    readonly approvalRequestId?: ApprovalRequestId
    readonly code: CapabilityDenialCode
    readonly reason: string
  }
  | {
    readonly kind: 'granted'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly requestId: CapabilityRequestId
    readonly leaseId: CapabilityLeaseId
    /** Approval audit pair that authorized this grant, when policy asked. */
    readonly approvalRequestId?: ApprovalRequestId
    readonly provider: string
    readonly risk: CapabilityRisk
    readonly scope: CapabilityLeaseScope
    readonly binding: CapabilityLeaseBinding
    readonly toolNames: readonly string[]
    readonly idleTtlMs?: number
    readonly revokeAfterSuccess: boolean
  }
  | {
    readonly kind: 'reused'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly requestId: CapabilityRequestId
    readonly leaseId: CapabilityLeaseId
  }
  | {
    readonly kind: 'used'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly leaseId: CapabilityLeaseId
    readonly callId: string
    readonly toolName: string
    readonly outcome: CapabilityUseOutcome
  }
  | {
    readonly kind: 'revoked'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly leaseId: CapabilityLeaseId
    readonly reason: string
  }
  | {
    readonly kind: 'expired'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly leaseId: CapabilityLeaseId
    readonly cause: CapabilityExpirationCause
    readonly reason: string
  }
```

Prompt assembly and Tool execution enforce the same committed authority independently. Closing a Lease first hides its Tool and guidance and rejects new calls, then drains in-flight calls, disposes the exact Provider Fiber, and finally appends the terminal event. Provider teardown or terminal append failure leaves authority fail closed and retryable. Recovery never reactivates a logged Lease without its exact process-local Fiber.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcapabilitycontroller--capabilitycontroller"></a>

### `ctx.capabilityController` — `CapabilityController`

Controller service and the only model-facing capability grant/release entry points.

```ts cordis-catalog
/**
 * Register one trusted Host-owned provider for Loader-configured capabilities.
 * @param provider - immutable Provider descriptor and its exact Tool and Prompt-section ownership.
 * @returns an async effect disposer that synchronously closes active authority before expiring its Leases.
 */
registerProvider(provider: AgentScopedCapabilityProvider): () => Promise<void>

/**
 * Resolve policy and activate at most one exact-Agent Lease for this capability.
 * A request waits for preceding transitions before selecting reuse, activation, or denial.
 * @param request - exact Agent authority, capability, reason, and requested scope.
 * @returns a structured grant or denial after any required approval settles.
 */
async request(request: CapabilityRequest): Promise<CapabilityRequestResult>

/**
 * Revoke only an active lease owned by the exact calling Agent object.
 * Concurrent releases of the same lease share one deactivation and terminal result.
 * @param request - exact Agent authority and lease id to release.
 * @returns the committed release or a structured denial.
 */
async release(request: CapabilityReleaseRequest): Promise<CapabilityReleaseResult>
```

Source: [`packages/capability/capability-controller/src/index.ts`](../../packages/capability/capability-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->
