/** Incremental replay fold for durable Capability Controller transitions. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type {
  CapabilityChange,
  CapabilityDenialCode,
  CapabilityExpirationCause,
  CapabilityLeaseBinding,
  CapabilityLeaseId,
  CapabilityRequestId,
} from './events.ts'
import { decodeCapabilityChange } from './events.ts'
import type { CapabilityLeaseScope, CapabilityRisk } from './index.ts'

interface CapabilityRequestBase {
  readonly requestId: CapabilityRequestId
  readonly agentId: string
  readonly capability: string
  readonly requestedScope: CapabilityLeaseScope
  readonly reason: string
  readonly requestedAt: number
}

/** Materialized outcome of one durable capability request. */
export type CapabilityRequestRecord = CapabilityRequestBase & (
  | { readonly status: 'requested' }
  | {
    readonly status: 'denied'
    readonly approvalRequestId?: ApprovalRequestId
    readonly code: CapabilityDenialCode
    readonly denialReason: string
    readonly resolvedAt: number
  }
  | {
    readonly status: 'granted-new' | 'granted-reused'
    readonly approvalRequestId?: ApprovalRequestId
    readonly leaseId: CapabilityLeaseId
    readonly resolvedAt: number
  }
)

/** Materialized lifecycle of one durable capability lease. */
export interface CapabilityLeaseRecord {
  readonly leaseId: CapabilityLeaseId
  readonly requestId: CapabilityRequestId
  readonly approvalRequestId?: ApprovalRequestId
  readonly agentId: string
  readonly capability: string
  readonly provider: string
  readonly risk: CapabilityRisk
  readonly scope: CapabilityLeaseScope
  readonly binding: CapabilityLeaseBinding
  readonly reason: string
  readonly toolNames: readonly string[]
  readonly idleTtlMs?: number
  readonly revokeAfterSuccess: boolean
  readonly status: 'active' | 'revoked' | 'expired'
  readonly grantedAt: number
  readonly lastUsedAt: number
  readonly useCount: number
  readonly terminalAt?: number
  readonly terminalReason?: string
  readonly expirationCause?: CapabilityExpirationCause
}

/** Mutable accumulator used by incremental replay and the invariant companion. */
export interface CapabilityFoldState {
  readonly requests: Map<CapabilityRequestId, CapabilityRequestRecord>
  readonly leases: Map<CapabilityLeaseId, CapabilityLeaseRecord>
  readonly uses: Set<string>
}

/** Detached current projection returned by a complete replay fold. */
export interface FoldedCapabilities {
  readonly requests: readonly CapabilityRequestRecord[]
  readonly leases: readonly CapabilityLeaseRecord[]
}

/**
 * Create an empty mutable capability fold.
 * @returns state containing no requests, leases, or recorded uses.
 */
export function emptyCapabilityFoldState(): CapabilityFoldState {
  return { requests: new Map(), leases: new Map(), uses: new Set() }
}

function eventTime(time: number): number {
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new Error('capability change event time must be a non-negative safe integer')
  }
  return time
}

function pendingRequest(state: CapabilityFoldState, id: CapabilityRequestId): CapabilityRequestRecord {
  const request = state.requests.get(id)
  if (request === undefined || request.status !== 'requested') {
    throw new Error(`capability change requires a pending request ${JSON.stringify(id)}`)
  }
  return request
}

function activeLease(state: CapabilityFoldState, id: CapabilityLeaseId): CapabilityLeaseRecord {
  const lease = state.leases.get(id)
  if (lease === undefined || lease.status !== 'active') {
    throw new Error(`capability change requires an active lease ${JSON.stringify(id)}`)
  }
  return lease
}

function bindingScope(binding: CapabilityLeaseBinding): CapabilityLeaseScope {
  return binding.kind
}

function useKey(leaseId: CapabilityLeaseId, callId: string): string {
  return JSON.stringify([leaseId, callId])
}

/**
 * Validate and apply one decoded transition.
 * @param state - mutable preceding request and lease state.
 * @param change - decoded capability transition.
 * @param time - authoritative Session event envelope time.
 */
export function applyCapabilityChange(
  state: CapabilityFoldState,
  change: CapabilityChange,
  time: number,
): void {
  const at = eventTime(time)
  switch (change.kind) {
    case 'requested':
      if (state.requests.has(change.requestId)) {
        throw new Error(`capability requested change repeats request id ${JSON.stringify(change.requestId)}`)
      }
      state.requests.set(change.requestId, {
        requestId: change.requestId,
        agentId: change.agentId,
        capability: change.capability,
        requestedScope: change.requestedScope,
        reason: change.reason,
        requestedAt: at,
        status: 'requested',
      })
      return
    case 'denied': {
      const request = pendingRequest(state, change.requestId)
      state.requests.set(change.requestId, {
        ...request,
        status: 'denied',
        ...change.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: change.approvalRequestId },
        code: change.code,
        denialReason: change.reason,
        resolvedAt: at,
      })
      return
    }
    case 'granted': {
      const request = pendingRequest(state, change.requestId)
      if (state.leases.has(change.leaseId)) {
        throw new Error(`capability granted change repeats lease id ${JSON.stringify(change.leaseId)}`)
      }
      const conflicting = [...state.leases.values()].find(lease => lease.status === 'active'
        && lease.agentId === request.agentId
        && lease.capability === request.capability)
      if (conflicting !== undefined) {
        throw new Error(`capability ${JSON.stringify(request.capability)} already has an active Lease for the same Agent ${JSON.stringify(request.agentId)}`)
      }
      if (request.requestedScope !== change.scope) {
        throw new Error('capability granted scope does not match requested scope')
      }
      if (bindingScope(change.binding) !== change.scope) {
        throw new Error('capability granted binding does not match lease scope')
      }
      state.requests.set(change.requestId, {
        ...request,
        status: 'granted-new',
        ...change.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: change.approvalRequestId },
        leaseId: change.leaseId,
        resolvedAt: at,
      })
      state.leases.set(change.leaseId, {
        leaseId: change.leaseId,
        requestId: change.requestId,
        ...change.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: change.approvalRequestId },
        agentId: request.agentId,
        capability: request.capability,
        provider: change.provider,
        risk: change.risk,
        scope: change.scope,
        binding: change.binding,
        reason: request.reason,
        toolNames: [...change.toolNames],
        ...change.idleTtlMs === undefined ? {} : { idleTtlMs: change.idleTtlMs },
        revokeAfterSuccess: change.revokeAfterSuccess,
        status: 'active',
        grantedAt: at,
        lastUsedAt: at,
        useCount: 0,
      })
      return
    }
    case 'reused': {
      const request = pendingRequest(state, change.requestId)
      const lease = activeLease(state, change.leaseId)
      if (request.agentId !== lease.agentId
        || request.capability !== lease.capability
        || request.requestedScope !== lease.scope) {
        throw new Error('capability reused lease does not match the pending request')
      }
      state.requests.set(change.requestId, {
        ...request,
        status: 'granted-reused',
        leaseId: change.leaseId,
        resolvedAt: at,
      })
      return
    }
    case 'used': {
      const lease = activeLease(state, change.leaseId)
      if (!lease.toolNames.includes(change.toolName)) {
        throw new Error(`capability used tool ${JSON.stringify(change.toolName)} is not owned by lease ${JSON.stringify(change.leaseId)}`)
      }
      const key = useKey(change.leaseId, change.callId)
      if (state.uses.has(key)) {
        throw new Error(`capability used change repeats call ${JSON.stringify(change.callId)} for lease ${JSON.stringify(change.leaseId)}`)
      }
      state.uses.add(key)
      state.leases.set(change.leaseId, {
        ...lease,
        lastUsedAt: at,
        useCount: lease.useCount + 1,
      })
      return
    }
    case 'revoked': {
      const lease = activeLease(state, change.leaseId)
      state.leases.set(change.leaseId, {
        ...lease,
        status: 'revoked',
        terminalAt: at,
        terminalReason: change.reason,
      })
      return
    }
    case 'expired': {
      const lease = activeLease(state, change.leaseId)
      state.leases.set(change.leaseId, {
        ...lease,
        status: 'expired',
        terminalAt: at,
        terminalReason: change.reason,
        expirationCause: change.cause,
      })
      return
    }
    /* v8 ignore next 3 -- CapabilityChange is a closed discriminated union. */
    default:
      change satisfies never
      throw new Error('unknown capability change')
  }
}

/**
 * Decode and apply one Session event when it belongs to this domain.
 * @param state - mutable fold accumulator.
 * @param event - next Session event in sequence order.
 */
export function applyCapabilityEvent(state: CapabilityFoldState, event: SessionEvent): void {
  if (event.type !== 'capability/change') return
  const change = decodeCapabilityChange(event.data)
  if (change === undefined) {
    throw new Error(`capability change at session event ${event.seq} has an invalid kind`)
  }
  applyCapabilityChange(state, change, event.time)
}

function copyRequest(request: CapabilityRequestRecord): CapabilityRequestRecord {
  return { ...request }
}

function copyBinding(binding: CapabilityLeaseBinding): CapabilityLeaseBinding {
  switch (binding.kind) {
    case 'turn': return { kind: binding.kind, turn: binding.turn }
    case 'task': return { kind: binding.kind, goalId: binding.goalId }
    case 'session': return { kind: binding.kind }
    case 'persistent': return { kind: binding.kind }
    /* v8 ignore next 3 -- CapabilityLeaseBinding is a closed discriminated union. */
    default:
      binding satisfies never
      throw new Error('unknown capability binding')
  }
}

function copyLease(lease: CapabilityLeaseRecord): CapabilityLeaseRecord {
  return { ...lease, binding: copyBinding(lease.binding), toolNames: [...lease.toolNames] }
}

/**
 * Replay a complete Session event sequence into detached request and lease rows.
 * @param events - Session events in sequence order.
 * @returns a detached projection in first-seen request and lease order.
 */
export function foldCapabilities(events: readonly SessionEvent[]): FoldedCapabilities {
  const state = emptyCapabilityFoldState()
  for (const event of events) applyCapabilityEvent(state, event)
  return {
    requests: [...state.requests.values()].map(copyRequest),
    leases: [...state.leases.values()].map(copyLease),
  }
}
