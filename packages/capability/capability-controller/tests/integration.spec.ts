import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import CapabilityController from '../src/index.ts'
import type {
  CapabilityControllerPorts,
  CapabilityDefinition,
  CapabilityLease,
  CapabilityLeaseCreate,
  CapabilityLeaseStore,
  CapabilityRuntimeAdapter,
  CapabilityTelemetryEvent,
  Config,
} from '../src/index.ts'

const REVERSE: CapabilityDefinition = {
  capability: 'text.reverse',
  provider: 'reverse-text',
  risk: 'low',
  approvalRequired: false,
  defaultScope: 'session',
  allowedScopes: ['session'],
}

class MemoryLeases implements CapabilityLeaseStore {
  private next = 0
  private readonly rows = new Map<string, CapabilityLease>()

  findActive(query: { sessionId: string; capability: string; scope: CapabilityLease['scope'] }): CapabilityLease | undefined {
    return [...this.rows.values()].find(row => row.status === 'active'
      && row.sessionId === query.sessionId && row.capability === query.capability && row.scope === query.scope)
  }

  create(input: CapabilityLeaseCreate): CapabilityLease {
    const row: CapabilityLease = {
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
    this.rows.set(row.leaseId, row)
    return row
  }

  touch(leaseId: string, now: string): CapabilityLease {
    const row = this.required(leaseId)
    const next = { ...row, lastUsedAt: now }
    this.rows.set(leaseId, next)
    return next
  }

  revoke(leaseId: string, now: string): CapabilityLease {
    const row = this.required(leaseId)
    const next: CapabilityLease = { ...row, status: 'revoked', revokedAt: now }
    this.rows.set(leaseId, next)
    return next
  }

  get(leaseId: string): CapabilityLease | undefined { return this.rows.get(leaseId) }
  list(): readonly CapabilityLease[] { return [...this.rows.values()] }

  private required(leaseId: string): CapabilityLease {
    const row = this.rows.get(leaseId)
    if (row === undefined) throw new Error(`missing lease ${leaseId}`)
    return row
  }
}

class ScopedReverseAdapter implements CapabilityRuntimeAdapter {
  private readonly disposers = new Map<string, () => void>()

  readonly activate = vi.fn(async (input: Parameters<CapabilityRuntimeAdapter['activate']>[0]) => {
    if (input.definition.provider !== 'reverse-text') throw new Error('unknown fixture provider')
    const key = `${input.agent.id}\0${input.definition.capability}`
    const dispose = input.agent.ctx.tools.register({
      name: 'reverse_text',
      description: 'Reverse a string.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      execute(args) {
        const text = (args as { text?: unknown }).text
        if (typeof text !== 'string') throw new Error('text must be a string')
        return Promise.resolve(text.split('').reverse().join(''))
      },
    })
    this.disposers.set(key, dispose)
    return { toolNames: ['reverse_text'] }
  })

  readonly deactivate = vi.fn(async (input: Parameters<CapabilityRuntimeAdapter['deactivate']>[0]) => {
    const key = `${input.agent.id}\0${input.lease.capability}`
    this.disposers.get(key)?.()
    this.disposers.delete(key)
  })
}

let callSequence = 0

async function call(ctx: Context, agent: Agent, name: string, args: unknown): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({
    callId: CallId(`capability-${++callSequence}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent,
  })
}

function names(ctx: Context, agent?: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name).sort()
}

function valueObject(result: ToolExecutionResult): Record<string, unknown> | undefined {
  if (result.isError || typeof result.value !== 'object' || result.value === null || Array.isArray(result.value)) return undefined
  return result.value
}

async function scopedAgent(ctx: Context, id: string): Promise<{ agent: Agent; scope: Scope }> {
  const agent = { id: SessionId(id) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  return { agent, scope }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const a = await scopedAgent(ctx, 'S-a')
  const b = await scopedAgent(ctx, 'S-b')
  const leases = new MemoryLeases()
  const adapter = new ScopedReverseAdapter()
  const events: CapabilityTelemetryEvent[] = []
  const ports: CapabilityControllerPorts = {
    registry: { get: capability => capability === REVERSE.capability ? REVERSE : undefined },
    policy: { evaluate: () => Promise.resolve({ kind: 'allow' }) },
    leases,
    adapter,
    telemetry: { record: (event) => { events.push(event) } },
    now: () => '2026-08-24T15:00:00.000Z',
  }
  await ctx.plugin(CapabilityController, ports as unknown as Config)
  return { ctx, a, b, leases, adapter, events }
}

describe('Capability Controller scoped tool integration', () => {
  it('rolls back a scoped activation when lease creation fails', async () => {
    const harness = await setup()
    vi.spyOn(harness.leases, 'create').mockImplementation(() => {
      throw new Error('lease store unavailable')
    })

    const requested = await call(harness.ctx, harness.a.agent, 'request_capability', {
      capability: 'text.reverse',
      reason: 'Exercise activation rollback',
      requested_scope: 'session',
    })

    expect(requested.isError).toBe(true)
    expect(harness.adapter.activate).toHaveBeenCalledTimes(1)
    expect(harness.adapter.deactivate).toHaveBeenCalledTimes(1)
    expect(harness.leases.list()).toEqual([])
    expect(names(harness.ctx, harness.a.agent)).not.toContain('reverse_text')
    const after = await call(harness.ctx, harness.a.agent, 'reverse_text', { text: 'orphan' })
    expect(after.error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('keeps A\'s grant out of B schema and execution, and rejects B releasing A\'s lease', async () => {
    const harness = await setup()
    const rawCordis = ['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine']

    expect(names(harness.ctx, harness.a.agent)).toEqual(expect.arrayContaining([
      'request_capability', 'release_capability',
    ]))
    for (const name of rawCordis) expect(names(harness.ctx, harness.a.agent)).not.toContain(name)

    const requested = await call(harness.ctx, harness.a.agent, 'request_capability', {
      capability: 'text.reverse',
      reason: 'Reverse user-provided text',
      requested_scope: 'session',
    })
    const grant = valueObject(requested)
    const leaseId = typeof grant?.lease_id === 'string' ? grant.lease_id : 'missing-grant-lease'

    expect.soft(requested.isError).toBe(false)
    expect.soft(grant).toMatchObject({
      status: 'granted', capability: 'text.reverse', scope: 'session', reused: false,
    })
    expect.soft(names(harness.ctx, harness.a.agent)).toContain('reverse_text')
    expect.soft(names(harness.ctx, harness.b.agent)).not.toContain('reverse_text')
    expect.soft(names(harness.ctx)).not.toContain('reverse_text')

    const ownerCall = await call(harness.ctx, harness.a.agent, 'reverse_text', { text: 'abc' })
    const foreignCall = await call(harness.ctx, harness.b.agent, 'reverse_text', { text: 'abc' })
    expect.soft(ownerCall.isError).toBe(false)
    expect.soft(ownerCall.isError ? undefined : ownerCall.value).toBe('cba')
    expect.soft(foreignCall.error?.info?.code).toBe('UNKNOWN_TOOL')

    const stolenRelease = await call(harness.ctx, harness.b.agent, 'release_capability', { lease_id: leaseId })
    expect.soft(stolenRelease.isError).toBe(false)
    expect.soft(valueObject(stolenRelease)).toEqual({
      status: 'denied',
      lease_id: leaseId,
      code: 'lease-not-owned',
      reason: 'lease belongs to another Session',
    })
    expect.soft(harness.adapter.deactivate).not.toHaveBeenCalled()
    expect.soft(harness.leases.get(leaseId)?.status).toBe('active')
    expect.soft((await call(harness.ctx, harness.a.agent, 'reverse_text', { text: 'still' })).isError).toBe(false)
  })

  it('lets the owner revoke its lease and removes the tool from schema and real execution', async () => {
    const harness = await setup()
    const requested = await call(harness.ctx, harness.a.agent, 'request_capability', {
      capability: 'text.reverse',
      reason: 'Reverse one value',
      requested_scope: 'session',
    })
    const grant = valueObject(requested)
    const leaseId = typeof grant?.lease_id === 'string' ? grant.lease_id : 'missing-grant-lease'

    expect.soft((await call(harness.ctx, harness.a.agent, 'reverse_text', { text: 'before' })).isError).toBe(false)
    const released = await call(harness.ctx, harness.a.agent, 'release_capability', { lease_id: leaseId })

    expect.soft(released.isError).toBe(false)
    expect.soft(valueObject(released)).toEqual({
      status: 'released', lease_id: leaseId, capability: 'text.reverse',
    })
    expect.soft(harness.adapter.deactivate).toHaveBeenCalledTimes(1)
    expect.soft(harness.leases.get(leaseId)?.status).toBe('revoked')
    expect.soft(names(harness.ctx, harness.a.agent)).not.toContain('reverse_text')
    const after = await call(harness.ctx, harness.a.agent, 'reverse_text', { text: 'after' })
    expect.soft(after.error?.info?.code).toBe('UNKNOWN_TOOL')
    expect.soft(harness.events.map(event => event.type)).toEqual([
      'capability_requested', 'capability_granted', 'capability_released',
    ])
  })

  it('treats a different Agent object with the same Session id as non-owner authority', async () => {
    const harness = await setup()
    const alias = await scopedAgent(harness.ctx, String(harness.a.agent.id))
    try {
      expect(alias.agent).not.toBe(harness.a.agent)
      expect(alias.agent.id).toBe(harness.a.agent.id)
      const requested = await call(harness.ctx, harness.a.agent, 'request_capability', {
        capability: 'text.reverse',
        reason: 'Keep this grant on the exact live Agent',
        requested_scope: 'session',
      })
      const grant = valueObject(requested)
      if (typeof grant?.lease_id !== 'string') throw new Error('request did not return a lease_id')

      expect(names(harness.ctx, harness.a.agent)).toContain('reverse_text')
      expect(names(harness.ctx, alias.agent)).not.toContain('reverse_text')
      const foreignCall = await call(harness.ctx, alias.agent, 'reverse_text', { text: 'alias' })
      expect(foreignCall.error?.info?.code).toBe('UNKNOWN_TOOL')

      const stolenRelease = await call(harness.ctx, alias.agent, 'release_capability', {
        lease_id: grant.lease_id,
      })
      expect(stolenRelease.isError).toBe(false)
      expect(valueObject(stolenRelease)).toEqual({
        status: 'denied',
        lease_id: grant.lease_id,
        code: 'lease-not-owned',
        reason: 'lease belongs to another Session',
      })
      expect(harness.adapter.deactivate).not.toHaveBeenCalled()
      expect(harness.leases.get(grant.lease_id)?.status).toBe('active')
      expect((await call(harness.ctx, harness.a.agent, 'reverse_text', { text: 'owner' })).isError).toBe(false)
    } finally {
      await alias.scope.dispose()
    }
  })

  it('denies a second owner revoke without deactivating or releasing twice', async () => {
    const harness = await setup()
    const requested = await call(harness.ctx, harness.a.agent, 'request_capability', {
      capability: 'text.reverse',
      reason: 'Release exactly once',
      requested_scope: 'session',
    })
    const grant = valueObject(requested)
    if (typeof grant?.lease_id !== 'string') throw new Error('request did not return a lease_id')

    const first = await call(harness.ctx, harness.a.agent, 'release_capability', { lease_id: grant.lease_id })
    const second = await call(harness.ctx, harness.a.agent, 'release_capability', { lease_id: grant.lease_id })

    expect(valueObject(first)).toEqual({
      status: 'released', lease_id: grant.lease_id, capability: 'text.reverse',
    })
    expect(second.isError).toBe(false)
    expect(valueObject(second)).toEqual({
      status: 'denied',
      lease_id: grant.lease_id,
      code: 'lease-not-active',
      reason: 'lease is not active',
    })
    expect(harness.adapter.deactivate).toHaveBeenCalledTimes(1)
    expect(harness.leases.get(grant.lease_id)?.status).toBe('revoked')
    expect(harness.events.filter(event => event.type === 'capability_released')).toHaveLength(1)
    expect((await call(harness.ctx, harness.a.agent, 'reverse_text', { text: 'after' })).error?.info?.code)
      .toBe('UNKNOWN_TOOL')
  })

  it('keeps A, B, and global schemas unchanged on a Registry miss', async () => {
    const harness = await setup()
    const before = {
      a: names(harness.ctx, harness.a.agent),
      b: names(harness.ctx, harness.b.agent),
      global: names(harness.ctx),
    }

    const requested = await call(harness.ctx, harness.a.agent, 'request_capability', {
      capability: 'foo.bar',
      reason: 'Unknown capabilities must fail closed',
      requested_scope: 'session',
    })

    expect(requested.isError).toBe(false)
    expect(valueObject(requested)).toEqual({
      status: 'denied',
      capability: 'foo.bar',
      code: 'registry-miss',
      reason: 'capability is not present in the trusted registry',
    })
    expect({
      a: names(harness.ctx, harness.a.agent),
      b: names(harness.ctx, harness.b.agent),
      global: names(harness.ctx),
    }).toEqual(before)
    expect(harness.adapter.activate).not.toHaveBeenCalled()
    expect(harness.leases.list()).toEqual([])
    const unknown = await call(harness.ctx, harness.a.agent, 'foo_bar', {})
    expect(unknown.error?.info?.code).toBe('UNKNOWN_TOOL')
  })
})
