import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import GoalService from '@deepseek-ai/dsh-goal'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import ApprovalService, { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'
import CapabilityController from '../src/index.ts'
import type {
  CapabilityDefinition,
  CapabilityRequestResult,
} from '../src/index.ts'
import type { AgentScopedCapabilityProvider } from '../src/agent-scoped-adapter.ts'
import type { CapabilityChange } from '../src/events.ts'

type Granted = Extract<CapabilityRequestResult, { status: 'granted' }>

interface ProductionHarness {
  readonly ctx: Context
  readonly controller: CapabilityController
  readonly controllerFiber: Fiber
  readonly agent: Agent
  readonly session: Session
  readonly definition: CapabilityDefinition
  readonly provider: AgentScopedCapabilityProvider
  readonly unregisterProvider: () => Promise<void>
}

interface HarnessOptions {
  readonly definition?: Partial<CapabilityDefinition>
  readonly goals?: boolean
  readonly approval?: boolean
  readonly execute?: () => Promise<string>
  readonly deactivate?: () => Promise<void>
}

let harnessSequence = 0

function changes(session: Session): CapabilityChange[] {
  return session.events.flatMap(event => event.type === 'capability/change' ? [event.data] : [])
}

function terminalChanges(session: Session, leaseId: string): CapabilityChange[] {
  return changes(session).filter(change => (change.kind === 'revoked' || change.kind === 'expired')
    && change.leaseId === leaseId)
}

async function harness(options: HarnessOptions = {}): Promise<ProductionHarness> {
  const sequence = ++harnessSequence
  const capability = options.definition?.capability ?? `fixture.concurrent-${sequence}`
  const providerName = options.definition?.provider ?? `fixture-concurrent-provider-${sequence}`
  const toolName = `concurrent_fixture_${sequence}`
  const definition: CapabilityDefinition = {
    capability,
    provider: providerName,
    risk: 'low',
    approvalRequired: false,
    defaultScope: 'session',
    allowedScopes: ['session'],
    ...options.definition,
  }

  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (options.goals === true) await ctx.plugin(GoalService, {})
  if (options.approval === true) await ctx.plugin(ApprovalService, { policy: 'ask' })
  const controllerFiber = await ctx.plugin(CapabilityController, { capabilities: [definition] })
  const controller = ctx.capabilityController

  const provider: AgentScopedCapabilityProvider = {
    name: providerName,
    toolNames: [toolName],
    plugin: Object.assign((inner: Context) => {
      inner.effect(() => {
        const unregisterTool = inner.tools.register(defineTool({
          name: toolName,
          description: 'A deterministic Provider tool used to exercise Controller serialization.',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          execute: options.execute ?? (() => Promise.resolve('fixture-ok')),
        }))
        return async () => {
          await options.deactivate?.()
          unregisterTool()
        }
      })
    }, { inject: ['tools'] }),
  }
  const unregisterProvider = controller.registerProvider(provider)

  const session = ctx.sessions.create(SessionId(`capability-production-concurrency-${sequence}`))
  const agent = { id: session.id, session, status: 'idle' } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  ctx.agents.register(agent)

  return {
    ctx,
    controller,
    controllerFiber,
    agent,
    session,
    definition,
    provider,
    unregisterProvider,
  }
}

async function requestConfigured(test: ProductionHarness): Promise<CapabilityRequestResult> {
  return await test.controller.request({
    agent: test.agent,
    capability: test.definition.capability,
    reason: 'Exercise production Controller serialization',
  })
}

async function grantConfigured(test: ProductionHarness): Promise<Granted> {
  const result = await requestConfigured(test)
  if (result.status !== 'granted') {
    throw new Error(`expected grant, received ${result.code}: ${result.reason}`)
  }
  return result
}

function providerTool(test: ProductionHarness): string {
  const toolName = test.provider.toolNames[0]
  if (toolName === undefined) throw new Error('missing Provider tool fixture')
  return toolName
}

async function assembleToolNames(test: ProductionHarness): Promise<string[]> {
  const assembly = await test.ctx.systemPrompt.assemble({ agent: test.agent, scope: test.agent })
  return assembly.tools.map(tool => tool.name)
}

async function executeProvider(test: ProductionHarness, callId: string) {
  await agentEvents(test.ctx, test.agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  test.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(callId),
    name: providerTool(test),
    arguments: '{}',
  })
  return await test.ctx.agents.withInitiator(test.agent, async () => {
    const scheduler = test.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare({
      signal: new AbortController().signal,
      callId: CallId(callId),
      name: providerTool(test),
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

describe('production Controller close serialization', () => {
  it('hides a closing in-flight Provider immediately but drains tools/result before revoke', async () => {
    const entered = Promise.withResolvers<undefined>()
    const executionGate = Promise.withResolvers<string>()
    const deactivate = vi.fn(() => Promise.resolve())
    const execute = vi.fn(() => {
      entered.resolve(undefined)
      return executionGate.promise
    })
    const test = await harness({ execute, deactivate })
    const granted = await grantConfigured(test)
    expect(await assembleToolNames(test)).toContain(providerTool(test))

    const running = executeProvider(test, 'production-in-flight-first')
    await entered.promise
    const releasing = test.controller.release({ agent: test.agent, leaseId: granted.leaseId })

    expect(await assembleToolNames(test)).not.toContain(providerTool(test))
    const rejected = await executeProvider(test, 'production-in-flight-rejected')
    expect(rejected.isError).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(deactivate).not.toHaveBeenCalled()
    expect(terminalChanges(test.session, granted.leaseId)).toEqual([])
    expect(test.controller.ports.leases.get(granted.leaseId, test.session)?.status).toBe('active')

    executionGate.resolve('first-finished')
    const first = await running
    expect(first.isError ? undefined : first.value).toBe('first-finished')
    await expect(releasing).resolves.toMatchObject({ status: 'released', leaseId: granted.leaseId })
    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(terminalChanges(test.session, granted.leaseId)).toEqual([
      expect.objectContaining({ kind: 'revoked', leaseId: granted.leaseId }),
    ])
  })

  it('commits one terminal transition when explicit release races a Goal terminal event', async () => {
    const cleanupStarted = Promise.withResolvers<undefined>()
    const cleanupGate = Promise.withResolvers<undefined>()
    const deactivate = vi.fn(async () => {
      cleanupStarted.resolve(undefined)
      await cleanupGate.promise
    })
    const test = await harness({
      goals: true,
      definition: {
        defaultScope: 'task',
        allowedScopes: ['task'],
      },
      deactivate,
    })
    const goal = test.ctx.goals.create(test.agent, { objective: 'Race release against completion' })
    const granted = await grantConfigured(test)

    const releasing = test.controller.release({ agent: test.agent, leaseId: granted.leaseId })
    await cleanupStarted.promise
    test.ctx.goals.complete(test.agent, { id: goal.id, revision: goal.revision })
    cleanupGate.resolve(undefined)

    await expect(releasing).resolves.toMatchObject({ status: 'released', leaseId: granted.leaseId })
    await Promise.resolve()
    await Promise.resolve()
    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(terminalChanges(test.session, granted.leaseId)).toEqual([
      expect.objectContaining({ kind: 'revoked', leaseId: granted.leaseId }),
    ])
  })

  it('commits one terminal transition when explicit release races the idle TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'))
    const cleanupStarted = Promise.withResolvers<undefined>()
    const cleanupGate = Promise.withResolvers<undefined>()
    const deactivate = vi.fn(async () => {
      cleanupStarted.resolve(undefined)
      await cleanupGate.promise
    })
    try {
      const test = await harness({ definition: { idleTtlSec: 1 }, deactivate })
      const granted = await grantConfigured(test)

      const releasing = test.controller.release({ agent: test.agent, leaseId: granted.leaseId })
      await cleanupStarted.promise
      await vi.advanceTimersByTimeAsync(1_000)
      cleanupGate.resolve(undefined)

      await expect(releasing).resolves.toMatchObject({ status: 'released', leaseId: granted.leaseId })
      await Promise.resolve()
      await Promise.resolve()
      expect(deactivate).toHaveBeenCalledTimes(1)
      expect(terminalChanges(test.session, granted.leaseId)).toEqual([
        expect.objectContaining({ kind: 'revoked', leaseId: granted.leaseId }),
      ])
    } finally {
      cleanupGate.resolve(undefined)
      vi.useRealTimers()
    }
  })

  it('joins an idle-TTL expiry that started before explicit release', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'))
    const cleanupStarted = Promise.withResolvers<undefined>()
    const cleanupGate = Promise.withResolvers<undefined>()
    const deactivate = vi.fn(async () => {
      cleanupStarted.resolve(undefined)
      await cleanupGate.promise
    })
    try {
      const test = await harness({ definition: { idleTtlSec: 1 }, deactivate })
      const granted = await grantConfigured(test)

      await vi.advanceTimersByTimeAsync(1_000)
      await cleanupStarted.promise
      const releasing = test.controller.release({ agent: test.agent, leaseId: granted.leaseId })
      cleanupGate.resolve(undefined)

      await expect(releasing).resolves.toMatchObject({
        status: 'denied',
        code: 'lease-not-active',
        leaseId: granted.leaseId,
      })
      expect(deactivate).toHaveBeenCalledTimes(1)
      expect(terminalChanges(test.session, granted.leaseId)).toEqual([
        expect.objectContaining({
          kind: 'expired',
          cause: 'idle-ttl',
          leaseId: granted.leaseId,
        }),
      ])
    } finally {
      cleanupGate.resolve(undefined)
      vi.useRealTimers()
    }
  })

  it('stays closing after deactivate fails and an explicit retry performs one physical cleanup', async () => {
    const physicalDeactivate = vi.fn(() => Promise.resolve())
    const test = await harness({ deactivate: physicalDeactivate })
    const granted = await grantConfigured(test)
    expect(await assembleToolNames(test)).toContain(providerTool(test))

    const adapter = test.controller.ports.adapter
    const delegate = adapter.deactivate.bind(adapter)
    const deactivate = vi.spyOn(adapter, 'deactivate')
      .mockRejectedValueOnce(new Error('fixture deactivate failed'))
      .mockImplementation(delegate)

    await expect(test.controller.release({ agent: test.agent, leaseId: granted.leaseId }))
      .resolves.toMatchObject({
        status: 'denied',
        code: 'deactivation-failed',
        leaseId: granted.leaseId,
      })
    expect(await assembleToolNames(test)).not.toContain(providerTool(test))
    const rejected = await executeProvider(test, 'production-deactivate-failed-closed')
    expect(rejected.isError).toBe(true)
    expect(physicalDeactivate).not.toHaveBeenCalled()
    expect(terminalChanges(test.session, granted.leaseId)).toEqual([])
    expect(test.controller.ports.leases.get(granted.leaseId, test.session)?.status).toBe('active')

    await expect(test.controller.release({ agent: test.agent, leaseId: granted.leaseId }))
      .resolves.toMatchObject({ status: 'released', leaseId: granted.leaseId })
    expect(deactivate).toHaveBeenCalledTimes(2)
    expect(physicalDeactivate).toHaveBeenCalledTimes(1)
    expect(terminalChanges(test.session, granted.leaseId)).toEqual([
      expect.objectContaining({ kind: 'revoked', leaseId: granted.leaseId }),
    ])
  })

  it('retries only the terminal append after physical cleanup already succeeded', async () => {
    const physicalDeactivate = vi.fn(() => Promise.resolve())
    const test = await harness({ deactivate: physicalDeactivate })
    const granted = await grantConfigured(test)
    expect(await assembleToolNames(test)).toContain(providerTool(test))
    const append = vi.spyOn(test.session, 'append')
    append.mockImplementationOnce(() => {
      throw new Error('fixture terminal append failed')
    })

    await expect(test.controller.release({ agent: test.agent, leaseId: granted.leaseId }))
      .rejects.toThrow('fixture terminal append failed')
    expect(await assembleToolNames(test)).not.toContain(providerTool(test))
    const rejected = await executeProvider(test, 'production-terminal-append-failed-closed')
    expect(rejected.isError).toBe(true)
    expect(physicalDeactivate).toHaveBeenCalledTimes(1)
    expect(terminalChanges(test.session, granted.leaseId)).toEqual([])
    expect(test.controller.ports.leases.get(granted.leaseId, test.session)?.status).toBe('active')

    await expect(test.controller.release({ agent: test.agent, leaseId: granted.leaseId }))
      .resolves.toMatchObject({ status: 'released', leaseId: granted.leaseId })
    expect(physicalDeactivate).toHaveBeenCalledTimes(1)
    expect(terminalChanges(test.session, granted.leaseId)).toEqual([
      expect.objectContaining({ kind: 'revoked', leaseId: granted.leaseId }),
    ])
    append.mockRestore()
  })
})

describe('production request admission serialization', () => {
  it('serializes policy and denies a duplicate that is cancelled while waiting in the capability FIFO', async () => {
    const test = await harness()
    const policyStarted = Promise.withResolvers<undefined>()
    const policyGate = Promise.withResolvers<undefined>()
    const evaluate = vi.spyOn(test.controller.ports.policy, 'evaluate')
      .mockImplementation(async () => {
        policyStarted.resolve(undefined)
        await policyGate.promise
        return { kind: 'allow' }
      })
    const secondSignal = new AbortController()

    const first = requestConfigured(test)
    await policyStarted.promise
    const second = test.controller.request({
      agent: test.agent,
      capability: test.definition.capability,
      reason: 'Cancel this duplicate while the first request owns the FIFO',
      signal: secondSignal.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const policyCallsBeforeRelease = evaluate.mock.calls.length
    secondSignal.abort(new Error('fixture queued request cancelled'))
    policyGate.resolve(undefined)

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(policyCallsBeforeRelease).toBe(1)
    expect(firstResult).toMatchObject({ status: 'granted', reused: false })
    expect(secondResult).toMatchObject({ status: 'denied', code: 'request-cancelled' })
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(changes(test.session).map(change => change.kind)).toEqual([
      'requested', 'granted', 'requested', 'denied',
    ])
  })

  it('denies request-cancelled when cancellation arrives while policy is pending', async () => {
    const test = await harness()
    const policyStarted = Promise.withResolvers<undefined>()
    const policyGate = Promise.withResolvers<undefined>()
    vi.spyOn(test.controller.ports.policy, 'evaluate').mockImplementation(async () => {
      policyStarted.resolve(undefined)
      await policyGate.promise
      return { kind: 'allow' }
    })
    const activate = vi.spyOn(test.controller.ports.adapter, 'activate')
    const signal = new AbortController()

    const pending = test.controller.request({
      agent: test.agent,
      capability: test.definition.capability,
      reason: 'Cancel while the asynchronous policy is evaluating',
      signal: signal.signal,
    })
    await policyStarted.promise
    signal.abort(new Error('fixture policy cancellation'))
    policyGate.resolve(undefined)

    await expect(pending).resolves.toMatchObject({
      status: 'denied',
      code: 'request-cancelled',
    })
    expect(activate).not.toHaveBeenCalled()
    expect(changes(test.session).map(change => change.kind)).toEqual(['requested', 'denied'])
  })

  it('asks once for concurrent duplicate approval and reuses the first committed Lease', async () => {
    const test = await harness({
      approval: true,
      definition: { approvalRequired: true },
    })
    const approvalGate = Promise.withResolvers<'allowed-once'>()
    const approvalStarted = Promise.withResolvers<undefined>()
    const requestApproval = vi.spyOn(test.ctx.approval, 'requestWithReceipt')
      .mockImplementation(async () => {
        approvalStarted.resolve(undefined)
        return {
          id: ApprovalRequestId('concurrent-duplicate-approval'),
          outcome: await approvalGate.promise,
        }
      })
    const activate = vi.spyOn(test.controller.ports.adapter, 'activate')

    const first = requestConfigured(test)
    await approvalStarted.promise
    const second = test.controller.request({
      agent: test.agent,
      capability: test.definition.capability,
      reason: 'Reuse the concurrently approved capability',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const approvalCallsBeforeRelease = requestApproval.mock.calls.length
    approvalGate.resolve('allowed-once')

    const outcomes = await Promise.all([first, second])
    expect(approvalCallsBeforeRelease).toBe(1)
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'granted', reused: false }),
      expect.objectContaining({ status: 'granted', reused: true }),
    ])
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('maps a caller abort during approval to request-cancelled without activation', async () => {
    const test = await harness({
      approval: true,
      definition: { approvalRequired: true },
    })
    const approvalGate = Promise.withResolvers<'allowed-once'>()
    const approvalStarted = Promise.withResolvers<undefined>()
    vi.spyOn(test.ctx.approval, 'requestWithReceipt').mockImplementation(async () => {
      approvalStarted.resolve(undefined)
      return {
        id: ApprovalRequestId('cancelled-capability-approval'),
        outcome: await approvalGate.promise,
      }
    })
    const activate = vi.spyOn(test.controller.ports.adapter, 'activate')
    const signal = new AbortController()

    const pending = test.controller.request({
      agent: test.agent,
      capability: test.definition.capability,
      reason: 'Cancel the in-flight approval question',
      signal: signal.signal,
    })
    await approvalStarted.promise
    signal.abort(new Error('fixture approval cancellation'))
    approvalGate.resolve('allowed-once')
    const result = await pending

    expect(result).toMatchObject({ status: 'denied', code: 'request-cancelled' })
    expect(activate).not.toHaveBeenCalled()
    expect(changes(test.session).map(change => change.kind)).toEqual(['requested', 'denied'])
  })

  it('rolls back a Provider Fiber when cancellation arrives during activation', async () => {
    const activationStarted = Promise.withResolvers<undefined>()
    const activationGate = Promise.withResolvers<undefined>()
    const deactivate = vi.fn(() => Promise.resolve())
    const test = await harness({ deactivate })
    const adapter = test.controller.ports.adapter
    const delegate = adapter.activate.bind(adapter)
    vi.spyOn(adapter, 'activate').mockImplementation(async (input) => {
      const activation = await delegate(input)
      activationStarted.resolve(undefined)
      await activationGate.promise
      return activation
    })
    const signal = new AbortController()

    const pending = test.controller.request({
      agent: test.agent,
      capability: test.definition.capability,
      reason: 'Cancel after Provider activation starts but before it commits',
      signal: signal.signal,
    })
    await activationStarted.promise
    signal.abort(new Error('fixture activation cancellation'))
    activationGate.resolve(undefined)

    await expect(pending).resolves.toMatchObject({
      status: 'denied',
      code: 'request-cancelled',
    })
    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(changes(test.session).map(change => change.kind)).toEqual(['requested', 'denied'])
    expect(await assembleToolNames(test)).not.toContain(providerTool(test))
  })
})

describe('production Provider and Controller unload', () => {
  it('waits for a pending activation and rolls it back before Provider unload removes its guards', async () => {
    const activationStarted = Promise.withResolvers<undefined>()
    const activationGate = Promise.withResolvers<undefined>()
    const deactivate = vi.fn(() => Promise.resolve())
    const test = await harness({ deactivate })
    const adapter = test.controller.ports.adapter
    const delegate = adapter.activate.bind(adapter)
    vi.spyOn(adapter, 'activate').mockImplementation(async (input) => {
      const activation = await delegate(input)
      activationStarted.resolve(undefined)
      await activationGate.promise
      return activation
    })

    const requesting = requestConfigured(test)
    await activationStarted.promise
    const unloading = test.unregisterProvider()
    const unloadState = await Promise.race([
      unloading.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => setTimeout(() => { resolve('pending') }, 0)),
    ])
    activationGate.resolve(undefined)
    const [outcome] = await Promise.all([requesting, unloading])

    expect(unloadState).toBe('pending')
    expect(outcome).toMatchObject({ status: 'denied', code: 'provider-unavailable' })
    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(changes(test.session).map(change => change.kind)).toEqual(['requested', 'denied'])
    expect(test.ctx.tools.schemas(test.agent).map(schema => schema.name)).not.toContain(providerTool(test))
    expect(test.ctx.tools.schemas().map(schema => schema.name)).not.toContain(providerTool(test))
  })

  it('waits for a pending activation and rolls it back before Controller disposal settles', async () => {
    const activationStarted = Promise.withResolvers<undefined>()
    const activationGate = Promise.withResolvers<undefined>()
    const deactivate = vi.fn(() => Promise.resolve())
    const test = await harness({ deactivate })
    const adapter = test.controller.ports.adapter
    const delegate = adapter.activate.bind(adapter)
    vi.spyOn(adapter, 'activate').mockImplementation(async (input) => {
      const activation = await delegate(input)
      activationStarted.resolve(undefined)
      await activationGate.promise
      return activation
    })

    const requesting = requestConfigured(test)
    await activationStarted.promise
    const disposing = test.controllerFiber.dispose()
    const disposeState = await Promise.race([
      disposing.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => setTimeout(() => { resolve('pending') }, 0)),
    ])
    activationGate.resolve(undefined)
    const [outcome] = await Promise.all([requesting, disposing])

    expect(disposeState).toBe('pending')
    expect(outcome).toMatchObject({ status: 'denied', code: 'activation-failed' })
    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(changes(test.session).map(change => change.kind)).toEqual(['requested', 'denied'])
    expect(test.ctx.tools.schemas(test.agent).map(schema => schema.name)).not.toContain(providerTool(test))
    expect(test.ctx.tools.schemas().map(schema => schema.name)).not.toContain(providerTool(test))
  })

  it('expires active authority on Provider unload, then reloads the same Provider for a fresh grant', async () => {
    const cleanupStarted = Promise.withResolvers<undefined>()
    const cleanupGate = Promise.withResolvers<undefined>()
    const deactivate = vi.fn(async () => {
      cleanupStarted.resolve(undefined)
      await cleanupGate.promise
    })
    const test = await harness({ deactivate })
    const granted = await grantConfigured(test)
    expect(await assembleToolNames(test)).toContain(providerTool(test))

    const unloading = test.unregisterProvider()
    await cleanupStarted.promise
    try {
      expect(await assembleToolNames(test)).not.toContain(providerTool(test))
      const rejected = await executeProvider(test, 'production-provider-unloaded-closed')
      expect(rejected.isError).toBe(true)
      expect(terminalChanges(test.session, granted.leaseId)).toEqual([])
    } finally {
      cleanupGate.resolve(undefined)
    }
    await unloading
    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(test.controller.ports.leases.get(granted.leaseId, test.session)?.status).toBe('expired')
    expect(terminalChanges(test.session, granted.leaseId)).toEqual([
      expect.objectContaining({
        kind: 'expired',
        cause: 'provider-unloaded',
        leaseId: granted.leaseId,
      }),
    ])
    await test.unregisterProvider()
    expect(terminalChanges(test.session, granted.leaseId)).toHaveLength(1)

    await expect(requestConfigured(test)).resolves.toMatchObject({
      status: 'denied',
      code: 'provider-unavailable',
    })

    const unregisterReplacement = test.controller.registerProvider(test.provider)
    const replacement = await grantConfigured(test)
    expect(replacement.reused).toBe(false)
    expect(replacement.leaseId).not.toBe(granted.leaseId)
    expect(await assembleToolNames(test)).toContain(providerTool(test))
    await test.controller.release({ agent: test.agent, leaseId: replacement.leaseId })
    await unregisterReplacement()
    expect(deactivate).toHaveBeenCalledTimes(2)
  })

  it('expires every active Lease as controller-unloaded before Controller disposal settles', async () => {
    const deactivate = vi.fn(() => Promise.resolve())
    const test = await harness({ deactivate })
    const granted = await grantConfigured(test)
    expect(await assembleToolNames(test)).toContain(providerTool(test))

    await test.controllerFiber.dispose()

    expect(deactivate).toHaveBeenCalledTimes(1)
    expect(test.controller.ports.leases.get(granted.leaseId, test.session)?.status).toBe('expired')
    expect(terminalChanges(test.session, granted.leaseId)).toEqual([
      expect.objectContaining({
        kind: 'expired',
        leaseId: granted.leaseId,
        cause: 'controller-unloaded',
      }),
    ])
    expect(test.ctx.tools.schemas(test.agent).map(schema => schema.name)).not.toContain(providerTool(test))
  })

  it('keeps enforcement and result tracking installed until Controller disposal drains in-flight work', async () => {
    const entered = Promise.withResolvers<undefined>()
    const executionGate = Promise.withResolvers<string>()
    const execute = vi.fn(() => {
      if (execute.mock.calls.length === 1) {
        entered.resolve(undefined)
        return executionGate.promise
      }
      return Promise.resolve('unexpected-second-dispatch')
    })
    const test = await harness({ execute })
    const granted = await grantConfigured(test)
    expect(await assembleToolNames(test)).toContain(providerTool(test))

    const running = executeProvider(test, 'production-controller-dispose-in-flight')
    await entered.promise
    const disposing = test.controllerFiber.dispose()
    try {
      const disposeState = await Promise.race([
        disposing.then(() => 'settled' as const),
        new Promise<'pending'>(resolve => setTimeout(() => { resolve('pending') }, 0)),
      ])
      expect(disposeState).toBe('pending')
      expect(await assembleToolNames(test)).not.toContain(providerTool(test))

      const rejected = await executeProvider(test, 'production-controller-dispose-rejected')
      expect(rejected.isError).toBe(true)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(terminalChanges(test.session, granted.leaseId)).toEqual([])
    } finally {
      executionGate.resolve('drained-before-controller-dispose')
    }

    await expect(running).resolves.toMatchObject({ isError: false })
    await disposing
    expect(terminalChanges(test.session, granted.leaseId)).toEqual([
      expect.objectContaining({ kind: 'expired', cause: 'controller-unloaded' }),
    ])
  })
})
