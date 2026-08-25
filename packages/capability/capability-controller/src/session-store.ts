/** Session-log authoritative lease store used by the production Controller. */

import { randomUUID } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type {
  CapabilityLease,
  CapabilityLeaseCreate,
  CapabilityLeaseStore,
} from './index.ts'
import {
  CAPABILITY_CHANGE_VERSION,
  CapabilityLeaseId,
  CapabilityRequestId,
} from './events.ts'
import type {
  CapabilityDenialCode,
  CapabilityExpirationCause,
  CapabilityLeaseId as LeaseId,
  CapabilityRequestId as RequestId,
} from './events.ts'
import {
  applyCapabilityEvent,
  emptyCapabilityFoldState,
} from './fold.ts'
import type {
  CapabilityFoldState,
  CapabilityLeaseRecord,
} from './fold.ts'

interface SessionCache {
  readonly state: CapabilityFoldState
  observed: number
}

function iso(time: number): string {
  return new Date(time).toISOString()
}

function materialize(record: CapabilityLeaseRecord): CapabilityLease {
  return {
    leaseId: record.leaseId,
    sessionId: record.agentId,
    capability: record.capability,
    provider: record.provider,
    risk: record.risk,
    scope: record.scope,
    binding: record.binding,
    ...record.approvalRequestId === undefined
      ? {}
      : { approvalRequestId: record.approvalRequestId },
    reason: record.reason,
    status: record.status,
    toolNames: [...record.toolNames],
    grantedAt: iso(record.grantedAt),
    lastUsedAt: iso(record.lastUsedAt),
    ...record.terminalAt === undefined ? {} : { revokedAt: iso(record.terminalAt) },
    ...record.idleTtlMs === undefined ? {} : { idleTtlSec: record.idleTtlMs / 1000 },
    expireAfterSuccessfulUse: record.revokeAfterSuccess,
  }
}

/**
 * The Session log is the only durable state. Weak caches only avoid replaying
 * an unchanged prefix; the string index contains WeakRefs and is discarded at
 * terminal transitions.
 */
export class SessionCapabilityLeaseStore implements CapabilityLeaseStore {
  private readonly caches = new WeakMap<Session, SessionCache>()
  private readonly sessions = new Map<string, WeakRef<Session>>()

  bind(session: Session): void {
    this.sessions.set(String(session.id), new WeakRef(session))
    this.state(session)
  }

  requestId(): RequestId {
    return CapabilityRequestId(`capability-request-${randomUUID()}`)
  }

  recordRequested(input: {
    readonly session: Session
    readonly requestId: RequestId
    readonly capability: string
    readonly requestedScope: CapabilityLeaseCreate['scope']
    readonly reason: string
  }): void {
    this.bind(input.session)
    input.session.append('capability/change', {
      kind: 'requested',
      version: CAPABILITY_CHANGE_VERSION,
      requestId: input.requestId,
      agentId: String(input.session.id),
      capability: input.capability,
      requestedScope: input.requestedScope,
      reason: input.reason,
    })
  }

  recordDenied(
    session: Session,
    requestId: RequestId,
    code: CapabilityDenialCode,
    reason: string,
    approvalRequestId?: ApprovalRequestId,
  ): void {
    session.append('capability/change', {
      kind: 'denied', version: CAPABILITY_CHANGE_VERSION, requestId, code, reason,
      ...approvalRequestId === undefined ? {} : { approvalRequestId },
    })
  }

  recordReused(session: Session, requestId: RequestId, leaseId: LeaseId): void {
    session.append('capability/change', {
      kind: 'reused', version: CAPABILITY_CHANGE_VERSION, requestId, leaseId,
    })
  }

  recordUsed(input: {
    readonly session: Session
    readonly leaseId: LeaseId
    readonly callId: string
    readonly toolName: string
    readonly outcome: 'succeeded' | 'failed'
  }): void {
    input.session.append('capability/change', {
      kind: 'used', version: CAPABILITY_CHANGE_VERSION,
      leaseId: input.leaseId, callId: input.callId,
      toolName: input.toolName, outcome: input.outcome,
    })
  }

  findActive(query: {
    readonly sessionId: string
    readonly capability: string
    readonly scope: CapabilityLeaseCreate['scope']
  }): CapabilityLease | undefined {
    const session = this.session(query.sessionId)
    if (session === undefined) return undefined
    const record = [...this.state(session).leases.values()].find(row => row.status === 'active'
      && row.agentId === query.sessionId
      && row.capability === query.capability
      && row.scope === query.scope)
    return record === undefined ? undefined : materialize(record)
  }

  create(input: CapabilityLeaseCreate): CapabilityLease {
    if (input.session === undefined || input.requestId === undefined) {
      throw new Error('Session capability lease creation requires session and requestId')
    }
    this.bind(input.session)
    const leaseId = CapabilityLeaseId(`capability-lease-${randomUUID()}`)
    input.session.append('capability/change', {
      kind: 'granted',
      version: CAPABILITY_CHANGE_VERSION,
      requestId: input.requestId,
      leaseId,
      ...input.approvalRequestId === undefined ? {} : { approvalRequestId: input.approvalRequestId },
      provider: input.provider,
      risk: input.risk,
      scope: input.scope,
      binding: input.binding,
      toolNames: [...input.toolNames],
      ...input.idleTtlSec === undefined ? {} : { idleTtlMs: input.idleTtlSec * 1000 },
      revokeAfterSuccess: input.expireAfterSuccessfulUse ?? false,
    })
    const lease = this.get(leaseId, input.session)
    if (lease === undefined) throw new Error('committed capability grant did not materialize')
    return lease
  }

  touch(leaseId: string, _now: string, session?: Session): CapabilityLease {
    return this.required(leaseId, session)
  }

  revoke(leaseId: string, _now: string, session?: Session): CapabilityLease {
    const target = session ?? this.sessionForLease(leaseId)
    if (target === undefined) throw new Error(`missing lease ${leaseId}`)
    target.append('capability/change', {
      kind: 'revoked', version: CAPABILITY_CHANGE_VERSION,
      leaseId: CapabilityLeaseId(leaseId), reason: 'explicit release',
    })
    return this.required(leaseId, target)
  }

  expire(
    leaseId: string,
    session: Session,
    cause: CapabilityExpirationCause,
    reason: string,
  ): CapabilityLease {
    session.append('capability/change', {
      kind: 'expired', version: CAPABILITY_CHANGE_VERSION,
      leaseId: CapabilityLeaseId(leaseId), cause, reason,
    })
    return this.required(leaseId, session)
  }

  get(leaseId: string, session?: Session): CapabilityLease | undefined {
    const target = session ?? this.sessionForLease(leaseId)
    if (target === undefined) return undefined
    const record = this.state(target).leases.get(CapabilityLeaseId(leaseId))
    return record === undefined ? undefined : materialize(record)
  }

  list(session?: Session): readonly CapabilityLease[] {
    if (session !== undefined) return [...this.state(session).leases.values()].map(materialize)
    const seen = new Set<Session>()
    const leases: CapabilityLease[] = []
    for (const ref of this.sessions.values()) {
      const target = ref.deref()
      if (target === undefined || seen.has(target)) continue
      seen.add(target)
      leases.push(...[...this.state(target).leases.values()].map(materialize))
    }
    return leases
  }

  private required(leaseId: string, session?: Session): CapabilityLease {
    const lease = this.get(leaseId, session)
    if (lease === undefined) throw new Error(`missing lease ${leaseId}`)
    return lease
  }

  private session(id: string): Session | undefined {
    const ref = this.sessions.get(id)
    const session = ref?.deref()
    if (ref !== undefined && session === undefined) this.sessions.delete(id)
    return session
  }

  private sessionForLease(leaseId: string): Session | undefined {
    for (const [id, ref] of this.sessions) {
      const session = ref.deref()
      if (session === undefined) {
        this.sessions.delete(id)
        continue
      }
      if (this.state(session).leases.has(CapabilityLeaseId(leaseId))) return session
    }
    return undefined
  }

  private state(session: Session): CapabilityFoldState {
    let cache = this.caches.get(session)
    if (cache === undefined) {
      cache = { state: emptyCapabilityFoldState(), observed: 0 }
      this.caches.set(session, cache)
    }
    for (const event of session.events.slice(cache.observed)) applyCapabilityEvent(cache.state, event)
    cache.observed = session.events.length
    return cache.state
  }
}
