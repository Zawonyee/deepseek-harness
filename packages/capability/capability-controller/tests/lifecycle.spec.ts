import { Context } from '@deepseek-ai/cordis'
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
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import CapabilityController from '../src/index.ts'
import type {
  CapabilityDefinition,
  CapabilityLeaseScope,
  CapabilityRequestResult,
} from '../src/index.ts'
import type { CapabilityChange, CapabilityExpirationCause } from '../src/events.ts'

type Granted = Extract<CapabilityRequestResult, { status: 'granted' }>

interface LifecycleHarness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly scope: Scope
  readonly toolNames: ReadonlyMap<string, string>
  readonly unregister: () => void
}

let harnessSequence = 0

function definition(
  capability: string,
  scope: CapabilityLeaseScope,
  options: { idleTtlSec?: number; expireAfterSuccessfulUse?: boolean } = {},
): CapabilityDefinition {
  return {
    capability,
    provider: `fixture-${capability}`,
    risk: 'low',
    approvalRequired: false,
    defaultScope: scope,
    allowedScopes: [scope],
    ...options,
  }
}

function changes(session: Session): CapabilityChange[] {
  return session.events.flatMap(event => event.type === 'capability/change' ? [event.data] : [])
}

function visibleToolNames(ctx: Context, agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name)
}

async function harness(
  definitions: readonly CapabilityDefinition[],
  options: { goals?: boolean; execute?: (signal: AbortSignal) => Promise<string> } = {},
): Promise<LifecycleHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (options.goals === true) await ctx.plugin(GoalService, {})
  await ctx.plugin(CapabilityController, { capabilities: [...definitions] })

  const toolNames = new Map<string, string>()
  for (const [index, row] of definitions.entries()) {
    const toolName = `lifecycle_fixture_${index}`
    toolNames.set(row.capability, toolName)
    ctx.capabilityController.registerProvider({
      name: row.provider,
      toolNames: [toolName],
      plugin: Object.assign((inner: Context) => inner.tools.register(defineTool({
        name: toolName,
        description: 'Return a deterministic lifecycle-test value.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: (_args, exec) => options.execute?.(exec.signal) ?? Promise.resolve('fixture-ok'),
      })), { inject: ['tools'] }),
    })
  }

  const session = ctx.sessions.create(SessionId(`capability-lifecycle-${++harnessSequence}`))
  const agent = { id: session.id, session, status: 'idle' } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools', 'systemPrompt'],
  }))
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  const unregister = ctx.agents.register(agent)
  return { ctx, agent, session, scope, toolNames, unregister }
}

async function grant(test: LifecycleHarness, capability: string): Promise<Granted> {
  const result = await test.ctx.capabilityController.request({
    agent: test.agent,
    capability,
    reason: `Exercise ${capability} lifecycle`,
  })
  if (result.status !== 'granted') {
    throw new Error(`expected ${capability} grant, received ${result.code}: ${result.reason}`)
  }
  return result
}

async function expectExpired(
  test: LifecycleHarness,
  granted: Granted,
  cause: CapabilityExpirationCause,
): Promise<void> {
  await vi.waitFor(() => {
    expect(test.ctx.capabilityController.ports.leases.get(granted.leaseId, test.session)?.status)
      .toBe('expired')
    expect(changes(test.session).find(change => change.kind === 'expired'
      && change.leaseId === granted.leaseId)).toMatchObject({ cause })
    expect(visibleToolNames(test.ctx, test.agent))
      .not.toContain(test.toolNames.get(granted.capability))
  }, { timeout: 500, interval: 10 })
}

async function executeAsAgentLoop(
  test: LifecycleHarness,
  capability: string,
  callId: string,
  signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  const toolName = test.toolNames.get(capability)
  if (toolName === undefined) throw new Error(`missing fixture tool for ${capability}`)
  if (!test.session.events.some(event => event.type === 'turn/start' && event.data.turn === 1)) {
    test.session.append('turn/start', { turn: 1 })
  }
  await test.ctx.systemPrompt.assemble({ agent: test.agent, scope: test.agent, signal })
  await agentEvents(test.ctx, test.agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  const id = CallId(callId)
  test.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: id,
    name: toolName,
    arguments: '{}',
  })
  return await test.ctx.agents.withInitiator(test.agent, async () => {
    const scheduler = test.ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const prepared = await scheduler.prepare({
      signal,
      callId: id,
      name: toolName,
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

describe('automatic capability lease lifecycle', () => {
  it('denies a conflicting scope instead of activating a second Lease for one capability', async () => {
    const capability = 'fixture.scope-conflict'
    const row: CapabilityDefinition = {
      ...definition(capability, 'session'),
      allowedScopes: ['session', 'persistent'],
    }
    const test = await harness([row])
    const granted = await grant(test, capability)

    const conflict = await test.ctx.capabilityController.request({
      agent: test.agent,
      capability,
      reason: 'Attempt a second lifetime for the same exact capability',
      requestedScope: 'persistent',
    })

    expect(conflict).toMatchObject({ status: 'denied', code: 'lease-scope-conflict' })
    expect(test.ctx.capabilityController.ports.leases.list(test.session)
      .filter(lease => lease.status === 'active')).toEqual([
      expect.objectContaining({ leaseId: granted.leaseId, scope: 'session' }),
    ])
  })

  it('serializes concurrent requests for different scopes of one capability', async () => {
    const capability = 'fixture.concurrent-scope-conflict'
    const test = await harness([{
      ...definition(capability, 'session'),
      allowedScopes: ['session', 'persistent'],
    }])

    const [sessionResult, persistentResult] = await Promise.all([
      test.ctx.capabilityController.request({
        agent: test.agent,
        capability,
        reason: 'Acquire the configured default scope',
        requestedScope: 'session',
      }),
      test.ctx.capabilityController.request({
        agent: test.agent,
        capability,
        reason: 'Race a conflicting lifetime',
        requestedScope: 'persistent',
      }),
    ])

    expect(sessionResult).toMatchObject({ status: 'granted', scope: 'session' })
    expect(persistentResult).toMatchObject({ status: 'denied', code: 'lease-scope-conflict' })
    expect(test.ctx.capabilityController.ports.leases.list(test.session)
      .filter(lease => lease.status === 'active')).toHaveLength(1)
  })

  it('expires a turn lease when its bound turn ends', async () => {
    const capability = 'fixture.turn'
    const test = await harness([definition(capability, 'turn')])
    test.session.append('turn/start', { turn: 1 })
    const granted = await grant(test, capability)

    test.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await expectExpired(test, granted, 'turn-ended')
  })

  it('awaits Provider drain and deactivation during the normal turn-stopping boundary', async () => {
    const capability = 'fixture.turn-stopping'
    const test = await harness([definition(capability, 'turn')])
    test.session.append('turn/start', { turn: 1 })
    const granted = await grant(test, capability)
    const cleanupStarted = Promise.withResolvers<undefined>()
    const cleanupGate = Promise.withResolvers<undefined>()
    const adapter = test.ctx.capabilityController.ports.adapter
    const deactivate = adapter.deactivate.bind(adapter)
    vi.spyOn(adapter, 'deactivate').mockImplementation(async (input) => {
      cleanupStarted.resolve(undefined)
      await cleanupGate.promise
      await deactivate(input)
    })

    let stopped = false
    const stopping = agentEvents(test.ctx, test.agent).serial(
      'agent/turn-stopping',
      { turn: 1, signal: new AbortController().signal },
    ).then(() => { stopped = true })
    await cleanupStarted.promise
    expect(stopped).toBe(false)
    expect(test.ctx.capabilityController.ports.leases.get(granted.leaseId, test.session)?.status)
      .toBe('active')

    cleanupGate.resolve(undefined)
    await stopping
    expect(stopped).toBe(true)
    await expectExpired(test, granted, 'turn-ended')
  })

  it('denies a task lease when the Agent has no current Goal', async () => {
    const capability = 'fixture.task-without-goal'
    const test = await harness([definition(capability, 'task')], { goals: true })

    const result = await test.ctx.capabilityController.request({
      agent: test.agent,
      capability,
      reason: 'Task scope requires a Goal owner',
    })

    expect(result).toMatchObject({ status: 'denied', code: 'task-goal-required' })
    expect(visibleToolNames(test.ctx, test.agent)).not.toContain(test.toolNames.get(capability))
  })

  it('keeps a paused task lease and expires it when that Goal completes', async () => {
    const capability = 'fixture.task-pause'
    const test = await harness([definition(capability, 'task')], { goals: true })
    const goal = test.ctx.goals.create(test.agent, { objective: 'Exercise pause and completion' })
    const granted = await grant(test, capability)

    const paused = test.ctx.goals.pause(test.agent, { id: goal.id, revision: goal.revision })
    await Promise.resolve()
    expect(test.ctx.capabilityController.ports.leases.get(granted.leaseId, test.session)?.status)
      .toBe('active')
    expect(visibleToolNames(test.ctx, test.agent)).toContain(test.toolNames.get(capability))
    expect(changes(test.session).some(change => change.kind === 'expired'
      && change.leaseId === granted.leaseId)).toBe(false)

    test.ctx.goals.complete(test.agent, { id: paused.id, revision: paused.revision })
    await expectExpired(test, granted, 'goal-terminal')
  })

  it('keeps a task lease across edit, then requires a fresh grant after block and resume', async () => {
    const capability = 'fixture.task-edit-resume'
    const test = await harness([definition(capability, 'task')], { goals: true })
    const created = test.ctx.goals.create(test.agent, { objective: 'Exercise edit and blocked resume' })
    const first = await grant(test, capability)

    const edited = test.ctx.goals.edit(test.agent, created, {
      objective: 'Exercise the edited Goal while retaining authority',
    })
    await Promise.resolve()
    expect(test.ctx.capabilityController.ports.leases.get(first.leaseId, test.session)?.status)
      .toBe('active')
    expect(visibleToolNames(test.ctx, test.agent)).toContain(test.toolNames.get(capability))

    const blocked = test.ctx.goals.block(test.agent, edited, {
      code: 'fixture-blocked',
      message: 'Resume must obtain a new Lease.',
    })
    await expectExpired(test, first, 'goal-terminal')
    test.ctx.goals.resume(test.agent, blocked)
    const second = await grant(test, capability)

    expect(second.leaseId).not.toBe(first.leaseId)
    expect(second.reused).toBe(false)
  })

  it.each(['block', 'clear'] as const)('expires a task lease when its Goal is %sed', async (operation) => {
    const capability = `fixture.task-${operation}`
    const test = await harness([definition(capability, 'task')], { goals: true })
    const goal = test.ctx.goals.create(test.agent, { objective: `Exercise Goal ${operation}` })
    const granted = await grant(test, capability)
    const ref = { id: goal.id, revision: goal.revision }

    if (operation === 'block') {
      test.ctx.goals.block(test.agent, ref, { code: 'fixture-blocked', message: 'Blocked by fixture.' })
    } else {
      test.ctx.goals.clear(test.agent, ref)
    }

    await expectExpired(test, granted, 'goal-terminal')
  })

  it('expires from the grant deadline even when a duplicate request reuses the lease', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'))
    try {
      const capability = 'fixture.idle-ttl'
      const test = await harness([definition(capability, 'session', { idleTtlSec: 1 })])
      const granted = await grant(test, capability)

      await vi.advanceTimersByTimeAsync(900)
      const reused = await grant(test, capability)
      expect(reused).toMatchObject({ leaseId: granted.leaseId, reused: true })

      await vi.advanceTimersByTimeAsync(101)
      expect(test.ctx.capabilityController.ports.leases.get(granted.leaseId, test.session)?.status)
        .toBe('expired')
      expect(changes(test.session).find(change => change.kind === 'expired'
        && change.leaseId === granted.leaseId)).toMatchObject({ cause: 'idle-ttl' })
      expect(visibleToolNames(test.ctx, test.agent)).not.toContain(test.toolNames.get(capability))
    } finally {
      vi.useRealTimers()
    }
  })

  it('actively retries an automatic TTL expiry after Provider deactivation fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'))
    try {
      const capability = 'fixture.idle-ttl-deactivate-retry'
      const test = await harness([definition(capability, 'session', { idleTtlSec: 1 })])
      const granted = await grant(test, capability)
      const adapter = test.ctx.capabilityController.ports.adapter
      const deactivate = adapter.deactivate.bind(adapter)
      const attempted = vi.spyOn(adapter, 'deactivate')
        .mockRejectedValueOnce(new Error('fixture automatic deactivate failure'))
        .mockImplementation(deactivate)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(test.ctx.capabilityController.ports.leases.get(granted.leaseId, test.session)?.status)
        .toBe('active')
      const closingAssembly = await test.ctx.systemPrompt.assemble({
        agent: test.agent,
        scope: test.agent,
      })
      expect(closingAssembly.tools.map(tool => tool.name)).not.toContain(test.toolNames.get(capability))
      expect(changes(test.session).some(change => change.kind === 'expired'
        && change.leaseId === granted.leaseId)).toBe(false)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(test.ctx.capabilityController.ports.leases.get(granted.leaseId, test.session)?.status)
        .toBe('expired')
      expect(attempted).toHaveBeenCalledTimes(2)
      expect(changes(test.session).filter(change => change.kind === 'expired'
        && change.leaseId === granted.leaseId)).toEqual([
        expect.objectContaining({ cause: 'idle-ttl' }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries only the terminal event after automatic TTL physical cleanup succeeded', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'))
    try {
      const capability = 'fixture.idle-ttl-append-retry'
      const test = await harness([definition(capability, 'session', { idleTtlSec: 1 })])
      const granted = await grant(test, capability)
      const adapter = test.ctx.capabilityController.ports.adapter
      const deactivate = vi.spyOn(adapter, 'deactivate')
      const append = vi.spyOn(test.session, 'append')
      append.mockImplementationOnce(() => {
        throw new Error('fixture automatic terminal append failure')
      })

      await vi.advanceTimersByTimeAsync(1_000)
      expect(test.ctx.capabilityController.ports.leases.get(granted.leaseId, test.session)?.status)
        .toBe('active')
      expect(deactivate).toHaveBeenCalledTimes(1)
      expect(changes(test.session).some(change => change.kind === 'expired'
        && change.leaseId === granted.leaseId)).toBe(false)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(test.ctx.capabilityController.ports.leases.get(granted.leaseId, test.session)?.status)
        .toBe('expired')
      expect(deactivate).toHaveBeenCalledTimes(1)
      expect(changes(test.session).filter(change => change.kind === 'expired'
        && change.leaseId === granted.leaseId)).toEqual([
        expect.objectContaining({ cause: 'idle-ttl' }),
      ])
      append.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['session', 'persistent'] as const)(
    'expires an active %s lease when the exact Agent is disposed',
    async (scope) => {
      const capability = `fixture.agent-disposed-${scope}`
      const test = await harness([definition(capability, scope)])
      const granted = await grant(test, capability)

      test.unregister()

      await expectExpired(test, granted, 'agent-disposed')
    },
  )

  it('expires a live-log Lease as activation-lost when its exact Provider Fiber disappears', async () => {
    const capability = 'fixture.activation-lost'
    const test = await harness([definition(capability, 'session')])
    const granted = await grant(test, capability)

    await test.scope.dispose()
    agentEvents(test.ctx, test.agent).emit('agent/session-start', { source: 'resume' })

    await expectExpired(test, granted, 'activation-lost')
  })

  it('records successful use and expires a revoke-after-success lease after tools/result', async () => {
    const capability = 'fixture.success'
    const test = await harness([definition(capability, 'session', { expireAfterSuccessfulUse: true })])
    const granted = await grant(test, capability)
    const toolName = test.toolNames.get(capability)
    if (toolName === undefined) throw new Error('missing fixture tool name')
    expect(visibleToolNames(test.ctx, test.agent)).toContain(toolName)
    const result = await executeAsAgentLoop(
      test,
      capability,
      'capability-lifecycle-success-call',
    )
    if (result.isError) throw new Error(`expected fixture tool success, received: ${result.error.message}`)

    await expectExpired(test, granted, 'revoke-after-success')
    expect(changes(test.session).filter(change => 'leaseId' in change
      && change.leaseId === granted.leaseId
      && (change.kind === 'used' || change.kind === 'expired')).map(change => change.kind))
      .toEqual(['used', 'expired'])
  })

  it('does not success-expire after a failed Provider result', async () => {
    const capability = 'fixture.success-failed'
    const test = await harness(
      [definition(capability, 'session', { expireAfterSuccessfulUse: true })],
      { execute: () => Promise.reject(new Error('fixture Provider failure')) },
    )
    const granted = await grant(test, capability)

    const result = await executeAsAgentLoop(test, capability, 'capability-lifecycle-failed-call')

    expect(result.isError).toBe(true)
    expect(test.ctx.capabilityController.ports.leases.get(granted.leaseId, test.session)?.status)
      .toBe('active')
    expect(changes(test.session).filter(change => 'leaseId' in change
      && change.leaseId === granted.leaseId).map(change => change.kind))
      .toEqual(['granted', 'used'])
  })

  it('does not success-expire after an aborted Provider result', async () => {
    const capability = 'fixture.success-aborted'
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<string>()
    const test = await harness(
      [definition(capability, 'session', { expireAfterSuccessfulUse: true })],
      { execute: async () => {
        entered.resolve(undefined)
        return await gate.promise
      } },
    )
    const granted = await grant(test, capability)
    const controller = new AbortController()

    const pending = executeAsAgentLoop(
      test,
      capability,
      'capability-lifecycle-aborted-call',
      controller.signal,
    )
    await entered.promise
    controller.abort(new Error('fixture abort'))
    gate.resolve('late success after abort')
    const result = await pending

    expect(result.isError).toBe(true)
    expect(test.ctx.capabilityController.ports.leases.get(granted.leaseId, test.session)?.status)
      .toBe('active')
    expect(changes(test.session).some(change => change.kind === 'expired'
      && change.leaseId === granted.leaseId)).toBe(false)
  })
})
