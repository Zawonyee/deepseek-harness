import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import CapabilityController, * as CapabilityControllerContract from '../src/index.ts'
import type { CapabilityProvider } from '../src/index.ts'
import {
  createDeterministicEmailProvider,
  DeterministicEmailOutbox,
} from './fixtures/deterministic-email-provider.ts'

type ProviderDeclaration = <const Provider extends CapabilityProvider>(provider: Provider) => Provider

function defineProvider(): ProviderDeclaration {
  const define = (CapabilityControllerContract as typeof CapabilityControllerContract & {
    readonly defineCapabilityProvider?: ProviderDeclaration
  }).defineCapabilityProvider
  if (define === undefined) throw new Error('Capability Controller does not export defineCapabilityProvider()')
  return define
}

async function scopedAgent(ctx: Context): Promise<Agent> {
  const session = Session.create(SessionId('external-email-provider'))
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  return agent
}

async function executeEmail(
  ctx: Context,
  agent: Agent,
  callId: string,
  args: { readonly to: string; readonly subject: string; readonly body: string },
) {
  agent.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(callId),
    name: 'email_send',
    arguments: JSON.stringify(args),
  })
  return await ctx.agents.withInitiator(agent, async () => {
    const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare({
      signal: new AbortController().signal,
      callId: CallId(callId),
      name: 'email_send',
      arguments: args,
      agent,
    })
    if (prepared.kind === 'dispatch') {
      const dispatched = await scheduler.dispatch(prepared.exec)
      return dispatched.kind === 'post-result'
        ? await scheduler.finalize(prepared.exec, dispatched.result)
        : scheduler.finish(prepared.exec, dispatched.result)
    }
    return prepared.kind === 'post-result'
      ? await scheduler.finalize(prepared.exec, prepared.result)
      : scheduler.finish(prepared.exec, prepared.result)
  })
}

describe('external email Provider contract', () => {
  it('exports a declaration helper that preserves descriptor identity and validates names', () => {
    expect(typeof (CapabilityControllerContract as { defineCapabilityProvider?: unknown })
      .defineCapabilityProvider).toBe('function')

    const outbox = new DeterministicEmailOutbox()
    const provider = createDeterministicEmailProvider(outbox)
    expect(defineProvider()(provider)).toBe(provider)
    expect(provider).toMatchObject({
      name: 'fixture-provider-email',
      toolNames: ['email_send'],
      promptSectionNames: ['tool:email_send'],
    })

    expect(() => defineProvider()({
      ...provider,
      promptSectionNames: ['tool:email_send', 'tool:email_send'],
    })).toThrow(/unique Prompt section names/i)
    expect(() => defineProvider()({ ...provider, toolNames: ['cordis_run'] }))
      .toThrow(/control tool/i)
  })

  it('activates an external Provider for one Agent and queues deterministic receipts', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve('allowed-once'))
    await ctx.plugin(CapabilityController, { capabilities: [{
      capability: 'email.send',
      provider: 'fixture-provider-email',
      risk: 'high',
      approvalRequired: true,
      defaultScope: 'session',
      allowedScopes: ['session'],
    }] })

    const outbox = new DeterministicEmailOutbox()
    ctx.capabilityController.registerProvider(createDeterministicEmailProvider(outbox))
    const agent = await scopedAgent(ctx)
    ctx.agents.register(agent)
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('email_send')

    const granted = await ctx.capabilityController.request({
      agent,
      capability: 'email.send',
      reason: 'Send the two user-requested status messages',
    })
    expect(granted).toMatchObject({ status: 'granted', capability: 'email.send', reused: false })

    const prompt = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(prompt.tools.map(tool => tool.name)).toContain('email_send')
    expect(prompt.sections.map(section => section.name)).toContain('tool:email_send')
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('email_send')
    await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter', messages: [] }),
    )

    const firstArgs = { to: 'alpha@example.test', subject: 'Alpha', body: 'First update' }
    const secondArgs = { to: 'beta@example.test', subject: 'Beta', body: 'Second update' }
    const first = await executeEmail(ctx, agent, 'email-send-1', firstArgs)
    const second = await executeEmail(ctx, agent, 'email-send-2', secondArgs)

    expect(first.isError ? undefined : first.value).toEqual({ id: 'email-0001', ...firstArgs })
    expect(second.isError ? undefined : second.value).toEqual({ id: 'email-0002', ...secondArgs })
    expect(outbox.list()).toEqual([
      { id: 'email-0001', ...firstArgs },
      { id: 'email-0002', ...secondArgs },
    ])
  })
})
