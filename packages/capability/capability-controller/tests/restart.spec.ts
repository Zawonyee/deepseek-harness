import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import CapabilityController from '../src/index.ts'
import {
  CAPABILITY_CHANGE_VERSION,
  CapabilityLeaseId,
  CapabilityRequestId,
} from '../src/events.ts'

async function scopedAgent(ctx: Context, session: Session): Promise<{ agent: Agent; scope: Scope }> {
  const agent = { id: session.id, session, status: 'idle' } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  return { agent, scope }
}

describe('capability history reconciliation', () => {
  it('expires a seeded active Lease without reactivating its Provider Fiber', async () => {
    const id = SessionId('capability-restart-seed')
    const source = Session.create(id)
    const requestId = CapabilityRequestId('seed-request')
    const leaseId = CapabilityLeaseId('seed-lease')
    source.append('capability/change', {
      kind: 'requested', version: CAPABILITY_CHANGE_VERSION, requestId,
      agentId: String(id), capability: 'fixture.restart', requestedScope: 'session',
      reason: 'Seed an active authority fact from a prior process',
    })
    source.append('capability/change', {
      kind: 'granted', version: CAPABILITY_CHANGE_VERSION, requestId, leaseId,
      provider: 'fixture-restart-provider', risk: 'low', scope: 'session',
      binding: { kind: 'session' }, toolNames: ['restart_fixture'], revokeAfterSuccess: false,
    })
    const replayed = Session.create(id, source.events)

    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(CapabilityController, { capabilities: [{
      capability: 'fixture.restart',
      provider: 'fixture-restart-provider',
      risk: 'low',
      approvalRequired: false,
      defaultScope: 'session',
      allowedScopes: ['session'],
    }] })
    ctx.capabilityController.registerProvider({
      name: 'fixture-restart-provider',
      toolNames: ['restart_fixture'],
      plugin: Object.assign((inner: Context) => inner.tools.register(defineTool({
        name: 'restart_fixture',
        description: 'This must never mount while reconciling a seed.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: () => Promise.resolve('unexpected'),
      })), { inject: ['tools'] }),
    })
    const { agent } = await scopedAgent(ctx, replayed)
    const unregister = ctx.agents.register(agent)
    try {
      agentEvents(ctx, agent).emit('agent/session-start', { source: 'resume' })
      await Promise.resolve()

      expect(ctx.capabilityController.ports.leases.get(leaseId, replayed)?.status).toBe('expired')
      expect(replayed.events.find(event => event.type === 'capability/change'
        && event.data.kind === 'expired' && event.data.leaseId === leaseId)?.data)
        .toMatchObject({ kind: 'expired', cause: 'process-restarted' })
      expect(ctx.tools.schemas(agent).map(schema => schema.name)).not.toContain('restart_fixture')
    } finally {
      unregister()
    }
  })
})
