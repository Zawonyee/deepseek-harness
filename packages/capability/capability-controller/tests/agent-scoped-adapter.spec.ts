import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import type { CapabilityDefinition } from '../src/index.ts'

const REVERSE: CapabilityDefinition = {
  capability: 'text.reverse',
  provider: 'reverse-text',
  risk: 'low',
  approvalRequired: false,
  defaultScope: 'session',
  allowedScopes: ['session'],
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

function names(ctx: Context, agent?: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name).sort()
}

describe('AgentScopedCapabilityRuntimeAdapter', () => {
  it('rejects a provider that declares a raw Cordis control tool', async () => {
    const { AgentScopedCapabilityRuntimeAdapter } = await import('../src/agent-scoped-adapter.ts')
    const ctx = new Context()
    const controlPlugin = Object.assign(() => undefined, { inject: ['tools'] })

    expect(() => new AgentScopedCapabilityRuntimeAdapter(ctx, [{
      name: 'raw-cordis-provider',
      plugin: controlPlugin,
      toolNames: ['cordis_run'],
    }])).toThrow('cannot contribute control tool "cordis_run"')
  })

  it('mounts a trusted plugin through agent.ctx and disposes only that Agent activation', async () => {
    const { AgentScopedCapabilityRuntimeAdapter } = await import('../src/agent-scoped-adapter.ts')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const a = await scopedAgent(ctx, 'adapter-a')
    const b = await scopedAgent(ctx, 'adapter-b')
    let executions = 0
    const reversePlugin = Object.assign((inner: Context) => inner.tools.register(defineTool({
      name: 'reverse_text',
      description: 'Reverse text in the owning Agent scope.',
      parameters: { text: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async ({ text }) => {
        executions += 1
        return text.split('').reverse().join('')
      },
    })), { inject: ['tools'] })
    const adapter = new AgentScopedCapabilityRuntimeAdapter(ctx, [{
      name: 'reverse-text',
      plugin: reversePlugin,
      toolNames: ['reverse_text'],
    }])

    const activation = await adapter.activate({ agent: a.agent, definition: REVERSE, scope: 'session' })
    expect(activation.toolNames).toEqual(['reverse_text'])
    expect(adapter.isActive(a.agent, 'text.reverse')).toBe(true)
    expect(names(ctx, a.agent)).toContain('reverse_text')
    expect(names(ctx, b.agent)).not.toContain('reverse_text')
    expect(names(ctx)).not.toContain('reverse_text')

    const aResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('adapter-a-call'),
      name: 'reverse_text',
      arguments: { text: 'abc' },
      agent: a.agent,
    })
    const bResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('adapter-b-call'),
      name: 'reverse_text',
      arguments: { text: 'abc' },
      agent: b.agent,
    })
    expect(aResult.isError ? undefined : aResult.value).toBe('cba')
    expect(bResult.error?.info?.code).toBe('UNKNOWN_TOOL')
    expect(executions).toBe(1)

    await adapter.deactivate({
      agent: a.agent,
      lease: {
        leaseId: 'adapter-lease',
        sessionId: String(a.agent.id),
        capability: REVERSE.capability,
        provider: REVERSE.provider,
        risk: REVERSE.risk,
        scope: 'session',
        binding: { kind: 'session' },
        reason: 'adapter test',
        status: 'active',
        toolNames: ['reverse_text'],
        grantedAt: '2026-08-24T00:00:00.000Z',
        lastUsedAt: '2026-08-24T00:00:00.000Z',
      },
    })
    expect(adapter.isActive(a.agent, 'text.reverse')).toBe(false)
    expect(names(ctx, a.agent)).not.toContain('reverse_text')
    const after = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('adapter-after'),
      name: 'reverse_text',
      arguments: { text: 'after' },
      agent: a.agent,
    })
    expect(after.error?.info?.code).toBe('UNKNOWN_TOOL')

    await adapter.activate({ agent: a.agent, definition: REVERSE, scope: 'session' })
    expect(adapter.isActive(a.agent, 'text.reverse')).toBe(true)
    await a.scope.dispose()
    expect(adapter.isActive(a.agent, 'text.reverse')).toBe(false)
    expect(names(ctx, a.agent)).not.toContain('reverse_text')
  })

  it('rejects undeclared, missing, and shadowing Provider prompt sections', async () => {
    const { AgentScopedCapabilityRuntimeAdapter } = await import('../src/agent-scoped-adapter.ts')
    const createHarness = async (id: string) => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime)
      const owner = await scopedAgent(ctx, id)
      return { ctx, owner }
    }
    const providerPlugin = (sectionName?: string) => Object.assign((inner: Context) => {
      inner.tools.register(defineTool({
        name: 'section_fixture_tool',
        description: 'Prompt-section contract fixture.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: () => Promise.resolve('ok'),
      }))
      if (sectionName !== undefined) {
        inner.systemPrompt.section({ name: sectionName, order: 150, text: 'provider guidance' })
      }
    }, { inject: ['systemPrompt', 'tools'] })

    const missingTool = await createHarness('adapter-tool-missing')
    const missingToolAdapter = new AgentScopedCapabilityRuntimeAdapter(missingTool.ctx, [{
      name: REVERSE.provider,
      plugin: Object.assign(() => undefined, { inject: ['tools'] }),
      toolNames: ['section_fixture_tool'],
      promptSectionNames: [],
    }])
    await expect(missingToolAdapter.activate({
      agent: missingTool.owner.agent, definition: REVERSE, scope: 'session',
    })).rejects.toThrow(/did not contribute declared.*tool/i)

    const undeclared = await createHarness('adapter-section-undeclared')
    const undeclaredAdapter = new AgentScopedCapabilityRuntimeAdapter(undeclared.ctx, [{
      name: REVERSE.provider,
      plugin: providerPlugin('provider:undeclared'),
      toolNames: ['section_fixture_tool'],
      promptSectionNames: [],
    }])
    await expect(undeclaredAdapter.activate({
      agent: undeclared.owner.agent, definition: REVERSE, scope: 'session',
    })).rejects.toThrow(/undeclared.*prompt section|prompt section.*undeclared/i)

    const missing = await createHarness('adapter-section-missing')
    const missingAdapter = new AgentScopedCapabilityRuntimeAdapter(missing.ctx, [{
      name: REVERSE.provider,
      plugin: providerPlugin(),
      toolNames: ['section_fixture_tool'],
      promptSectionNames: ['provider:missing'],
    }])
    await expect(missingAdapter.activate({
      agent: missing.owner.agent, definition: REVERSE, scope: 'session',
    })).rejects.toThrow(/did not contribute declared.*prompt section|prompt section.*missing/i)

    const shadowing = await createHarness('adapter-section-shadow')
    shadowing.ctx.systemPrompt.section({ name: 'provider:shadow', order: 100, text: 'global guidance' })
    const shadowingAdapter = new AgentScopedCapabilityRuntimeAdapter(shadowing.ctx, [{
      name: REVERSE.provider,
      plugin: providerPlugin('provider:shadow'),
      toolNames: ['section_fixture_tool'],
      promptSectionNames: ['provider:shadow'],
    }])
    await expect(shadowingAdapter.activate({
      agent: shadowing.owner.agent, definition: REVERSE, scope: 'session',
    })).rejects.toThrow(/shadow existing.*prompt section|cannot shadow.*prompt section/i)
  })
})
