import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'
import CapabilityController from '../src/index.ts'

async function scopedAgent(ctx: Context, rawId: string): Promise<{ agent: Agent; scope: Scope }> {
  const session = Session.create(SessionId(rawId))
  const agent = { id: session.id, session } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  return { agent, scope }
}

function toolNames(ctx: Context, agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name).sort()
}

describe('Session-backed production controller', () => {
  it.each([
    ['allowed-once', 'granted'],
    ['rejected', 'denied'],
  ] as const)('durably correlates an %s approval receipt with the capability %s resolution', async (outcome, resolutionKind) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve(outcome))
    await ctx.plugin(CapabilityController, { capabilities: [{
      capability: 'text.approved',
      provider: 'fixture-approved',
      risk: 'high',
      approvalRequired: true,
      defaultScope: 'session',
      allowedScopes: ['session'],
    }] })
    ctx.capabilityController.registerProvider({
      name: 'fixture-approved',
      toolNames: ['approved_text'],
      promptSectionNames: [],
      plugin: Object.assign((inner: Context) => inner.tools.register(defineTool({
        name: 'approved_text',
        description: 'Return one approved value.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: () => Promise.resolve('approved'),
      })), { inject: ['tools'] }),
    })
    const { agent } = await scopedAgent(ctx, `session-controller-approval-${outcome}`)
    agent.session.append('turn/start', { turn: 1 })

    await ctx.capabilityController.request({
      agent,
      capability: 'text.approved',
      reason: `Exercise ${outcome} receipt correlation`,
      callId: CallId(`capability-${outcome}`),
    })

    const asked = agent.session.events.find(event => event.type === 'approval/asked')
    const resolution = agent.session.events.find(event => event.type === 'capability/change'
      && event.data.kind === resolutionKind)
    expect(asked?.data.id).toBeDefined()
    expect(resolution?.data).toMatchObject({ approvalRequestId: asked?.data.id })
  })

  it('fails startup when a raw Cordis control Tool is already installed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(defineTool({
      name: 'cordis_run',
      description: 'Forbidden raw dynamic execution fixture.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve('forbidden'),
    }))

    await expect(ctx.plugin(CapabilityController, { capabilities: [] }).then(() => undefined))
      .rejects.toThrow(/raw Cordis|cordis_run/i)
  })

  it('rejects duplicate Tool and Prompt-section ownership at Provider registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CapabilityController, { capabilities: [] })
    const plugin = Object.assign(() => undefined, { inject: ['tools'] })

    ctx.capabilityController.registerProvider({
      name: 'fixture-owner-a',
      toolNames: ['owned_tool'],
      promptSectionNames: ['owned:guidance'],
      plugin,
    })

    expect(() => ctx.capabilityController.registerProvider({
      name: 'fixture-owner-b',
      toolNames: ['owned_tool'],
      promptSectionNames: ['other:guidance'],
      plugin,
    })).toThrow(/tool.*already owned/i)
    expect(() => ctx.capabilityController.registerProvider({
      name: 'fixture-owner-c',
      toolNames: ['other_tool'],
      promptSectionNames: ['owned:guidance'],
      plugin,
    })).toThrow(/section.*already owned/i)
  })

  it('commits grant and explicit revoke facts around the exact Provider Fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CapabilityController, { capabilities: [{
      capability: 'text.reverse',
      provider: 'fixture-reverse',
      risk: 'low',
      approvalRequired: false,
      defaultScope: 'session',
      allowedScopes: ['session'],
    }] })

    ctx.capabilityController.registerProvider({
      name: 'fixture-reverse',
      toolNames: ['reverse_text'],
      promptSectionNames: [],
      plugin: Object.assign((inner: Context) => inner.tools.register(defineTool({
        name: 'reverse_text',
        description: 'Reverse text.',
        parameters: { text: { type: 'string', required: true } },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: ({ text }) => Promise.resolve(text.split('').reverse().join('')),
      })), { inject: ['tools'] }),
    })

    const { agent } = await scopedAgent(ctx, 'session-controller')
    const granted = await ctx.capabilityController.request({
      agent,
      capability: 'text.reverse',
      reason: 'Reverse the requested value',
    })
    expect(granted).toMatchObject({
      status: 'granted', capability: 'text.reverse', scope: 'session', reused: false,
    })
    expect(toolNames(ctx, agent)).toContain('reverse_text')
    expect(agent.session.events.filter(event => event.type === 'capability/change').map(event => event.data.kind))
      .toEqual(['requested', 'granted'])

    const forgedBeforeAssembly = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('forged-before-assembly'),
      name: 'reverse_text',
      arguments: { text: 'before' },
      agent,
    })
    expect(forgedBeforeAssembly.isError).toBe(true)

    await ctx.systemPrompt.assemble({ agent, scope: agent })
    const directAfterAssembly = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('direct-after-assembly'),
      name: 'reverse_text',
      arguments: { text: 'direct' },
      agent,
    })
    expect(directAfterAssembly.isError).toBe(true)

    agent.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('admitted-after-assembly'),
      name: 'reverse_text',
      arguments: JSON.stringify({ text: 'after' }),
    })
    const forgedArguments = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('admitted-after-assembly'),
      name: 'reverse_text',
      arguments: { text: 'forged' },
      agent,
    })
    expect(forgedArguments.isError).toBe(true)
    const forgedLogDirectExecution = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('admitted-after-assembly'),
      name: 'reverse_text',
      arguments: { text: 'after' },
      agent,
    })
    expect(forgedLogDirectExecution.isError).toBe(true)

    if (granted.status !== 'granted') throw new Error('expected grant')
    const released = await ctx.capabilityController.release({ agent, leaseId: granted.leaseId })
    expect(released).toMatchObject({ status: 'released', capability: 'text.reverse' })
    expect(toolNames(ctx, agent)).not.toContain('reverse_text')
    expect(agent.session.events.filter(event => event.type === 'capability/change').map(event => event.data.kind))
      .toEqual(['requested', 'granted', 'revoked'])
  })

  it('expires rather than revokes a durable grant when post-commit activation bookkeeping fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CapabilityController, { capabilities: [{
      capability: 'text.rollback',
      provider: 'fixture-rollback',
      risk: 'low',
      approvalRequired: false,
      defaultScope: 'session',
      allowedScopes: ['session'],
    }] })
    ctx.capabilityController.registerProvider({
      name: 'fixture-rollback',
      toolNames: ['rollback_text'],
      promptSectionNames: [],
      plugin: Object.assign((inner: Context) => inner.tools.register(defineTool({
        name: 'rollback_text',
        description: 'Return one rollback fixture value.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: () => Promise.resolve('rollback'),
      })), { inject: ['tools'] }),
    })
    Object.defineProperty(ctx.capabilityController, 'armIdleTimer', {
      configurable: true,
      value: () => { throw new Error('post-commit bookkeeping failed') },
    })
    const { agent } = await scopedAgent(ctx, 'session-controller-grant-rollback')

    await expect(ctx.capabilityController.request({
      agent,
      capability: 'text.rollback',
      reason: 'Exercise committed grant rollback',
    })).rejects.toThrow(/post-commit bookkeeping failed/)

    const changes = agent.session.events
      .filter(event => event.type === 'capability/change')
      .map(event => event.data)
    expect(changes.map(change => change.kind)).toEqual(['requested', 'granted', 'expired'])
    expect(changes.at(-1)).toMatchObject({ kind: 'expired', cause: 'activation-lost' })
    expect(toolNames(ctx, agent)).not.toContain('rollback_text')
  })

  it('keeps committed authority when telemetry observation fails and emits a warning', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CapabilityController, { capabilities: [{
      capability: 'text.observe',
      provider: 'fixture-observer',
      risk: 'low',
      approvalRequired: false,
      defaultScope: 'session',
      allowedScopes: ['session'],
    }] })
    ctx.capabilityController.registerProvider({
      name: 'fixture-observer',
      toolNames: ['observe_text'],
      plugin: Object.assign((inner: Context) => inner.tools.register(defineTool({
        name: 'observe_text',
        description: 'Return one observed value.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: () => Promise.resolve('observed'),
      })), { inject: ['tools'] }),
    })
    const telemetry = vi.spyOn(ctx.capabilityController.ports.telemetry, 'record')
      .mockRejectedValue(new Error('fixture telemetry unavailable'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const { agent } = await scopedAgent(ctx, 'session-controller-telemetry')

    const granted = await ctx.capabilityController.request({
      agent,
      capability: 'text.observe',
      reason: 'Prove telemetry cannot roll back authority',
    })

    expect(granted).toMatchObject({ status: 'granted', capability: 'text.observe' })
    expect(agent.session.events.filter(event => event.type === 'capability/change').map(event => event.data.kind))
      .toEqual(['requested', 'granted'])
    expect(telemetry).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/telemetry.*fixture telemetry unavailable/i))
  })
})
