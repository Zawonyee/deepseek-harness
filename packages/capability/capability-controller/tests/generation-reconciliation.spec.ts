import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import CapabilityController from '../src/index.ts'
import type {
  CapabilityDefinition,
  CapabilityRequestResult,
} from '../src/index.ts'
import type { AgentScopedCapabilityProvider } from '../src/agent-scoped-adapter.ts'
import type { CapabilityChange } from '../src/events.ts'

type Granted = Extract<CapabilityRequestResult, { status: 'granted' }>

interface ReconciliationHarness {
  readonly ctx: Context
  readonly controller: CapabilityController
  readonly agent: Agent
  readonly session: Session
  readonly definition: CapabilityDefinition
  readonly provider: AgentScopedCapabilityProvider
  readonly toolName: string
  readonly execute: ReturnType<typeof vi.fn<() => Promise<string>>>
  readonly deactivate: ReturnType<typeof vi.fn<() => Promise<void>>>
}

let harnessSequence = 0

function capabilityChanges(session: Session): CapabilityChange[] {
  return session.events.flatMap(event => event.type === 'capability/change' ? [event.data] : [])
}

async function createHarness(options: {
  registerProvider?: boolean
  registerAgent?: boolean
  expireAfterSuccessfulUse?: boolean
} = {}): Promise<ReconciliationHarness> {
  const sequence = ++harnessSequence
  const definition: CapabilityDefinition = {
    capability: `fixture.generation-${sequence}`,
    provider: `fixture-generation-provider-${sequence}`,
    risk: 'low',
    approvalRequired: false,
    defaultScope: 'session',
    allowedScopes: ['session'],
    ...options.expireAfterSuccessfulUse === true ? { expireAfterSuccessfulUse: true } : {},
  }
  const toolName = `generation_fixture_${sequence}`
  const execute = vi.fn(() => Promise.resolve('generation-ok'))
  const deactivate = vi.fn(() => Promise.resolve())

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CapabilityController, { capabilities: [definition] })
  const controller = ctx.capabilityController
  const provider: AgentScopedCapabilityProvider = {
    name: definition.provider,
    toolNames: [toolName],
    plugin: Object.assign((inner: Context) => {
      inner.effect(() => {
        const unregister = inner.tools.register(defineTool({
          name: toolName,
          description: 'Exercise schema-generation and Registry reconciliation.',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          execute,
        }))
        return async () => {
          await deactivate()
          unregister()
        }
      })
    }, { inject: ['tools'] }),
  }
  if (options.registerProvider !== false) controller.registerProvider(provider)

  const session = ctx.sessions.create(SessionId(`capability-generation-${sequence}`))
  const agent = { id: session.id, session, status: 'idle' } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  if (options.registerAgent !== false) ctx.agents.register(agent)

  return { ctx, controller, agent, session, definition, provider, toolName, execute, deactivate }
}

async function grant(test: ReconciliationHarness): Promise<Granted> {
  const result = await test.controller.request({
    agent: test.agent,
    capability: test.definition.capability,
    reason: 'Exercise generation reconciliation',
  })
  if (result.status !== 'granted') {
    throw new Error(`expected grant, received ${result.code}: ${result.reason}`)
  }
  return result
}

async function assemble(test: ReconciliationHarness) {
  return await test.ctx.systemPrompt.assemble({ agent: test.agent, scope: test.agent })
}

async function preStep(
  test: ReconciliationHarness,
  messages: UserMessage[],
  turn = 1,
  step = 1,
): Promise<PreStepDecision> {
  return await agentEvents(test.ctx, test.agent).waterfall(
    'agent/pre-step',
    { messages, turn, step, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages }),
  )
}

describe('AgentLoop schema-generation enforcement', () => {
  it('tells a stale one-shot caller which capability to request before retrying', async () => {
    const test = await createHarness({ expireAfterSuccessfulUse: true })
    const granted = await grant(test)
    expect((await assemble(test)).tools.map(tool => tool.name)).toContain(test.toolName)
    test.session.append('turn/start', { turn: 1 })
    await preStep(test, [], 1, 1)
    test.session.append('step/start', { turn: 1, step: 1 })

    const executeScheduled = async (callId: CallId) => {
      test.session.append('tool/call', {
        turn: 1,
        step: 1,
        callId,
        name: test.toolName,
        arguments: '{}',
      })
      return await test.ctx.agents.withInitiator(test.agent, async () => {
        const scheduler = test.ctx.tools[TOOL_RUNTIME_SCHEDULER]
        const prepared = await scheduler.prepare({
          signal: new AbortController().signal,
          callId,
          name: test.toolName,
          arguments: {},
          agent: test.agent,
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

    const first = await executeScheduled(CallId('one-shot-success'))
    expect(first.isError).toBe(false)
    await vi.waitFor(() => {
      expect(test.controller.ports.leases.get(granted.leaseId, test.session)?.status)
        .toBe('expired')
    })

    const stale = await executeScheduled(CallId('stale-one-shot-retry'))

    expect(stale.isError).toBe(true)
    const staleText = stale.content[0]
    expect(staleText?.type).toBe('text')
    expect(staleText?.type === 'text' ? staleText.text : '').toMatch(
      new RegExp(`${test.definition.capability}.*request_capability`),
    )
    expect(test.execute).toHaveBeenCalledTimes(1)
  })

  it('rejects a forged scheduler call that never received pre-step generation admission', async () => {
    const test = await createHarness()
    await grant(test)
    expect((await assemble(test)).tools.map(tool => tool.name)).toContain(test.toolName)
    test.session.append('turn/start', { turn: 1 })
    await preStep(test, [], 1, 2)
    const callId = CallId('forged-scheduler-without-pre-step')
    test.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: test.toolName,
      arguments: '{}',
    })

    const result = await test.ctx.agents.withInitiator(test.agent, async () => {
      const scheduler = test.ctx.tools[TOOL_RUNTIME_SCHEDULER]
      const prepared = await scheduler.prepare({
        signal: new AbortController().signal,
        callId,
        name: test.toolName,
        arguments: {},
        agent: test.agent,
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

    expect(result.isError).toBe(true)
    expect(test.execute).not.toHaveBeenCalled()
  })

  it('reassembles after downstream pre-step shrink without dropping the claimed messages', async () => {
    const test = await createHarness()
    const granted = await grant(test)
    let assemblyCount = 0
    test.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      assemblyCount += 1
      return await next()
    })
    const preparedAssembly = await assemble(test)
    expect(preparedAssembly.tools.map(tool => tool.name)).toContain(test.toolName)
    test.session.append('turn/start', { turn: 1 })

    test.ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (agent === test.agent) {
        await test.controller.release({ agent, leaseId: granted.leaseId })
      }
      return decision
    })
    const input = createUserMessage({
      content: [{ type: 'text', text: 'preserve this exact claimed prompt' }],
      source: { kind: 'user' },
    })
    const decision = await preStep(test, [input])

    expect(decision).toEqual({ kind: 'enter', messages: [input] })
    expect(assemblyCount).toBe(2)
    expect(preparedAssembly.tools.map(tool => tool.name)).not.toContain(test.toolName)
    expect(capabilityChanges(test.session).filter(change => change.kind === 'revoked'
      && change.leaseId === granted.leaseId)).toHaveLength(1)
  })

  it('rejects a tool call from an old step generation after the same capability is re-granted', async () => {
    const test = await createHarness()
    const first = await grant(test)
    expect((await assemble(test)).tools.map(tool => tool.name)).toContain(test.toolName)
    test.session.append('turn/start', { turn: 1 })
    const input = createUserMessage({
      content: [{ type: 'text', text: 'produce one old-generation tool call' }],
      source: { kind: 'user' },
    })
    await expect(preStep(test, [input])).resolves.toMatchObject({ kind: 'enter' })
    test.session.append('step/start', { turn: 1, step: 1 })

    await test.controller.release({ agent: test.agent, leaseId: first.leaseId })
    const replacement = await grant(test)
    expect(replacement.leaseId).not.toBe(first.leaseId)

    const callId = CallId('old-schema-generation-call')
    test.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: test.toolName,
      arguments: '{}',
    })
    const result = await test.ctx.tools.execute({
      signal: new AbortController().signal,
      callId,
      name: test.toolName,
      arguments: {},
      agent: test.agent,
    })

    expect(result.isError).toBe(true)
    expect(test.execute).not.toHaveBeenCalled()
  })
})

describe('Registry and Provider reconciliation', () => {
  it('expires an active Lease when its complete Registry definition changes', async () => {
    const test = await createHarness()
    const granted = await grant(test)
    expect((await assemble(test)).tools.map(tool => tool.name)).toContain(test.toolName)
    const liveDefinition = test.controller.ports.registry.get(test.definition.capability)
    if (liveDefinition === undefined) throw new Error('missing live Registry definition')
    const mutableDefinition = liveDefinition as { approvalRequired: boolean }
    mutableDefinition.approvalRequired = true

    const reconciled = await assemble(test)

    expect(reconciled.tools.map(tool => tool.name)).not.toContain(test.toolName)
    expect(test.deactivate).toHaveBeenCalledTimes(1)
    expect(test.controller.ports.leases.get(granted.leaseId, test.session)?.status).toBe('expired')
    expect(capabilityChanges(test.session).filter(change => change.kind === 'expired'
      && change.leaseId === granted.leaseId)).toEqual([
      expect.objectContaining({ cause: 'definition-changed' }),
    ])
  })

  it('fails Agent publication when a configured Provider was never registered', async () => {
    const test = await createHarness({ registerProvider: false, registerAgent: false })

    expect(() => { test.ctx.agents.register(test.agent) })
      .toThrow(/configured capability provider.*not registered/i)
    expect(test.ctx.agents.get(test.agent.id)).toBeUndefined()
  })

  it('fails the first assembly for an unregistered Agent when a configured Provider is missing', async () => {
    const test = await createHarness({ registerProvider: false, registerAgent: false })

    await expect(assemble(test)).rejects.toThrow(/configured capability provider.*not registered/i)
  })
})
