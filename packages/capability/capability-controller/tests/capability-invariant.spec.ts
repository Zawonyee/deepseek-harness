import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import * as CapabilityInvariant from '../src/invariant.ts'
import {
  CapabilityLeaseId,
  CapabilityRequestId,
} from '../src/events.ts'
import type { CapabilityChange } from '../src/events.ts'

const REQUEST = CapabilityRequestId('request-invariant')
const LEASE = CapabilityLeaseId('lease-invariant')

function requested(): Extract<CapabilityChange, { kind: 'requested' }> {
  return {
    kind: 'requested', version: 1, requestId: REQUEST,
    agentId: 'invariant-agent', capability: 'web.search', requestedScope: 'session',
    reason: 'Test the durable capability stream',
  }
}

function granted(): Extract<CapabilityChange, { kind: 'granted' }> {
  return {
    kind: 'granted', version: 1, requestId: REQUEST, leaseId: LEASE,
    provider: 'web-search', risk: 'low', scope: 'session', binding: { kind: 'session' },
    toolNames: ['web_search'], revokeAfterSuccess: false,
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(CapabilityInvariant)
  return ctx
}

describe('capability/change invariant', () => {
  it('accepts a canonical lifecycle and leaves the event required on read', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('capability-invariant-valid'))
    session.append('turn/start', { turn: 1 })
    const first = session.append('capability/change', requested())
    session.append('capability/change', granted())
    session.append('capability/change', {
      kind: 'used', version: 1, leaseId: LEASE,
      callId: 'call-invariant', toolName: 'web_search', outcome: 'succeeded',
    })
    session.append('capability/change', {
      kind: 'expired', version: 1, leaseId: LEASE,
      cause: 'agent-disposed', reason: 'The exact Agent was disposed',
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect('ignorable' in first).toBe(false)
  })

  it('rejects malformed and illegal transitions before commit and keeps the fold reusable', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('capability-invariant-invalid'))
    session.append('capability/change', requested())
    const seq = session.seq
    expect(() => session.append('capability/change', { ...granted(), extra: true } as never))
      .toThrow(expect.objectContaining<Partial<InvariantError>>({
        code: 'INVARIANT',
        packageName: '@deepseek-ai/dsh-capability-controller',
      }))
    expect(session.seq).toBe(seq)
    expect(() => session.append('capability/change', granted())).not.toThrow()
    expect(() => session.append('capability/change', granted())).toThrow(/requires a pending request/)
  })

  it('reconstructs an existing stream before validating its next event', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('capability-invariant-late-load'))
    session.append('capability/change', requested())
    session.append('capability/change', granted())

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(CapabilityInvariant)
    expect(() => session.append('capability/change', {
      kind: 'revoked', version: 1, leaseId: LEASE, reason: 'Explicit release after invariant load',
    })).not.toThrow()
    expect(() => session.append('capability/change', {
      kind: 'used', version: 1, leaseId: LEASE,
      callId: 'late-use', toolName: 'web_search', outcome: 'failed',
    })).toThrow(/requires an active lease/)
  })

  it('removes pre-commit validation when the invariant companion unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(CapabilityInvariant)
    const session = ctx.sessions.create(SessionId('capability-invariant-hmr'))
    await fiber.dispose()

    expect(() => session.append('capability/change', {
      kind: 'revoked', version: 1, leaseId: LEASE, reason: 'No matching lease',
    })).not.toThrow()
  })
})
