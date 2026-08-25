import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  collectSessionTrial,
  parseSessionJsonl,
  runSessionCollectorCli,
} from './session-collector.ts'
import { CAPABILITY_CATALOG, evaluateTrial } from './metrics.ts'
import { parseTasksJsonl } from './types.ts'

const TASK_LINE = JSON.stringify({
  schemaVersion: 1,
  id: 'live-web',
  category: 'low-risk',
  turns: [{ prompt: 'first' }, { prompt: 'second' }],
  requiredCapabilities: ['web.search'],
  allowedCapabilities: ['web.search'],
  approvalAnswers: ['allowed-once'],
  oracle: {
    all: [
      { kind: 'provider-call', provider: 'web-search-fixture', minCalls: 2 },
      { kind: 'final-regex', pattern: '^LIVE_OK$' },
    ],
  },
  scripts: {
    full: 'fixtures/full.jsonl',
    'raw-cordis': 'fixtures/raw.jsonl',
    controller: 'fixtures/controller.jsonl',
  },
})

const TASK = parseTasksJsonl(TASK_LINE, 'task.jsonl')[0]!

function persistedLog(rows: readonly Record<string, unknown>[]): string {
  const header = {
    type: 'session',
    version: 0,
    id: 'session-live',
    createdAt: 1,
    delegationDepth: 0,
  }
  const events = rows.map((row, seq) => {
    if (row.type === 'text-chunks' || row.type === 'reasoning-chunks' || row.type === 'tool-call-chunks') return row
    return { seq, time: seq + 10, ...row }
  })
  return `${[header, ...events].map(row => JSON.stringify(row)).join('\n')}\n`
}

function assistant(turn: number, step: number, text: string, withUsage = true): Record<string, unknown> {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: {
        role: 'assistant',
        content: text.length === 0 ? [] : [{ type: 'text', text }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        id: `message-${turn}-${step}`,
      },
      ...(withUsage ? { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 } } : {}),
    },
  }
}

function toolResult(turn: number, step: number, callId: string): Record<string, unknown> {
  return {
    type: 'tool/result',
    data: {
      turn,
      step,
      message: {
        role: 'user',
        source: { kind: 'tool', callId },
        id: `result-${callId}`,
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }],
      },
    },
  }
}

function controllerRows(): Record<string, unknown>[] {
  const controlTools = [
    { name: 'request_capability', description: 'request' },
    { name: 'release_capability', description: 'release' },
  ]
  const webTools = [...controlTools, { name: 'web_search', description: 'search' }]
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'fixture' }, tools: controlTools }, reason: 'initial' } },
    assistant(1, 1, ''),
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'request-1', name: 'request_capability', arguments: '{}' } },
    { type: 'capability/change', data: { kind: 'requested', version: 1, requestId: 'request-id-1', agentId: 'agent-1', capability: 'web.search', requestedScope: 'session', reason: 'needed' } },
    { type: 'capability/change', data: { kind: 'granted', version: 1, requestId: 'request-id-1', leaseId: 'lease-1', provider: 'web', risk: 'low', scope: 'session', binding: { kind: 'session' }, toolNames: ['web_search'], revokeAfterSuccess: false } },
    toolResult(1, 1, 'request-1'),
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'step/start', data: { turn: 1, step: 2 } },
    { type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'fixture' }, tools: webTools }, reason: 'change' } },
    assistant(1, 2, ''),
    { type: 'tool/call', data: { turn: 1, step: 2, callId: 'web-1', name: 'web_search', arguments: '{}' } },
    toolResult(1, 2, 'web-1'),
    { type: 'step/end', data: { turn: 1, step: 2 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'step/start', data: { turn: 2, step: 1 } },
    assistant(2, 1, ''),
    { type: 'approval/asked', data: { id: 'approval-1', toolName: 'request_capability' } },
    { type: 'approval/decided', data: { id: 'approval-1', outcome: 'allowed-once' } },
    { type: 'capability/change', data: { kind: 'requested', version: 1, requestId: 'request-id-2', agentId: 'agent-1', capability: 'web.search', requestedScope: 'session', reason: 'again' } },
    { type: 'capability/change', data: { kind: 'reused', version: 1, requestId: 'request-id-2', leaseId: 'lease-1' } },
    { type: 'tool/call', data: { turn: 2, step: 1, callId: 'web-2', name: 'web_search', arguments: '{}' } },
    toolResult(2, 1, 'web-2'),
    { type: 'step/end', data: { turn: 2, step: 1 } },
    { type: 'step/start', data: { turn: 2, step: 2 } },
    assistant(2, 2, 'LIVE_OK', false),
    { type: 'capability/change', data: { kind: 'revoked', version: 1, leaseId: 'lease-1', reason: 'released' } },
    { type: 'capability/change', data: { kind: 'requested', version: 1, requestId: 'request-id-3', agentId: 'agent-1', capability: 'foo.bar', requestedScope: 'turn', reason: 'unknown' } },
    { type: 'capability/change', data: { kind: 'denied', version: 1, requestId: 'request-id-3', code: 'registry-miss', reason: 'unknown' } },
    { type: 'step/end', data: { turn: 2, step: 2 } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

describe('Capability Controller real-session collector', () => {
  it('decodes production packed rows and enforces contiguous durable sequence numbers', () => {
    const text = persistedLog([
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'text-chunks',
        seq0: 1,
        time0: 11,
        data: { turn: 1, step: 1, index: 0, dt: [1], texts: ['a', 'b'] },
      },
      { type: 'turn/end', seq: 3, time: 13, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const parsed = parseSessionJsonl(text, 'session.jsonl')
    expect(parsed.events.map(event => event.type)).toEqual([
      'turn/start', 'assistant/chunk', 'assistant/chunk', 'turn/end',
    ])

    const gap = persistedLog([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    expect(() => parseSessionJsonl(gap, 'gap.jsonl')).toThrow('gap.jsonl: event seq gap')
  })

  it('projects schemas, usage coverage, lifecycle, intervention, entitlements, and oracles', async () => {
    const session = parseSessionJsonl(persistedLog(controllerRows()), 'session.jsonl')
    const trial = await collectSessionTrial({ session, task: TASK, mode: 'controller' })

    expect(trial).toMatchObject({
      schemaVersion: 1,
      taskId: 'live-web',
      mode: 'controller',
      oracleResults: [{ check: 0, passed: true }, { check: 1, passed: true }],
      interventions: 1,
      entitlements: [
        { capability: 'web.search', source: 'activation' },
        { capability: 'web.search', source: 'reuse' },
      ],
      lifecycle: { activation: 1, reuse: 1, revoke: 1, expire: 0, deny: 1 },
    })
    expect(trial.turns.map(turn => turn.steps.map(step => step.tools.map(tool => tool.name))))
      .toEqual([
        [
          ['request_capability', 'release_capability'],
          ['request_capability', 'release_capability', 'web_search'],
        ],
        [
          ['request_capability', 'release_capability', 'web_search'],
          ['request_capability', 'release_capability', 'web_search'],
        ],
      ])
    expect(trial.turns[1]!.steps[1]!.usage).toBeUndefined()
    expect(evaluateTrial(TASK, trial, CAPABILITY_CATALOG).tokens)
      .toMatchObject({ reportedSteps: 3, unreportedSteps: 1 })
  })

  it('requires a complete fresh task interval and lets exact provider counts override call proxies', async () => {
    const session = parseSessionJsonl(persistedLog(controllerRows()), 'session.jsonl')
    await expect(collectSessionTrial({
      session,
      task: TASK,
      mode: 'controller',
      providerCalls: { 'web-search-fixture': 0 },
    })).resolves.toMatchObject({
      oracleResults: [{ check: 0, passed: false }, { check: 1, passed: true }],
    })

    const incomplete = parseSessionJsonl(persistedLog(controllerRows().slice(0, -1)), 'open.jsonl')
    await expect(collectSessionTrial({ session: incomplete, task: TASK, mode: 'controller' }))
      .rejects.toThrow('open.jsonl: session contains an open turn')
  })
})

describe('Capability Controller session collector CLI', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('writes one normalized JSON trial from a persisted session artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-capability-eval-'))
    roots.push(root)
    const tasks = join(root, 'tasks.jsonl')
    const session = join(root, 'session.jsonl')
    const output = join(root, 'trial.json')
    await Promise.all([
      writeFile(tasks, `${TASK_LINE}\n`),
      writeFile(session, persistedLog(controllerRows())),
    ])

    await runSessionCollectorCli([
      '--session', session,
      '--tasks', tasks,
      '--task', 'live-web',
      '--mode', 'controller',
      '--output', output,
    ])

    const written = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(output, 'utf8'))) as {
      taskId: string
      lifecycle: { reuse: number }
    }
    expect(written).toMatchObject({ taskId: 'live-web', lifecycle: { reuse: 1 } })
  })
})
