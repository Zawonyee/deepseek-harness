import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import CapabilityController from '../src/index.ts'
import type {
  CapabilityControllerPorts,
  CapabilityDefinition,
  CapabilityLease,
  CapabilityLeaseCreate,
  CapabilityLeaseStore,
  CapabilityRequestResult,
  Config,
} from '../src/index.ts'

const AGENT_A = { id: 'S-a' } as Agent
const NOW = '2026-08-24T15:00:00.000Z'

class MemoryLeases implements CapabilityLeaseStore {
  private next = 0
  private readonly rows = new Map<string, CapabilityLease>()

  findActive(query: { sessionId: string; capability: string; scope: CapabilityLease['scope'] }): CapabilityLease | undefined {
    return [...this.rows.values()].find(lease => lease.status === 'active'
      && lease.sessionId === query.sessionId
      && lease.capability === query.capability
      && lease.scope === query.scope)
  }

  create(input: CapabilityLeaseCreate): CapabilityLease {
    const lease: CapabilityLease = {
      leaseId: `lease-${++this.next}`,
      sessionId: input.sessionId,
      capability: input.capability,
      provider: input.provider,
      risk: input.risk,
      scope: input.scope,
      binding: input.binding,
      reason: input.reason,
      status: 'active',
      toolNames: [...input.toolNames],
      grantedAt: input.now,
      lastUsedAt: input.now,
    }
    this.rows.set(lease.leaseId, lease)
    return lease
  }

  touch(leaseId: string, now: string): CapabilityLease {
    const lease = this.required(leaseId)
    const touched = { ...lease, lastUsedAt: now }
    this.rows.set(leaseId, touched)
    return touched
  }

  revoke(leaseId: string, now: string): CapabilityLease {
    const lease = this.required(leaseId)
    const revoked: CapabilityLease = { ...lease, status: 'revoked', revokedAt: now }
    this.rows.set(leaseId, revoked)
    return revoked
  }

  get(leaseId: string): CapabilityLease | undefined {
    return this.rows.get(leaseId)
  }

  list(): readonly CapabilityLease[] {
    return [...this.rows.values()]
  }

  private required(leaseId: string): CapabilityLease {
    const lease = this.rows.get(leaseId)
    if (lease === undefined) throw new Error(`missing lease ${leaseId}`)
    return lease
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

async function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

function grantOf(result: Settled<CapabilityRequestResult>): Extract<CapabilityRequestResult, { status: 'granted' }> | undefined {
  return result.ok && result.value.status === 'granted' ? result.value : undefined
}

const WEB_SEARCH: CapabilityDefinition = {
  capability: 'web.search',
  provider: 'web-search',
  risk: 'low',
  approvalRequired: false,
  defaultScope: 'session',
  allowedScopes: ['session'],
}

async function setup(definitions: readonly CapabilityDefinition[] = [WEB_SEARCH]) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const leases = new MemoryLeases()
  const events: Parameters<CapabilityControllerPorts['telemetry']['record']>[0][] = []
  const get = vi.fn((capability: string) => definitions.find(row => row.capability === capability))
  const evaluate = vi.fn(() => Promise.resolve({ kind: 'allow' as const }))
  const activate = vi.fn(() => Promise.resolve({ toolNames: ['web_search'] }))
  const deactivate = vi.fn(() => Promise.resolve())
  const record = vi.fn((event: Parameters<CapabilityControllerPorts['telemetry']['record']>[0]) => { events.push(event) })
  const ports: CapabilityControllerPorts = {
    registry: { get },
    policy: { evaluate },
    leases,
    adapter: { activate, deactivate },
    telemetry: { record },
    now: () => NOW,
  }
  await ctx.plugin(CapabilityController, ports as unknown as Config)
  return { ctx, controller: ctx.capabilityController, leases, events, get, evaluate, activate, deactivate }
}

describe('Capability Controller contract', () => {
  it('reuses one active lease for a duplicate request without running the provider twice', async () => {
    const harness = await setup()
    const request = {
      agent: AGENT_A,
      capability: 'web.search',
      reason: 'Need current public information',
      requestedScope: 'session' as const,
    }

    const first = await settled(harness.controller.request(request))
    const second = await settled(harness.controller.request(request))
    const firstGrant = grantOf(first)
    const secondGrant = grantOf(second)

    expect.soft(first.ok).toBe(true)
    expect.soft(firstGrant).toMatchObject({
      status: 'granted', capability: 'web.search', scope: 'session', reused: false,
    })
    expect.soft(second.ok).toBe(true)
    expect.soft(secondGrant).toMatchObject({
      status: 'granted', capability: 'web.search', scope: 'session', reused: true,
    })
    expect.soft(secondGrant?.leaseId).toBe(firstGrant?.leaseId)
    expect.soft(harness.activate).toHaveBeenCalledTimes(1)
    expect.soft(harness.leases.list()).toHaveLength(1)
    expect.soft(harness.events.map(event => event.type)).toEqual([
      'capability_requested',
      'capability_granted',
      'capability_requested',
      'capability_reused',
    ])
  })

  it('denies a Registry miss before policy, activation, or lease creation', async () => {
    const harness = await setup()
    const outcome = await settled(harness.controller.request({
      agent: AGENT_A,
      capability: 'foo.bar',
      reason: 'Try an unknown capability',
      requestedScope: 'session',
    }))
    const denied = outcome.ok && outcome.value.status === 'denied' ? outcome.value : undefined

    expect.soft(outcome.ok).toBe(true)
    expect.soft(denied).toEqual({
      status: 'denied',
      capability: 'foo.bar',
      code: 'registry-miss',
      reason: 'capability is not present in the trusted registry',
    })
    expect.soft(harness.get).toHaveBeenCalledOnce()
    expect.soft(harness.get).toHaveBeenCalledWith('foo.bar')
    expect.soft(harness.evaluate).not.toHaveBeenCalled()
    expect.soft(harness.activate).not.toHaveBeenCalled()
    expect.soft(harness.leases.list()).toEqual([])
    expect.soft(harness.events.map(event => event.type)).toEqual([
      'capability_requested',
      'capability_denied',
    ])
  })

  it('treats a mismatched Registry row as a miss without trusting its provider', async () => {
    const harness = await setup()
    harness.get.mockReturnValue({ ...WEB_SEARCH, capability: 'other.capability' })

    const outcome = await harness.controller.request({
      agent: AGENT_A,
      capability: 'web.search',
      reason: 'Reject a Registry row bound to another capability id',
      requestedScope: 'session',
    })

    expect(outcome).toEqual({
      status: 'denied',
      capability: 'web.search',
      code: 'registry-miss',
      reason: 'capability is not present in the trusted registry',
    })
    expect(harness.evaluate).not.toHaveBeenCalled()
    expect(harness.activate).not.toHaveBeenCalled()
    expect(harness.leases.list()).toEqual([])
  })

  it('coalesces concurrent duplicate requests before the provider activation settles', async () => {
    const harness = await setup()
    let resolveActivation!: (value: { toolNames: string[] }) => void
    const activation = new Promise<{ toolNames: string[] }>((resolve) => { resolveActivation = resolve })
    harness.activate.mockImplementationOnce(() => activation)
    const request = {
      agent: AGENT_A,
      capability: 'web.search',
      reason: 'Need the same current public information concurrently',
      requestedScope: 'session' as const,
    }

    const firstPending = harness.controller.request(request)
    const secondPending = harness.controller.request(request)
    await vi.waitFor(() => { expect(harness.activate).toHaveBeenCalledTimes(1) })
    expect(harness.leases.list()).toEqual([])

    resolveActivation({ toolNames: ['web_search'] })
    const outcomes = await Promise.all([firstPending, secondPending])
    const grants = outcomes.filter((outcome): outcome is Extract<CapabilityRequestResult, { status: 'granted' }> =>
      outcome.status === 'granted')

    expect(grants).toHaveLength(2)
    expect(new Set(grants.map(grant => grant.leaseId))).toHaveLength(1)
    expect(grants.map(grant => grant.reused).sort()).toEqual([false, true])
    expect(harness.activate).toHaveBeenCalledTimes(1)
    expect(harness.leases.list()).toHaveLength(1)
    expect(harness.events.map(event => event.type)).toEqual([
      'capability_requested',
      'capability_requested',
      'capability_granted',
      'capability_reused',
    ])
  })

  it('waits for an in-flight revoke before granting a replacement lease', async () => {
    const harness = await setup()
    const request = {
      agent: AGENT_A,
      capability: 'web.search',
      reason: 'Need current public information',
      requestedScope: 'session' as const,
    }
    const first = await harness.controller.request(request)
    if (first.status !== 'granted') throw new Error('initial request was not granted')

    let finishDeactivation!: () => void
    const deactivation = new Promise<void>((resolve) => { finishDeactivation = resolve })
    harness.deactivate.mockImplementationOnce(() => deactivation)
    const releasePending = harness.controller.release({ agent: AGENT_A, leaseId: first.leaseId })
    await vi.waitFor(() => { expect(harness.deactivate).toHaveBeenCalledTimes(1) })

    const replacementPending = harness.controller.request({
      ...request,
      reason: 'Need the capability again while its prior lease is revoking',
    })
    const stateBeforeRevokeSettles = await Promise.race([
      replacementPending.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => setTimeout(() => { resolve('pending') }, 0)),
    ])
    finishDeactivation()
    const [released, replacement] = await Promise.all([releasePending, replacementPending])

    expect(stateBeforeRevokeSettles).toBe('pending')
    expect(released).toEqual({
      status: 'released', leaseId: first.leaseId, capability: 'web.search',
    })
    expect(replacement).toMatchObject({
      status: 'granted', capability: 'web.search', scope: 'session', reused: false,
    })
    if (replacement.status !== 'granted') throw new Error('replacement request was not granted')
    expect(replacement.leaseId).not.toBe(first.leaseId)
    expect(harness.activate).toHaveBeenCalledTimes(2)
    expect(harness.leases.get(first.leaseId)?.status).toBe('revoked')
    expect(harness.leases.get(replacement.leaseId)?.status).toBe('active')
  })

  it('coalesces concurrent owner revokes into one terminal release', async () => {
    const harness = await setup()
    const granted = await harness.controller.request({
      agent: AGENT_A,
      capability: 'web.search',
      reason: 'Release this capability once',
      requestedScope: 'session',
    })
    if (granted.status !== 'granted') throw new Error('initial request was not granted')

    let finishDeactivation!: () => void
    const deactivation = new Promise<void>((resolve) => { finishDeactivation = resolve })
    harness.deactivate.mockImplementationOnce(() => deactivation)
    const firstPending = harness.controller.release({ agent: AGENT_A, leaseId: granted.leaseId })
    await vi.waitFor(() => { expect(harness.deactivate).toHaveBeenCalledTimes(1) })
    const secondPending = harness.controller.release({ agent: AGENT_A, leaseId: granted.leaseId })

    finishDeactivation()
    const outcomes = await Promise.all([firstPending, secondPending])

    expect(outcomes).toEqual([
      { status: 'released', leaseId: granted.leaseId, capability: 'web.search' },
      { status: 'released', leaseId: granted.leaseId, capability: 'web.search' },
    ])
    expect(harness.deactivate).toHaveBeenCalledTimes(1)
    expect(harness.leases.get(granted.leaseId)?.status).toBe('revoked')
    expect(harness.events.filter(event => event.type === 'capability_released')).toHaveLength(1)
  })
})
