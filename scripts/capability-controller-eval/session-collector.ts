/** Convert one persisted DSH session into a normalized Capability Controller eval trial. */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { zstdDecompress } from 'node:zlib'

import { CAPABILITY_CATALOG } from './metrics.ts'
import {
  EVAL_MODES,
  parseTasksJsonl,
  type EvalEntitlement,
  type EvalLifecycleCounts,
  type EvalMode,
  type EvalOracleResult,
  type EvalTask,
  type EvalTokenUsage,
  type EvalTrialFixture,
  type ToolSchemaSnapshot,
} from './types.ts'

const SESSION_FORMAT_VERSION = 0

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url))
const PROVIDER_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  'web-search-fixture': ['web_search'],
  'email-outbox-fixture': ['send_email'],
  'shell-workspace-fixture': ['bash', 'pwsh'],
}
const CAPABILITY_TOOL_NAMES = new Set(CAPABILITY_CATALOG.flatMap(row => row.toolNames))
const RAW_CORDIS_TOOL_NAMES = new Set(
  CAPABILITY_CATALOG.find(row => row.capability === 'cordis.runtime')?.toolNames ?? [],
)

/** One decoded durable event from a production session artifact. */
export interface EvalSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Readonly<Record<string, unknown>>
  readonly ignorable?: true
}

/** Header fields and expanded events read from one production session artifact. */
export interface EvalSessionLog {
  readonly source: string
  readonly header: {
    readonly version: number
    readonly id: string
    readonly createdAt: number
    readonly delegationDepth: number
    readonly seedLength?: number
    readonly cwd?: string
  }
  readonly events: readonly EvalSessionEvent[]
}

/** Inputs needed to project one complete, fresh eval-task session. */
export interface CollectSessionTrialOptions {
  readonly session: EvalSessionLog
  readonly task: EvalTask
  readonly mode: EvalMode
  /** Exact Provider invocation counts override the built-in successful-tool-result proxy. */
  readonly providerCalls?: Readonly<Record<string, number>>
  /** Workspace root used only by `file-sha256` oracle clauses. */
  readonly workspace?: string
}

interface MutableStep {
  readonly turn: number
  readonly step: number
  tools?: ToolSchemaSnapshot[]
  usage?: EvalTokenUsage
}

interface MutableTurn {
  readonly turn: number
  readonly steps: MutableStep[]
}

interface ActiveLease {
  readonly capability: string
  readonly toolNames: readonly string[]
  active: boolean
}

interface CollectionState {
  currentTools?: ToolSchemaSnapshot[]
  openTurn: MutableTurn | undefined
  openStep: MutableStep | undefined
  readonly turns: MutableTurn[]
  readonly requests: Map<string, string>
  readonly leases: Map<string, ActiveLease>
  readonly activeToolCounts: Map<string, number>
  readonly lifecycle: EvalLifecycleCounts
  readonly entitlements: EvalEntitlement[]
  readonly successfulToolCalls: Map<string, number>
  readonly pendingToolCalls: Map<string, string>
  readonly assistantTexts: string[]
  readonly failures: string[]
  interventions: number
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${at} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${at} must be a non-empty normalized string`)
  }
  return value
}

function nonNegativeInteger(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new Error(`${at} must be a non-negative safe integer`)
  }
  return value
}

function positiveInteger(value: unknown, at: string): number {
  const number = nonNegativeInteger(value, at)
  if (number === 0) throw new Error(`${at} must be a positive safe integer`)
  return number
}

function safeInteger(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${at} must be a safe integer`)
  }
  return value
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).length === expected.size
    && Object.keys(value).every(key => expected.has(key))
}

function packedStrings(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string')) {
    throw new Error(`${at} must be a non-empty string array`)
  }
  return value as string[]
}

/** Expand the three packed chunk rows written by session-persistence-jsonl. */
function decodeStorageRecord(value: unknown): readonly unknown[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [value]
  const row = value as Record<string, unknown>
  const tag = row.type
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') return [value]
  if (!hasExactKeys(row, ['type', 'seq0', 'time0', 'data'])) {
    throw new Error(`malformed ${tag} storage row: envelope fields are invalid`)
  }
  const seq0 = nonNegativeInteger(row.seq0, `${tag}.seq0`)
  const time0 = safeInteger(row.time0, `${tag}.time0`)
  const data = record(row.data, `${tag}.data`)
  const commonKeys = ['turn', 'step', 'index', 'dt']
  const payloadKey = tag === 'tool-call-chunks' ? 'args' : 'texts'
  const keys = tag === 'tool-call-chunks'
    ? [...commonKeys, 'id', payloadKey, ...Object.hasOwn(data, 'name') ? ['name'] : []]
    : [...commonKeys, payloadKey]
  if (!hasExactKeys(data, keys)) throw new Error(`malformed ${tag} storage row: data fields are invalid`)
  const turn = positiveInteger(data.turn, `${tag}.data.turn`)
  const step = positiveInteger(data.step, `${tag}.data.step`)
  const index = nonNegativeInteger(data.index, `${tag}.data.index`)
  const payload = packedStrings(data[payloadKey], `${tag}.data.${payloadKey}`)
  if (!Array.isArray(data.dt) || data.dt.some(gap => typeof gap !== 'number' || !Number.isSafeInteger(gap))) {
    throw new Error(`malformed ${tag} storage row: dt must be a safe-integer array`)
  }
  const gaps = data.dt as number[]
  if (gaps.length !== payload.length - 1) {
    throw new Error(`malformed ${tag} storage row: dt length does not match payload`)
  }
  if (!Number.isSafeInteger(seq0 + payload.length - 1)) {
    throw new Error(`malformed ${tag} storage row: expanded seq exceeds safe-integer range`)
  }
  const callId = tag === 'tool-call-chunks'
    ? nonEmptyString(data.id, `${tag}.data.id`)
    : undefined
  const name = data.name === undefined ? undefined : nonEmptyString(data.name, `${tag}.data.name`)
  const events: unknown[] = []
  let time = time0
  for (let offset = 0; offset < payload.length; offset++) {
    if (offset > 0) time += gaps[offset - 1] as number
    if (!Number.isSafeInteger(time)) {
      throw new Error(`malformed ${tag} storage row: expanded time exceeds safe-integer range`)
    }
    const chunk = tag === 'tool-call-chunks'
      ? {
        type: 'tool-call-delta',
        index,
        id: callId,
        ...name === undefined ? {} : { name },
        argumentsDelta: payload[offset],
      }
      : {
        type: tag === 'text-chunks' ? 'text-delta' : 'reasoning-delta',
        index,
        text: payload[offset],
      }
    events.push({
      type: 'assistant/chunk',
      seq: seq0 + offset,
      time,
      data: { turn, step, chunk },
    })
  }
  return events
}

function parseHeader(value: unknown, source: string): EvalSessionLog['header'] {
  const header = record(value, `${source}: header`)
  if (header.type !== 'session') throw new Error(`${source}: first record must be a session header`)
  const version = nonNegativeInteger(header.version, `${source}: header.version`)
  if (version !== SESSION_FORMAT_VERSION) {
    throw new Error(`${source}: session format ${version} is unsupported by this build (${SESSION_FORMAT_VERSION})`)
  }
  const seedLength = header.seedLength === undefined
    ? undefined
    : nonNegativeInteger(header.seedLength, `${source}: header.seedLength`)
  const cwd = header.cwd === undefined ? undefined : nonEmptyString(header.cwd, `${source}: header.cwd`)
  return {
    version,
    id: nonEmptyString(header.id, `${source}: header.id`),
    createdAt: nonNegativeInteger(header.createdAt, `${source}: header.createdAt`),
    delegationDepth: nonNegativeInteger(header.delegationDepth, `${source}: header.delegationDepth`),
    ...seedLength === undefined ? {} : { seedLength },
    ...cwd === undefined ? {} : { cwd },
  }
}

function parseEvent(value: unknown, source: string, line: number): EvalSessionEvent {
  const event = record(value, `${source}: line ${line}`)
  const ignorable = event.ignorable
  if (ignorable !== undefined && ignorable !== true) {
    throw new Error(`${source}: line ${line}: ignorable must be true when present`)
  }
  return {
    type: nonEmptyString(event.type, `${source}: line ${line}: type`),
    seq: nonNegativeInteger(event.seq, `${source}: line ${line}: seq`),
    time: nonNegativeInteger(event.time, `${source}: line ${line}: time`),
    data: record(event.data, `${source}: line ${line}: data`),
    ...ignorable === true ? { ignorable } : {},
  }
}

/**
 * Decode a plaintext production session JSONL artifact, including packed chunk rows.
 * @param text - complete plaintext artifact bytes decoded as UTF-8.
 * @param source - diagnostic path or label.
 * @returns validated header and expanded, contiguous durable events.
 */
export function parseSessionJsonl(text: string, source: string): EvalSessionLog {
  const lines = text.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0 || lines[0]?.trim().length === 0) {
    throw new Error(`${source}: session artifact is empty`)
  }
  let headerValue: unknown
  try {
    headerValue = JSON.parse(lines[0] as string) as unknown
  } catch (error: unknown) {
    throw new Error(`${source}: header is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const header = parseHeader(headerValue, source)
  const events: EvalSessionEvent[] = []
  for (let index = 1; index < lines.length; index++) {
    const raw = lines[index] as string
    if (raw.length === 0) throw new Error(`${source}: line ${index + 1}: empty records are not allowed`)
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch (error: unknown) {
      throw new Error(`${source}: line ${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    let expanded: readonly unknown[]
    try {
      expanded = decodeStorageRecord(value)
    } catch (error: unknown) {
      throw new Error(`${source}: line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const decoded of expanded) {
      const event = parseEvent(decoded, source, index + 1)
      if (event.seq !== events.length) {
        throw new Error(`${source}: event seq gap: expected ${events.length}, received ${event.seq}`)
      }
      events.push(event)
    }
  }
  return { source, header, events }
}

function decompressZstd(input: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    zstdDecompress(input, (error, output) => {
      if (error !== null) reject(error)
      else resolvePromise(output)
    })
  })
}

/**
 * Read a plaintext or Zstandard production session artifact.
 * @param path - `.jsonl` or `.jsonl.zstd` artifact path.
 * @returns validated header and expanded events.
 * @public
 */
export async function readSessionArtifact(path: string): Promise<EvalSessionLog> {
  const bytes = await readFile(path)
  const plaintext = path.endsWith('.zstd') ? await decompressZstd(bytes) : bytes
  return parseSessionJsonl(plaintext.toString('utf8'), path)
}

function parseToolSchemas(value: unknown, at: string): ToolSchemaSnapshot[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${at} must be an array when present`)
  const names = new Set<string>()
  return value.map((candidate, index) => {
    const schema = record(candidate, `${at}[${index}]`)
    const name = nonEmptyString(schema.name, `${at}[${index}].name`)
    if (names.has(name)) throw new Error(`${at} contains duplicate tool ${JSON.stringify(name)}`)
    names.add(name)
    return schema as ToolSchemaSnapshot
  })
}

function parseUsage(value: unknown, at: string): EvalTokenUsage | undefined {
  if (value === undefined) return undefined
  const usage = record(value, at)
  const optional = (name: string): number | undefined => usage[name] === undefined
    ? undefined
    : nonNegativeInteger(usage[name], `${at}.${name}`)
  const cacheReadTokens = optional('cacheReadTokens')
  const cacheWriteTokens = optional('cacheWriteTokens')
  const reasoningTokens = optional('reasoningTokens')
  return {
    inputTokens: nonNegativeInteger(usage.inputTokens, `${at}.inputTokens`),
    outputTokens: nonNegativeInteger(usage.outputTokens, `${at}.outputTokens`),
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

function messageText(value: unknown, at: string): string {
  const message = record(value, at)
  if (!Array.isArray(message.content)) throw new Error(`${at}.content must be an array`)
  return message.content.map((candidate, index) => {
    const block = record(candidate, `${at}.content[${index}]`)
    return block.type === 'text' ? nonEmptyString(block.text, `${at}.content[${index}].text`) : ''
  }).join('')
}

function toolResultSucceeded(value: unknown, at: string): boolean {
  const message = record(value, at)
  if (!Array.isArray(message.content)) throw new Error(`${at}.content must be an array`)
  const results = message.content.map((candidate, index) => {
    const block = record(candidate, `${at}.content[${index}]`)
    return block.type === 'tool-result' ? block : undefined
  }).filter(result => result !== undefined)
  if (results.length !== 1 || typeof results[0]?.isError !== 'boolean') {
    throw new Error(`${at} must contain exactly one tool-result block with isError`)
  }
  return !results[0].isError
}

function eventTurnStep(data: Readonly<Record<string, unknown>>, at: string): { turn: number; step: number } {
  return {
    turn: positiveInteger(data.turn, `${at}.turn`),
    step: positiveInteger(data.step, `${at}.step`),
  }
}

function assertOpenStep(state: CollectionState, data: Readonly<Record<string, unknown>>, at: string): MutableStep {
  const open = state.openStep
  if (open === undefined) throw new Error(`${at} occurred outside an open step`)
  const identity = eventTurnStep(data, at)
  if (identity.turn !== open.turn || identity.step !== open.step) {
    throw new Error(`${at} targets turn ${identity.turn} step ${identity.step}, but ${open.turn}/${open.step} is open`)
  }
  return open
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function decrement(map: Map<string, number>, key: string, at: string): void {
  const current = map.get(key) ?? 0
  if (current < 1) throw new Error(`${at} cannot deactivate missing tool ${JSON.stringify(key)}`)
  if (current === 1) map.delete(key)
  else map.set(key, current - 1)
}

function stringArray(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${at} must be a non-empty array`)
  const values = value.map((item, index) => nonEmptyString(item, `${at}[${index}]`))
  if (new Set(values).size !== values.length) throw new Error(`${at} must contain unique values`)
  return values
}

function requestCapability(state: CollectionState, data: Readonly<Record<string, unknown>>, at: string): void {
  if (data.version !== 1) throw new Error(`${at}.version must be 1`)
  const requestId = nonEmptyString(data.requestId, `${at}.requestId`)
  if (state.requests.has(requestId)) throw new Error(`${at} repeats request id ${JSON.stringify(requestId)}`)
  state.requests.set(requestId, nonEmptyString(data.capability, `${at}.capability`))
}

function resolveRequest(state: CollectionState, data: Readonly<Record<string, unknown>>, at: string): {
  requestId: string
  capability: string
} {
  if (data.version !== 1) throw new Error(`${at}.version must be 1`)
  const requestId = nonEmptyString(data.requestId, `${at}.requestId`)
  const capability = state.requests.get(requestId)
  if (capability === undefined) throw new Error(`${at} has no pending request ${JSON.stringify(requestId)}`)
  state.requests.delete(requestId)
  return { requestId, capability }
}

function endLease(state: CollectionState, data: Readonly<Record<string, unknown>>, at: string): ActiveLease {
  if (data.version !== 1) throw new Error(`${at}.version must be 1`)
  const leaseId = nonEmptyString(data.leaseId, `${at}.leaseId`)
  const lease = state.leases.get(leaseId)
  if (lease === undefined || !lease.active) throw new Error(`${at} has no active lease ${JSON.stringify(leaseId)}`)
  lease.active = false
  for (const toolName of lease.toolNames) decrement(state.activeToolCounts, toolName, at)
  return lease
}

function capabilityChange(state: CollectionState, data: Readonly<Record<string, unknown>>, at: string): void {
  const kind = nonEmptyString(data.kind, `${at}.kind`)
  switch (kind) {
    case 'requested':
      requestCapability(state, data, at)
      return
    case 'granted': {
      const { capability } = resolveRequest(state, data, at)
      const leaseId = nonEmptyString(data.leaseId, `${at}.leaseId`)
      if (state.leases.has(leaseId)) throw new Error(`${at} repeats lease id ${JSON.stringify(leaseId)}`)
      const toolNames = stringArray(data.toolNames, `${at}.toolNames`)
      state.leases.set(leaseId, { capability, toolNames, active: true })
      for (const toolName of toolNames) increment(state.activeToolCounts, toolName)
      state.lifecycle.activation += 1
      state.entitlements.push({ capability, source: 'activation' })
      return
    }
    case 'reused': {
      const { capability } = resolveRequest(state, data, at)
      const leaseId = nonEmptyString(data.leaseId, `${at}.leaseId`)
      const lease = state.leases.get(leaseId)
      if (lease === undefined || !lease.active) throw new Error(`${at} has no active lease ${JSON.stringify(leaseId)}`)
      if (lease.capability !== capability) {
        throw new Error(`${at} request capability ${JSON.stringify(capability)} does not match lease ${JSON.stringify(lease.capability)}`)
      }
      state.lifecycle.reuse += 1
      state.entitlements.push({ capability, source: 'reuse' })
      return
    }
    case 'denied':
      resolveRequest(state, data, at)
      state.lifecycle.deny += 1
      return
    case 'revoked':
      endLease(state, data, at)
      state.lifecycle.revoke += 1
      return
    case 'expired':
      endLease(state, data, at)
      state.lifecycle.expire += 1
      return
    case 'used':
      if (data.version !== 1) throw new Error(`${at}.version must be 1`)
      return
    default:
      throw new Error(`${at}.kind is unsupported: ${JSON.stringify(kind)}`)
  }
}

function assertControllerSchema(state: CollectionState, tools: readonly ToolSchemaSnapshot[], at: string): void {
  const names = new Set(tools.map(tool => tool.name))
  for (const raw of RAW_CORDIS_TOOL_NAMES) {
    if (names.has(raw)) throw new Error(`${at} exposes forbidden Raw Cordis tool ${JSON.stringify(raw)}`)
  }
  for (const name of CAPABILITY_TOOL_NAMES) {
    const visible = names.has(name)
    const leased = (state.activeToolCounts.get(name) ?? 0) > 0
    if (visible !== leased) {
      throw new Error(`${at} ${visible ? 'exposes unleased' : 'omits leased'} capability tool ${JSON.stringify(name)}`)
    }
  }
}

function processEvent(state: CollectionState, event: EvalSessionEvent, mode: EvalMode, source: string): void {
  const at = `${source}: event ${event.seq} (${event.type})`
  switch (event.type) {
    case 'turn/start': {
      if (state.openTurn !== undefined) throw new Error(`${at} opened while turn ${state.openTurn.turn} remains open`)
      const turn = positiveInteger(event.data.turn, `${at}.turn`)
      if (turn !== state.turns.length + 1) {
        throw new Error(`${at} proves this is not a fresh contiguous eval session (expected turn ${state.turns.length + 1})`)
      }
      state.openTurn = { turn, steps: [] }
      return
    }
    case 'turn/end': {
      if (state.openStep !== undefined) throw new Error(`${at} closed a turn while step ${state.openStep.step} remains open`)
      const open = state.openTurn
      if (open === undefined) throw new Error(`${at} occurred without an open turn`)
      const turn = positiveInteger(event.data.turn, `${at}.turn`)
      if (turn !== open.turn) throw new Error(`${at} targets turn ${turn}, but turn ${open.turn} is open`)
      const reason = record(event.data.reason, `${at}.reason`)
      const kind = nonEmptyString(reason.kind, `${at}.reason.kind`)
      if (kind === 'error' || kind === 'aborted' || kind === 'blocked' || kind === 'interrupted') {
        state.failures.push(`turn ${turn} ended ${kind}`)
      }
      if (open.steps.length === 0) throw new Error(`${at} closed an eval turn with no model step`)
      state.turns.push(open)
      state.openTurn = undefined
      return
    }
    case 'step/start': {
      const openTurn = state.openTurn
      if (openTurn === undefined) throw new Error(`${at} occurred outside an open turn`)
      if (state.openStep !== undefined) throw new Error(`${at} opened while step ${state.openStep.step} remains open`)
      const identity = eventTurnStep(event.data, at)
      if (identity.turn !== openTurn.turn || identity.step !== openTurn.steps.length + 1) {
        throw new Error(`${at} is not the next step of open turn ${openTurn.turn}`)
      }
      state.openStep = { ...identity }
      return
    }
    case 'step/end': {
      const open = assertOpenStep(state, event.data, at)
      if (state.currentTools === undefined) throw new Error(`${at} has no preceding request/header snapshot`)
      open.tools = state.currentTools
      state.openTurn?.steps.push(open)
      state.openStep = undefined
      return
    }
    case 'request/header': {
      if (state.openStep === undefined) throw new Error(`${at} occurred outside an open step`)
      const header = record(event.data.header, `${at}.header`)
      const tools = parseToolSchemas(header.tools, `${at}.header.tools`)
      if (mode === 'controller') assertControllerSchema(state, tools, at)
      state.currentTools = tools
      return
    }
    case 'assistant/message': {
      const step = assertOpenStep(state, event.data, at)
      if (step.usage !== undefined) throw new Error(`${at} repeats the assistant message for this step`)
      const usage = parseUsage(event.data.usage, `${at}.usage`)
      if (usage !== undefined) step.usage = usage
      const text = messageText(event.data.message, `${at}.message`)
      if (text.length > 0) state.assistantTexts.push(text)
      return
    }
    case 'tool/call': {
      assertOpenStep(state, event.data, at)
      const callId = nonEmptyString(event.data.callId, `${at}.callId`)
      if (state.pendingToolCalls.has(callId)) throw new Error(`${at} repeats call id ${JSON.stringify(callId)}`)
      state.pendingToolCalls.set(callId, nonEmptyString(event.data.name, `${at}.name`))
      return
    }
    case 'tool/result': {
      assertOpenStep(state, event.data, at)
      const message = record(event.data.message, `${at}.message`)
      const sourceRecord = record(message.source, `${at}.message.source`)
      const callId = nonEmptyString(sourceRecord.callId, `${at}.message.source.callId`)
      const toolName = state.pendingToolCalls.get(callId)
      if (toolName === undefined) throw new Error(`${at} has no pending tool call ${JSON.stringify(callId)}`)
      state.pendingToolCalls.delete(callId)
      if (toolResultSucceeded(message, `${at}.message`)) increment(state.successfulToolCalls, toolName)
      return
    }
    case 'capability/change':
      if (mode !== 'controller') throw new Error(`${at} appeared in non-controller mode ${mode}`)
      capabilityChange(state, event.data, at)
      return
    case 'approval/asked':
      state.interventions += 1
      return
    default:
      return
  }
}

function visibleCapabilities(tools: readonly ToolSchemaSnapshot[]): Set<string> {
  const names = new Set(tools.map(tool => tool.name))
  return new Set(CAPABILITY_CATALOG
    .filter(definition => definition.toolNames.some(name => names.has(name)))
    .map(definition => definition.capability))
}

function deriveUncontrolledLifecycle(state: CollectionState): void {
  const steps = state.turns.flatMap(turn => turn.steps)
  const first = steps[0]
  if (first === undefined || first.tools === undefined) return
  let previous = visibleCapabilities(first.tools)
  for (const capability of previous) state.entitlements.push({ capability, source: 'initial' })
  for (const step of steps.slice(1)) {
    const current = visibleCapabilities(step.tools ?? [])
    for (const capability of current) {
      if (!previous.has(capability)) {
        state.lifecycle.activation += 1
        state.entitlements.push({ capability, source: 'activation' })
      }
    }
    for (const capability of previous) {
      if (!current.has(capability)) state.lifecycle.revoke += 1
    }
    previous = current
  }
}

async function fileSha256(workspace: string | undefined, path: string): Promise<string | undefined> {
  if (workspace === undefined) return undefined
  const bytes = await readFile(resolve(workspace, path))
  return createHash('sha256').update(bytes).digest('hex')
}

function successfulProviderCalls(state: CollectionState, provider: string): number | undefined {
  const toolNames = PROVIDER_TOOL_NAMES[provider]
  if (toolNames === undefined) return undefined
  return toolNames.reduce((sum, name) => sum + (state.successfulToolCalls.get(name) ?? 0), 0)
}

async function oracleResults(
  options: CollectSessionTrialOptions,
  state: CollectionState,
): Promise<EvalOracleResult[]> {
  const finalText = state.assistantTexts.at(-1) ?? ''
  const results: EvalOracleResult[] = []
  for (const [index, check] of options.task.oracle.all.entries()) {
    let passed = false
    let detail: string | undefined
    switch (check.kind) {
      case 'final-regex': {
        try {
          passed = new RegExp(check.pattern, check.flags).test(finalText)
          detail = passed ? undefined : `final assistant text did not match /${check.pattern}/${check.flags ?? ''}`
        } catch (error: unknown) {
          detail = `invalid oracle regular expression: ${error instanceof Error ? error.message : String(error)}`
        }
        break
      }
      case 'provider-call':
      case 'provider-no-call': {
        const exact = options.providerCalls?.[check.provider]
        if (exact !== undefined) nonNegativeInteger(exact, `providerCalls.${check.provider}`)
        const calls = exact ?? successfulProviderCalls(state, check.provider)
        if (calls === undefined) {
          detail = `no exact count or successful-tool mapping for provider ${JSON.stringify(check.provider)}`
          break
        }
        passed = check.kind === 'provider-call' ? calls >= check.minCalls : calls === 0
        if (!passed) detail = `${check.provider} call count was ${calls}`
        break
      }
      case 'file-sha256': {
        try {
          const actual = await fileSha256(options.workspace, check.path)
          passed = actual === check.sha256
          detail = actual === undefined
            ? 'file-sha256 oracle requires a workspace root'
            : passed ? undefined : `${check.path} sha256 was ${actual}`
        } catch (error: unknown) {
          detail = `${check.path} could not be hashed: ${error instanceof Error ? error.message : String(error)}`
        }
        break
      }
    }
    if (state.failures.length > 0) {
      passed = false
      detail = `runtime failure: ${state.failures.join('; ')}`
    }
    results.push({ check: index, passed, ...detail === undefined ? {} : { detail } })
  }
  return results
}

function emptyState(): CollectionState {
  return {
    openTurn: undefined,
    openStep: undefined,
    turns: [],
    requests: new Map(),
    leases: new Map(),
    activeToolCounts: new Map(),
    lifecycle: { activation: 0, reuse: 0, revoke: 0, expire: 0, deny: 0 },
    entitlements: [],
    successfulToolCalls: new Map(),
    pendingToolCalls: new Map(),
    assistantTexts: [],
    failures: [],
    interventions: 0,
  }
}

/**
 * Project one complete, fresh DSH session into the normalized trial vocabulary.
 * @param options - session facts, fixed task, comparison mode, and external oracle observations.
 * @returns a normalized trial ready for the metric layer.
 */
export async function collectSessionTrial(options: CollectSessionTrialOptions): Promise<EvalTrialFixture> {
  const state = emptyState()
  for (const event of options.session.events) processEvent(state, event, options.mode, options.session.source)
  if (state.openStep !== undefined) {
    throw new Error(`${options.session.source}: session contains an open step ${state.openStep.turn}/${state.openStep.step}`)
  }
  if (state.openTurn !== undefined) {
    throw new Error(`${options.session.source}: session contains an open turn ${state.openTurn.turn}`)
  }
  if (state.pendingToolCalls.size > 0) {
    throw new Error(`${options.session.source}: session has ${state.pendingToolCalls.size} tool call(s) without results`)
  }
  if (state.requests.size > 0) {
    throw new Error(`${options.session.source}: session has ${state.requests.size} unresolved capability request(s)`)
  }
  if (state.turns.length !== options.task.turns.length) {
    throw new Error(`${options.session.source}: session has ${state.turns.length} turns; task ${options.task.id} requires ${options.task.turns.length}`)
  }
  if (options.mode !== 'controller') deriveUncontrolledLifecycle(state)
  return {
    schemaVersion: 1,
    taskId: options.task.id,
    mode: options.mode,
    oracleResults: await oracleResults(options, state),
    interventions: state.interventions,
    entitlements: state.entitlements,
    lifecycle: state.lifecycle,
    turns: state.turns.map(turn => ({
      steps: turn.steps.map(step => ({
        tools: step.tools ?? [],
        ...step.usage === undefined ? {} : { usage: step.usage },
      })),
    })),
  }
}

function providerCallCounts(values: readonly string[] | undefined): Record<string, number> | undefined {
  if (values === undefined) return undefined
  const counts: Record<string, number> = {}
  for (const value of values) {
    const separator = value.lastIndexOf('=')
    if (separator < 1 || separator === value.length - 1) {
      throw new Error('--provider-call must use <provider>=<non-negative-count>')
    }
    const provider = value.slice(0, separator)
    if (Object.hasOwn(counts, provider)) throw new Error(`--provider-call repeats ${JSON.stringify(provider)}`)
    counts[provider] = nonNegativeInteger(Number(value.slice(separator + 1)), `--provider-call ${provider}`)
  }
  return counts
}

function selectedMode(value: string): EvalMode {
  if (!(EVAL_MODES as readonly string[]).includes(value)) {
    throw new Error(`--mode must be one of ${EVAL_MODES.join(', ')}`)
  }
  return value as EvalMode
}

/** Run the single-session collector command. */
export async function runSessionCollectorCli(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      session: { type: 'string' },
      tasks: { type: 'string', default: resolve(SCRIPT_ROOT, 'tasks.jsonl') },
      task: { type: 'string' },
      mode: { type: 'string' },
      workspace: { type: 'string' },
      'provider-call': { type: 'string', multiple: true },
      output: { type: 'string' },
    },
  })
  if (values.session === undefined) throw new Error('--session is required')
  if (values.task === undefined) throw new Error('--task is required')
  if (values.mode === undefined) throw new Error('--mode is required')
  const tasksPath = resolve(values.tasks)
  const tasks = parseTasksJsonl(await readFile(tasksPath, 'utf8'), tasksPath)
  const task = tasks.find(candidate => candidate.id === values.task)
  if (task === undefined) throw new Error(`unknown eval task ${JSON.stringify(values.task)}`)
  const trial = await collectSessionTrial({
    session: await readSessionArtifact(resolve(values.session)),
    task,
    mode: selectedMode(values.mode),
    ...values.workspace === undefined ? {} : { workspace: resolve(values.workspace) },
    ...values['provider-call'] === undefined ? {} : { providerCalls: providerCallCounts(values['provider-call']) ?? {} },
  })
  const output = `${JSON.stringify(trial, null, 2)}\n`
  if (values.output === undefined) {
    process.stdout.write(output)
    return
  }
  const outputPath = resolve(values.output)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, output)
  process.stderr.write(`capability-controller-eval: wrote ${outputPath}\n`)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    await runSessionCollectorCli(process.argv.slice(2))
  } catch (error: unknown) {
    process.stderr.write(`capability-controller-eval: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
