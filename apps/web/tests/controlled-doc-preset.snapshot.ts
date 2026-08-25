import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type EpochHeader } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { assertFixtureInventory, launchWebScaffold, type WebScaffold } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/controlled-doc-preset', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./snapshots/controlled-doc-preset/session.jsonl', import.meta.url))
const PROMPTS = [
  'Request web.search for source inspection, then reply exactly CONTROLLED_DOC_GRANTED_OK and stop.',
  'Reply exactly CONTROLLED_DOC_RELEASED_OK and stop.',
] as const
const INITIAL_TOOLS = [
  'edit',
  'read',
  'read_image',
  'release_capability',
  'request_capability',
  'write',
] as const
const WEB_GUIDANCE = 'Use the web_search tool to discover current information on the web.'

function toolNames(header: EpochHeader): string[] {
  return (header.tools ?? []).map(tool => tool.name).sort()
}

function valueObject(result: ToolExecutionResult): Record<string, unknown> | undefined {
  if (result.isError || typeof result.value !== 'object' || result.value === null || Array.isArray(result.value)) {
    return undefined
  }
  return result.value
}

describe('controlled document agent preset', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let disposeApproval: (() => void) | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE })
    disposeApproval = scaffold.ctx.on(
      'approval/request',
      () => Promise.resolve('allowed-once'),
      { prepend: true },
    )
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('controlled-doc-preset-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'controlled-doc' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'controlled-doc').then(() => undefined),
    })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    try {
      disposeApproval?.()
    } catch (error: unknown) {
      failures.push(error)
    }
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'controlled-doc preset smoke teardown failed')
  })

  it('assembles the least-privilege schema and changes the next request header with the web lease', async () => {
    const followup = async (prompt: string): Promise<EpochHeader> => {
      agentHandle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await agentHandle.agent.whenIdle()
      const header = agentHandle.agent.session.requestHeader()
      if (header === undefined) throw new Error(`controlled-doc issued no model request for ${JSON.stringify(prompt)}`)
      return header
    }

    let grantedLeaseId: string | undefined
    const disposeGrantCapture = scaffold.ctx.on('tools/result', (exec, result) => {
      if (exec.agent !== agentHandle.agent || exec.name !== 'request_capability') return
      const grant = valueObject(result)
      if (grant?.status === 'granted' && typeof grant.lease_id === 'string') grantedLeaseId = grant.lease_id
    })
    try {
      await followup(PROMPTS[0])
    } finally {
      disposeGrantCapture()
    }
    const firstTurnHeaders = agentHandle.agent.session.events.flatMap(event => (
      event.type === 'request/header' ? [event.data.header] : []
    ))
    expect(firstTurnHeaders).toHaveLength(2)
    const [initial, withWeb] = firstTurnHeaders
    if (initial === undefined || withWeb === undefined) throw new Error('controlled-doc did not assemble both schema generations')
    expect(toolNames(initial)).toEqual(INITIAL_TOOLS)
    expect(initial.system).not.toContain(WEB_GUIDANCE)
    expect(toolNames(initial).some(name => name.startsWith('cordis_'))).toBe(false)
    expect(toolNames(initial)).not.toEqual(expect.arrayContaining([
      'bash', 'pwsh', 'web_search', 'web_fetch', 'get_goal', 'create_goal', 'update_goal',
    ]))
    expect(toolNames(withWeb)).toEqual([...INITIAL_TOOLS, 'web_search'].sort())
    expect(withWeb.system).toContain(WEB_GUIDANCE)
    expect(scaffold.ctx.tools.schemas(agentHandle.agent).map(tool => tool.name).sort())
      .toEqual([...INITIAL_TOOLS, 'web_search'].sort())

    const asked = agentHandle.agent.session.events.find(event => event.type === 'approval/asked')
    const decided = agentHandle.agent.session.events.find(event => event.type === 'approval/decided')
    const granted = agentHandle.agent.session.events.find(event => (
      event.type === 'capability/change' && event.data.kind === 'granted'
    ))
    expect(asked?.data).toMatchObject({
      callId: 'call_request_web',
      toolName: 'request_capability',
    })
    expect(decided?.data).toEqual({ id: asked?.data.id, outcome: 'allowed-once' })
    expect(granted?.data).toMatchObject({
      approvalRequestId: asked?.data.id,
      provider: 'provider-web',
      scope: 'session',
    })

    if (grantedLeaseId === undefined) {
      throw new Error('recorded request_capability call did not grant web.search')
    }

    const released = await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('controlled-doc-release-web'),
      name: 'release_capability',
      arguments: { lease_id: grantedLeaseId },
      agent: agentHandle.agent,
    })
    expect(valueObject(released)).toEqual({
      status: 'released', lease_id: grantedLeaseId, capability: 'web.search',
    })

    const afterRelease = await followup(PROMPTS[1])
    expect(toolNames(afterRelease)).toEqual(INITIAL_TOOLS)
    expect(afterRelease.system).not.toContain(WEB_GUIDANCE)
    const headerTimeline = agentHandle.agent.session.events.flatMap(event => (
      event.type === 'request/header' ? [event.data.header] : []
    ))
    expect(headerTimeline.map(toolNames)).toEqual([
      [...INITIAL_TOOLS],
      [...INITIAL_TOOLS, 'web_search'].sort(),
      [...INITIAL_TOOLS],
    ])
    expect(headerTimeline.map(header => header.system?.includes(WEB_GUIDANCE) ?? false))
      .toEqual([false, true, false])
    expect(scaffold.ctx.tools.schemas(agentHandle.agent).map(tool => tool.name).sort()).toEqual(INITIAL_TOOLS)
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl'])
  })
})
