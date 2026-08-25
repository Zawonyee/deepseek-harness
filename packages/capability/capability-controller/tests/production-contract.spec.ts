import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import CapabilityController from '../src/index.ts'
import type {
  CapabilityControllerPorts,
  CapabilityDefinition,
  CapabilityLease,
  CapabilityLeaseBinding,
  CapabilityLeaseCreate,
  CapabilityLeaseStore,
  Config,
} from '../src/index.ts'

const WEB: CapabilityDefinition = {
  capability: 'web.search',
  provider: 'provider-web',
  risk: 'low',
  approvalRequired: false,
  defaultScope: 'session',
  allowedScopes: ['session'],
}

class MemoryLeases implements CapabilityLeaseStore {
  private sequence = 0
  private readonly rows = new Map<string, CapabilityLease>()

  findActive(query: { sessionId: string; capability: string; scope: CapabilityLease['scope'] }): CapabilityLease | undefined {
    return [...this.rows.values()].find(row => row.status === 'active'
      && row.sessionId === query.sessionId
      && row.capability === query.capability
      && row.scope === query.scope)
  }

  create(input: CapabilityLeaseCreate): CapabilityLease {
    const row: CapabilityLease = {
      leaseId: `production-${++this.sequence}`,
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

function ports(decision: 'allow' | 'approval-required' = 'allow') {
  return {
    registry: { get: capability => capability === WEB.capability ? WEB : undefined },
    policy: {
      evaluate: () => Promise.resolve(decision === 'allow'
        ? { kind: 'allow' }
        : { kind: 'approval-required', reason: 'human approval is required' }),
    },
    leases: new MemoryLeases(),
    adapter: {
      activate: vi.fn(() => Promise.resolve({ toolNames: ['web_search'] })),
      deactivate: vi.fn(() => Promise.resolve()),
    },
    telemetry: { record: vi.fn() },
    now: () => '2026-08-25T00:00:00.000Z',
  } satisfies CapabilityControllerPorts
}

async function runtime(controllerPorts: CapabilityControllerPorts) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CapabilityController, controllerPorts as unknown as Config)
  return ctx
}

describe('production capability-controller contract', () => {
  it('requires every public Lease and Lease creation to carry its lifecycle binding', () => {
    expectTypeOf<CapabilityLease['binding']>().toExtend<CapabilityLeaseBinding>()
    expectTypeOf<CapabilityLeaseCreate['binding']>().toExtend<CapabilityLeaseBinding>()
  })

  it('tells the model to use Registry defaults and retain the grant receipt for release', async () => {
    const ctx = await runtime(ports())
    const request = ctx.tools.schemas().find(tool => tool.name === 'request_capability')
    const release = ctx.tools.schemas().find(tool => tool.name === 'release_capability')
    const requestParameters = request?.parameters as {
      readonly required?: readonly string[]
      readonly properties?: Readonly<Record<string, { readonly description?: string }>>
    } | undefined

    expect(request?.description).toContain(
      'Omit requested_scope to use its configured default; do not guess or probe alternative scopes.',
    )
    expect(request?.description).toContain(
      'Save lease_id from a granted result for release_capability.',
    )
    expect(requestParameters?.required).toEqual(['capability', 'reason'])
    expect(requestParameters?.properties?.requested_scope?.description).toBe(
      'Optional scope override. Omit this field to use the trusted Registry default; do not guess or retry alternative scopes.',
    )
    expect(release?.description).toContain(
      'Pass the exact lease_id returned by request_capability',
    )
  })

  it('validates Loader config and rejects duplicate capability ids', () => {
    const valid = CapabilityController.Config({ capabilities: [{
      capability: 'web.search',
      provider: 'provider-web',
      risk: 'low',
      approvalRequired: false,
      defaultScope: 'session',
      allowedScopes: ['session'],
      idleTtlSec: 600,
    }] })
    const validDefinition = valid.capabilities[0]
    if (validDefinition === undefined) throw new Error('validated capability config is empty')
    expect(validDefinition).toMatchObject({ capability: 'web.search', idleTtlSec: 600 })

    expect(() => CapabilityController.Config({ capabilities: [
      validDefinition,
      { ...validDefinition },
    ] })).toThrow(/duplicate capability/i)

    const { approvalRequired: _approvalRequired, ...missingApproval } = validDefinition
    expect(() => CapabilityController.Config({ capabilities: [missingApproval] } as never))
      .toThrow(/approvalRequired/i)
    expect(() => CapabilityController.Config({ capabilities: [{
      ...validDefinition, capability: ' ',
    }] })).toThrow(/capability.*trimmed|capability.*non-empty/i)
    expect(() => CapabilityController.Config({ capabilities: [{
      ...validDefinition, provider: ' provider-web ',
    }] })).toThrow(/provider.*trimmed/i)
  })

  it('uses the Registry default when requested_scope is omitted from the model tool', async () => {
    const ctx = await runtime(ports())
    const agent = { id: SessionId('production-default-scope') } as Agent
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('production-default-scope-call'),
      name: 'request_capability',
      arguments: { capability: 'web.search', reason: 'Find current public information' },
      agent,
    })

    expect(result.isError).toBe(false)
    expect(result.isError ? undefined : result.value).toMatchObject({
      status: 'granted', capability: 'web.search', scope: 'session', reused: false,
    })
  })

  it('completes approval inside one request and correlates the tool call receipt', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve('allowed-once'))
    await ctx.plugin(CapabilityController, ports('approval-required') as unknown as Config)

    const session = Session.create(SessionId('production-approval'))
    session.append('turn/start', { turn: 1 })
    const agent = { id: session.id, session } as Agent
    const signal = new AbortController().signal
    const result = await ctx.capabilityController.request({
      agent,
      capability: 'web.search',
      reason: 'Approval integration',
      requestedScope: 'session',
      callId: CallId('production-approval-call'),
      signal,
    })

    expect(result).toMatchObject({ status: 'granted', capability: 'web.search', reused: false })
    const asked = session.events.find(event => event.type === 'approval/asked')
    const decided = session.events.find(event => event.type === 'approval/decided')
    expect(asked?.data).toMatchObject({ callId: 'production-approval-call', toolName: 'request_capability' })
    expect(decided?.data).toMatchObject({ id: asked?.data.id, outcome: 'allowed-once' })
  })

  it('uses an ApprovalService mounted beside it by a Loader composition', async () => {
    const root = new Context()
    const controllerPorts = ports('approval-required')
    let controller: CapabilityController | undefined
    let answererCalls = 0

    const composition = async (ctx: Context) => {
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      ctx.on('approval/request', () => {
        answererCalls += 1
        return Promise.resolve('allowed-once')
      })
      await ctx.plugin(CapabilityController, controllerPorts as unknown as Config)
      await ctx.inject(['capabilityController'], (controllerCtx) => {
        controller = controllerCtx.capabilityController
      })
    }
    await root.plugin(composition)

    const session = Session.create(SessionId('production-loader-approval'))
    session.append('turn/start', { turn: 1 })
    const agent = { id: session.id, session } as Agent
    const result = await controller!.request({
      agent,
      capability: 'web.search',
      reason: 'Approval integration through a Loader composition',
      requestedScope: 'session',
      callId: CallId('production-loader-approval-call'),
    })

    expect(result).toMatchObject({ status: 'granted', capability: 'web.search', reused: false })
    expect(answererCalls).toBe(1)
    expect(session.events.find(event => event.type === 'approval/decided')?.data)
      .toMatchObject({ outcome: 'allowed-once' })
  })

  it.each([
    ['rejected', 'approval-rejected', 'capability approval was explicitly rejected by the user'],
    ['cancelled', 'approval-cancelled', 'capability approval was cancelled by the user'],
  ] as const)('fails closed when approval is %s', async (outcome, code, reason) => {
    const controllerPorts = ports('approval-required')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve(outcome))
    await ctx.plugin(CapabilityController, controllerPorts as unknown as Config)
    const session = Session.create(SessionId(`production-approval-${outcome}`))
    session.append('turn/start', { turn: 1 })
    const agent = { id: session.id, session } as Agent

    const result = await ctx.capabilityController.request({
      agent,
      capability: 'web.search',
      reason: `Exercise ${outcome} approval`,
      requestedScope: 'session',
    })

    expect(result).toMatchObject({ status: 'denied', code, reason })
    expect(controllerPorts.adapter.activate).not.toHaveBeenCalled()
  })

  it('fails closed when approval support is unavailable', async () => {
    const controllerPorts = ports('approval-required')
    const ctx = await runtime(controllerPorts)
    const session = Session.create(SessionId('production-approval-unavailable'))
    const agent = { id: session.id, session } as Agent

    const result = await ctx.capabilityController.request({
      agent,
      capability: 'web.search',
      reason: 'Exercise unavailable approval',
      requestedScope: 'session',
    })

    expect(result).toMatchObject({
      status: 'denied',
      code: 'approval-unavailable',
      reason: 'capability approval channel is unavailable',
    })
    expect(controllerPorts.adapter.activate).not.toHaveBeenCalled()
  })
})
