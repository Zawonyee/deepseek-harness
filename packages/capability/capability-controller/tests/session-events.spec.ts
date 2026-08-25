import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import { describe, expect, it } from 'vitest'
import {
  CapabilityLeaseId,
  CapabilityRequestId,
  decodeCapabilityChange,
} from '../src/events.ts'
import type { CapabilityChange } from '../src/events.ts'
import {
  applyCapabilityChange,
  applyCapabilityEvent,
  emptyCapabilityFoldState,
  foldCapabilities,
} from '../src/fold.ts'

const REQUEST_1 = CapabilityRequestId('request-1')
const REQUEST_2 = CapabilityRequestId('request-2')
const LEASE_1 = CapabilityLeaseId('lease-1')
const LEASE_2 = CapabilityLeaseId('lease-2')
const APPROVAL_1 = 'approval-1' as ApprovalRequestId

function requested(
  requestId = REQUEST_1,
  overrides: Partial<Extract<CapabilityChange, { kind: 'requested' }>> = {},
): Extract<CapabilityChange, { kind: 'requested' }> {
  return {
    kind: 'requested',
    version: 1,
    requestId,
    agentId: 'session-a',
    capability: 'web.search',
    requestedScope: 'session',
    reason: 'Find current public information',
    ...overrides,
  }
}

function granted(
  overrides: Partial<Extract<CapabilityChange, { kind: 'granted' }>> = {},
): Extract<CapabilityChange, { kind: 'granted' }> {
  return {
    kind: 'granted',
    version: 1,
    requestId: REQUEST_1,
    leaseId: LEASE_1,
    provider: 'web-search',
    risk: 'low',
    scope: 'session',
    binding: { kind: 'session' },
    toolNames: ['web_search'],
    revokeAfterSuccess: false,
    ...overrides,
  }
}

function event(seq: number, time: number, data: CapabilityChange): SessionEvent<'capability/change'> {
  return { type: 'capability/change', seq, time, data }
}

describe('capability/change durable vocabulary and fold', () => {
  it('brands opaque ids and folds request, use, reuse, and terminal lease state incrementally', () => {
    expect(CapabilityRequestId('request-1')).toBe('request-1')
    expect(CapabilityLeaseId('lease-1')).toBe('lease-1')

    const changes: SessionEvent<'capability/change'>[] = [
      event(0, 10, requested()),
      event(1, 20, granted({ approvalRequestId: APPROVAL_1 })),
      event(2, 30, {
        kind: 'used', version: 1, leaseId: LEASE_1,
        callId: 'call-1', toolName: 'web_search', outcome: 'succeeded',
      }),
      event(3, 40, requested(REQUEST_2, { reason: 'Reuse the same search capability' })),
      event(4, 50, { kind: 'reused', version: 1, requestId: REQUEST_2, leaseId: LEASE_1 }),
      event(5, 60, {
        kind: 'revoked', version: 1, leaseId: LEASE_1,
        reason: 'The caller explicitly released the capability',
      }),
    ]

    const state = emptyCapabilityFoldState()
    for (const item of changes) applyCapabilityEvent(state, item)
    expect(state.requests.get(REQUEST_1)).toMatchObject({
      status: 'granted-new', leaseId: LEASE_1, approvalRequestId: APPROVAL_1,
      requestedAt: 10, resolvedAt: 20,
    })
    expect(state.requests.get(REQUEST_2)).toMatchObject({
      status: 'granted-reused', leaseId: LEASE_1, requestedAt: 40, resolvedAt: 50,
    })
    expect(state.leases.get(LEASE_1)).toMatchObject({
      status: 'revoked', grantedAt: 20, lastUsedAt: 30, terminalAt: 60,
      approvalRequestId: APPROVAL_1, useCount: 1,
      terminalReason: 'The caller explicitly released the capability',
    })

    const folded = foldCapabilities(changes)
    expect(folded.requests).toHaveLength(2)
    expect(folded.leases).toEqual([
      expect.objectContaining({ leaseId: LEASE_1, status: 'revoked', toolNames: ['web_search'] }),
    ])
    expect(folded.leases[0]?.toolNames).not.toBe(state.leases.get(LEASE_1)?.toolNames)
  })

  it('strictly decodes canonical variants, task bindings, versions, and exact fields', () => {
    expect(decodeCapabilityChange(granted({
      scope: 'task',
      binding: { kind: 'task', goalId: 'goal-1' },
      approvalRequestId: APPROVAL_1,
    }))).toMatchObject({
      scope: 'task', binding: { kind: 'task', goalId: 'goal-1' }, approvalRequestId: APPROVAL_1,
    })
    expect(decodeCapabilityChange({ kind: 'another-domain' })).toBeUndefined()
    expect(() => decodeCapabilityChange({ ...requested(), version: 2 })).toThrow(/unsupported capability change version/)
    expect(() => decodeCapabilityChange({ ...requested(), extra: true })).toThrow(/must have exactly/)
    expect(() => decodeCapabilityChange(granted({ toolNames: ['web_search', 'web_search'] })))
      .toThrow(/unique tool names/)
    expect(() => decodeCapabilityChange(granted({
      scope: 'task', binding: { kind: 'task', goalId: '' },
    }))).toThrow(/goalId must be a non-empty string/)
  })

  it('fails closed for malformed fields in every persisted variant', () => {
    const invalid: Array<[unknown, RegExp]> = [
      [null, /never/],
      [{}, /never/],
      [{ kind: 'reused', version: 1, requestId: REQUEST_1 }, /must have exactly/],
      [{ ...requested(), reason: 1 }, /reason must be a non-empty normalized string/],
      [{ ...requested(), reason: '' }, /reason must be a non-empty normalized string/],
      [{ ...requested(), reason: ' padded ' }, /reason must be a non-empty normalized string/],
      [{ ...requested(), requestedScope: null }, /scope is invalid/],
      [{ ...requested(), requestedScope: 'forever' }, /scope is invalid/],
      [{
        kind: 'denied', version: 1, requestId: REQUEST_1, code: 1, reason: 'Denied',
      }, /code is invalid/],
      [{
        kind: 'denied', version: 1, requestId: REQUEST_1, code: 'other', reason: 'Denied',
      }, /code is invalid/],
      [{ ...granted(), risk: 1 }, /risk is invalid/],
      [{ ...granted(), risk: 'extreme' }, /risk is invalid/],
      [{ ...granted(), revokeAfterSuccess: 'yes' }, /revokeAfterSuccess must be boolean/],
      [{ ...granted(), idleTtlMs: '600' }, /idleTtlMs must be a positive safe integer/],
      [{ ...granted(), idleTtlMs: 1.5 }, /idleTtlMs must be a positive safe integer/],
      [{ ...granted(), idleTtlMs: 0 }, /idleTtlMs must be a positive safe integer/],
      [{ ...granted(), binding: null }, /binding must be a tagged record/],
      [{ ...granted(), binding: { kind: 1 } }, /binding must be a tagged record/],
      [{ ...granted(), binding: { kind: 'unknown' } }, /binding kind is invalid/],
      [{ ...granted(), toolNames: null }, /at least one tool name/],
      [{ ...granted(), toolNames: [] }, /at least one tool name/],
      [{ ...granted(), toolNames: [''] }, /toolNames\[0\] must be a non-empty normalized string/],
      [{ ...granted(), approvalRequestId: '' }, /approvalRequestId must be a non-empty normalized string/],
      [{ ...granted(), extra: true }, /and optional .*idleTtlMs fields/],
      [{
        kind: 'denied', version: 1, requestId: REQUEST_1,
        approvalRequestId: '', code: 'approval-rejected', reason: 'Denied',
      }, /approvalRequestId must be a non-empty normalized string/],
      [{
        kind: 'used', version: 1, leaseId: LEASE_1,
        callId: 'call', toolName: 'web_search', outcome: 1,
      }, /outcome is invalid/],
      [{
        kind: 'used', version: 1, leaseId: LEASE_1,
        callId: 'call', toolName: 'web_search', outcome: 'unknown',
      }, /outcome is invalid/],
      [{
        kind: 'expired', version: 1, leaseId: LEASE_1,
        cause: 1, reason: 'Expired',
      }, /cause is invalid/],
      [{
        kind: 'expired', version: 1, leaseId: LEASE_1,
        cause: 'unknown', reason: 'Expired',
      }, /cause is invalid/],
    ]
    for (const [value, message] of invalid) {
      if (value === null || (typeof value === 'object' && value !== null && !('kind' in value))) {
        expect(decodeCapabilityChange(value)).toBeUndefined()
      } else {
        expect(() => decodeCapabilityChange(value)).toThrow(message)
      }
    }

    expect(decodeCapabilityChange(granted({
      scope: 'turn', binding: { kind: 'turn', turn: 3 }, idleTtlMs: 1,
    }))).toMatchObject({ binding: { kind: 'turn', turn: 3 }, idleTtlMs: 1 })
    expect(decodeCapabilityChange(granted({
      scope: 'persistent', binding: { kind: 'persistent' },
    }))).toMatchObject({ binding: { kind: 'persistent' } })
  })

  it('rejects illegal request and lease transitions without mutating the accepted prefix', () => {
    const state = emptyCapabilityFoldState()
    expect(() => {
      applyCapabilityEvent(state, event(0, 1, {
        kind: 'denied', version: 1, requestId: REQUEST_1,
        code: 'registry-miss', reason: 'Unknown capability',
      }))
    }).toThrow(/requires a pending request/)

    applyCapabilityEvent(state, event(0, 1, requested()))
    expect(() => { applyCapabilityEvent(state, event(1, 2, requested())) })
      .toThrow(/repeats request id/)
    expect(() => {
      applyCapabilityEvent(state, event(1, 2, granted({
        scope: 'task', binding: { kind: 'task', goalId: 'goal-1' },
      })))
    }).toThrow(/does not match requested scope/)
    expect(state.requests.get(REQUEST_1)?.status).toBe('requested')

    applyCapabilityEvent(state, event(1, 3, granted()))
    expect(() => {
      applyCapabilityEvent(state, event(2, 4, {
        kind: 'used', version: 1, leaseId: LEASE_1,
        callId: 'wrong-tool', toolName: 'shell_execute', outcome: 'failed',
      }))
    }).toThrow(/not owned by lease/)
    applyCapabilityEvent(state, event(2, 5, {
      kind: 'expired', version: 1, leaseId: LEASE_1,
      cause: 'idle-ttl', reason: 'Idle deadline elapsed',
    }))
    expect(() => {
      applyCapabilityEvent(state, event(3, 6, {
        kind: 'revoked', version: 1, leaseId: LEASE_1, reason: 'Release again',
      }))
    }).toThrow(/requires an active lease/)

    applyCapabilityEvent(state, event(3, 7, requested(REQUEST_2)))
    expect(() => {
      applyCapabilityEvent(state, event(4, 8, {
        kind: 'reused', version: 1, requestId: REQUEST_2, leaseId: LEASE_1,
      }))
    }).toThrow(/requires an active lease/)
  })

  it('rejects a second active Lease for the same exact Agent and capability', () => {
    const state = emptyCapabilityFoldState()
    applyCapabilityChange(state, requested(), 1)
    applyCapabilityChange(state, granted(), 2)
    applyCapabilityChange(state, requested(REQUEST_2, { reason: 'Attempt a duplicate activation' }), 3)

    expect(() => {
      applyCapabilityChange(state, granted({ requestId: REQUEST_2, leaseId: LEASE_2 }), 4)
    }).toThrow(/active lease.*same agent.*capability|already has an active lease/i)
    expect(state.requests.get(REQUEST_2)?.status).toBe('requested')
    expect(state.leases.has(LEASE_2)).toBe(false)
  })

  it('covers binding projections, duplicate ids and calls, and mismatched reuse authority', () => {
    const changes: SessionEvent<'capability/change'>[] = []
    const variants = [
      ['turn', { kind: 'turn', turn: 7 }],
      ['task', { kind: 'task', goalId: 'goal-fold' }],
      ['session', { kind: 'session' }],
      ['persistent', { kind: 'persistent' }],
    ] as const
    for (const [index, [scope, binding]] of variants.entries()) {
      const request = CapabilityRequestId(`binding-request-${index}`)
      const lease = CapabilityLeaseId(`binding-lease-${index}`)
      changes.push(event(index * 2, index * 2, requested(request, {
        agentId: `binding-agent-${index}`,
        requestedScope: scope,
      })))
      changes.push(event(index * 2 + 1, index * 2 + 1, granted({
        requestId: request,
        leaseId: lease,
        scope,
        binding,
        ...(index === 0 ? { idleTtlMs: 100 } : {}),
      })))
    }
    const projection = foldCapabilities(changes)
    expect(projection.leases.map(lease => lease.binding.kind)).toEqual([
      'turn', 'task', 'session', 'persistent',
    ])
    expect(projection.leases[0]).toMatchObject({ idleTtlMs: 100 })

    const active = emptyCapabilityFoldState()
    applyCapabilityChange(active, requested(), 1)
    applyCapabilityChange(active, granted(), 2)
    applyCapabilityChange(active, requested(REQUEST_2), 3)
    expect(() => { applyCapabilityChange(active, granted({ requestId: REQUEST_2 }), 4) })
      .toThrow(/repeats lease id/)
    expect(() => {
      applyCapabilityChange(active, {
        kind: 'used', version: 1, leaseId: LEASE_1,
        callId: 'same-call', toolName: 'web_search', outcome: 'failed',
      }, 5)
    }).not.toThrow()
    expect(() => {
      applyCapabilityChange(active, {
        kind: 'used', version: 1, leaseId: LEASE_1,
        callId: 'same-call', toolName: 'web_search', outcome: 'succeeded',
      }, 6)
    }).toThrow(/repeats call/)

    expect(() => { applyCapabilityChange(emptyCapabilityFoldState(), requested(), -1) })
      .toThrow(/event time must be a non-negative safe integer/)
    expect(() => { applyCapabilityChange(emptyCapabilityFoldState(), requested(), Number.NaN) })
      .toThrow(/event time must be a non-negative safe integer/)

    const bindingMismatch = emptyCapabilityFoldState()
    applyCapabilityChange(bindingMismatch, requested(), 1)
    expect(() => {
      applyCapabilityChange(bindingMismatch, granted({ binding: { kind: 'persistent' } }), 2)
    })
      .toThrow(/binding does not match lease scope/)

    const mismatch = (overrides: Partial<Extract<CapabilityChange, { kind: 'requested' }>>): void => {
      const state = emptyCapabilityFoldState()
      applyCapabilityChange(state, requested(), 1)
      applyCapabilityChange(state, granted(), 2)
      applyCapabilityChange(state, requested(REQUEST_2, overrides), 3)
      expect(() => {
        applyCapabilityChange(state, {
          kind: 'reused', version: 1, requestId: REQUEST_2, leaseId: LEASE_1,
        }, 4)
      }).toThrow(/does not match the pending request/)
    }
    mismatch({ agentId: 'another-agent' })
    mismatch({ capability: 'other.capability' })
    mismatch({ requestedScope: 'persistent' })

    const unrelated = emptyCapabilityFoldState()
    applyCapabilityEvent(unrelated, {
      type: 'turn/start', seq: 0, time: 0, data: { turn: 1 },
    })
    expect(unrelated.requests.size).toBe(0)
    expect(() => {
      applyCapabilityEvent(unrelated, {
        type: 'capability/change', seq: 1, time: 1, data: { kind: 'another-domain' },
      } as unknown as SessionEvent)
    }).toThrow(/invalid kind/)
  })
})
