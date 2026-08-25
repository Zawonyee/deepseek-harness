/** Versioned data contracts and strict JSONL readers for the Capability Controller eval. */

/** Stable comparison modes used by every task and result. */
export const EVAL_MODES = ['full', 'raw-cordis', 'controller'] as const

/** One supported comparison mode. */
export type EvalMode = typeof EVAL_MODES[number]

/** Registry risk vocabulary shared with the Controller. */
export type EvalRisk = 'low' | 'medium' | 'high' | 'critical'

/** Approval outcomes supplied by the deterministic interaction fixture. */
type EvalApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Lossless JSON value used by fixture tool schemas. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** One model-visible schema snapshot; the evaluator treats all fields after `name` opaquely. */
export type ToolSchemaSnapshot = { name: string; [key: string]: JsonValue }

/** Machine-checkable success condition for one task. */
type EvalOracleCheck =
  | { kind: 'final-regex'; pattern: string; flags?: string }
  | { kind: 'provider-call'; provider: string; minCalls: number }
  | { kind: 'provider-no-call'; provider: string }
  | { kind: 'file-sha256'; path: string; sha256: string }

/** One fixed task in `tasks.jsonl`. */
export interface EvalTask {
  schemaVersion: 1
  id: string
  category: 'core' | 'low-risk' | 'high-risk' | 'mixed'
  turns: { prompt: string }[]
  requiredCapabilities: string[]
  allowedCapabilities: string[]
  approvalAnswers: EvalApprovalOutcome[]
  workspaceFixture?: string
  oracle: { all: EvalOracleCheck[] }
  scripts: Record<EvalMode, string>
}

/** Token usage reported by one scripted or live model step. Counts are disjoint. */
export interface EvalTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** One model request and the exact tool schemas visible on it. */
interface EvalStepFixture {
  tools: ToolSchemaSnapshot[]
  /** Real adapters may omit usage; committed scripted fixtures must report it. */
  usage?: EvalTokenUsage
}

/** One user turn containing one or more model requests. */
interface EvalTurnFixture {
  steps: EvalStepFixture[]
}

/** Normalized capability availability, independent of how a mode obtained it. */
export interface EvalEntitlement {
  capability: string
  source: 'initial' | 'activation' | 'reuse'
}

/** Normalized lifecycle counts emitted by one trial. */
export interface EvalLifecycleCounts {
  activation: number
  reuse: number
  revoke: number
  expire: number
  deny: number
}

/** Result of one task oracle clause. */
export interface EvalOracleResult {
  check: number
  passed: boolean
  detail?: string
}

/** Scripted or live observation consumed by the metric layer. */
export interface EvalTrialFixture {
  schemaVersion: 1
  taskId: string
  mode: EvalMode
  oracleResults: EvalOracleResult[]
  interventions: number
  entitlements: EvalEntitlement[]
  lifecycle: EvalLifecycleCounts
  turns: EvalTurnFixture[]
}

const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const
const TASK_CATEGORIES = ['core', 'low-risk', 'high-risk', 'mixed'] as const
const ENTITLEMENT_SOURCES = ['initial', 'activation', 'reuse'] as const

function location(source: string, line: number): string {
  return `${source}: line ${line}`
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${at}: expected an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${at} must be a non-empty string`)
  }
  return value
}

function stringArray(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${at} must be an array`)
  return value.map((item, index) => string(item, `${at}[${index}]`))
}

function nonNegativeInteger(value: unknown, at: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${at} must be a non-negative safe integer`)
  }
  return value as number
}

function oneOf<T extends string>(value: unknown, values: readonly T[], at: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Error(`${at} must be one of ${values.join(', ')}`)
  }
  return value as T
}

function safeRelativePath(value: unknown, at: string): string {
  const path = string(value, at)
  const segments = path.split('/')
  if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/u.test(path)
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${at} must be a safe repository-relative path`)
  }
  return path
}

function parseJsonLines(text: string, source: string): { line: number; value: unknown }[] {
  const rows: { line: number; value: unknown }[] = []
  text.split(/\r?\n/u).forEach((raw, index) => {
    if (raw.trim().length === 0) return
    try {
      rows.push({ line: index + 1, value: JSON.parse(raw) as unknown })
    } catch (error: unknown) {
      throw new Error(`${location(source, index + 1)}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  if (rows.length === 0) throw new Error(`${source}: document contains no JSONL rows`)
  return rows
}

function parseOracle(value: unknown, at: string): { all: EvalOracleCheck[] } {
  const outer = record(value, at)
  if (!Array.isArray(outer.all) || outer.all.length === 0) throw new Error(`${at}.all must be a non-empty array`)
  const all = outer.all.map((item, index): EvalOracleCheck => {
    const checkAt = `${at}.all[${index}]`
    const check = record(item, checkAt)
    switch (check.kind) {
      case 'final-regex':
        return {
          kind: check.kind,
          pattern: string(check.pattern, `${checkAt}.pattern`),
          ...check.flags === undefined ? {} : { flags: string(check.flags, `${checkAt}.flags`) },
        }
      case 'provider-call':
        return {
          kind: check.kind,
          provider: string(check.provider, `${checkAt}.provider`),
          minCalls: nonNegativeInteger(check.minCalls, `${checkAt}.minCalls`),
        }
      case 'provider-no-call':
        return { kind: check.kind, provider: string(check.provider, `${checkAt}.provider`) }
      case 'file-sha256':
        if (typeof check.sha256 !== 'string' || !/^[a-f\d]{64}$/u.test(check.sha256)) {
          throw new Error(`${checkAt}.sha256 must be 64 lowercase hexadecimal characters`)
        }
        return {
          kind: check.kind,
          path: safeRelativePath(check.path, `${checkAt}.path`),
          sha256: check.sha256,
        }
      default:
        throw new Error(`${checkAt}.kind must be one of final-regex, provider-call, provider-no-call, file-sha256`)
    }
  })
  return { all }
}

/** Parse and validate the complete fixed task corpus. */
export function parseTasksJsonl(text: string, source: string): EvalTask[] {
  const seen = new Set<string>()
  return parseJsonLines(text, source).map(({ line, value }) => {
    const at = location(source, line)
    const row = record(value, at)
    if (row.schemaVersion !== 1) throw new Error(`${at}: schemaVersion must be 1`)
    const id = string(row.id, `${at}: id`)
    if (seen.has(id)) throw new Error(`${source}: duplicate task id ${JSON.stringify(id)}`)
    seen.add(id)
    if (!Array.isArray(row.turns) || row.turns.length === 0) throw new Error(`${at}: turns must be a non-empty array`)
    const turns = row.turns.map((value, index) => {
      const turn = record(value, `${at}: turns[${index}]`)
      return { prompt: string(turn.prompt, `${at}: turns[${index}].prompt`) }
    })
    const requiredCapabilities = stringArray(row.requiredCapabilities, `${at}: requiredCapabilities`)
    const allowedCapabilities = stringArray(row.allowedCapabilities, `${at}: allowedCapabilities`)
    for (const capability of requiredCapabilities) {
      if (!allowedCapabilities.includes(capability)) {
        throw new Error(`${at}: required capability ${JSON.stringify(capability)} is not allowed`)
      }
    }
    if (!Array.isArray(row.approvalAnswers)) throw new Error(`${at}: approvalAnswers must be an array`)
    const approvalAnswers = row.approvalAnswers.map((answer, index) =>
      oneOf(answer, APPROVAL_OUTCOMES, `${at}: approvalAnswers[${index}]`))
    const scriptsRow = record(row.scripts, `${at}: scripts`)
    const scripts = Object.fromEntries(EVAL_MODES.map(mode => [
      mode,
      safeRelativePath(scriptsRow[mode], `${at}: scripts.${mode}`),
    ])) as Record<EvalMode, string>
    return {
      schemaVersion: 1,
      id,
      category: oneOf(row.category, TASK_CATEGORIES, `${at}: category`),
      turns,
      requiredCapabilities,
      allowedCapabilities,
      approvalAnswers,
      ...row.workspaceFixture === undefined
        ? {}
        : { workspaceFixture: safeRelativePath(row.workspaceFixture, `${at}: workspaceFixture`) },
      oracle: parseOracle(row.oracle, `${at}: oracle`),
      scripts,
    }
  })
}

function parseUsage(value: unknown, at: string): EvalTokenUsage | undefined {
  if (value === undefined) return undefined
  const row = record(value, at)
  return {
    inputTokens: nonNegativeInteger(row.inputTokens, `${at}.inputTokens`),
    outputTokens: nonNegativeInteger(row.outputTokens, `${at}.outputTokens`),
    ...row.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: nonNegativeInteger(row.cacheReadTokens, `${at}.cacheReadTokens`) },
    ...row.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: nonNegativeInteger(row.cacheWriteTokens, `${at}.cacheWriteTokens`) },
    ...row.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: nonNegativeInteger(row.reasoningTokens, `${at}.reasoningTokens`) },
  }
}

function parseTool(value: unknown, at: string): ToolSchemaSnapshot {
  const row = record(value, at)
  const name = string(row.name, `${at}.name`)
  try {
    return JSON.parse(JSON.stringify({ ...row, name })) as ToolSchemaSnapshot
  } catch (error: unknown) {
    throw new Error(`${at} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Controls source-specific requirements layered over the shared trial vocabulary. */
export interface ParseTrialOptions {
  /** Require every model step to report token usage, as committed scripted fixtures do. */
  requireUsage?: boolean
}

/** Parse normalized scripted or live trial observations. */
export function parseTrialJsonl(
  text: string,
  source: string,
  options: ParseTrialOptions = {},
): EvalTrialFixture[] {
  return parseJsonLines(text, source).map(({ line, value }) => {
    const at = location(source, line)
    const row = record(value, at)
    if (row.schemaVersion !== 1) throw new Error(`${at}: schemaVersion must be 1`)
    if (!Array.isArray(row.oracleResults) || row.oracleResults.length === 0) {
      throw new Error(`${at}: oracleResults must be a non-empty array`)
    }
    const oracleResults = row.oracleResults.map((value, index): EvalOracleResult => {
      const resultAt = `${at}: oracleResults[${index}]`
      const result = record(value, resultAt)
      if (typeof result.passed !== 'boolean') throw new Error(`${resultAt}.passed must be boolean`)
      return {
        check: nonNegativeInteger(result.check, `${resultAt}.check`),
        passed: result.passed,
        ...result.detail === undefined ? {} : { detail: string(result.detail, `${resultAt}.detail`) },
      }
    })
    if (!Array.isArray(row.entitlements)) throw new Error(`${at}: entitlements must be an array`)
    const entitlements = row.entitlements.map((value, index): EvalEntitlement => {
      const entitlementAt = `${at}: entitlements[${index}]`
      const entitlement = record(value, entitlementAt)
      return {
        capability: string(entitlement.capability, `${entitlementAt}.capability`),
        source: oneOf(entitlement.source, ENTITLEMENT_SOURCES, `${entitlementAt}.source`),
      }
    })
    const lifecycleRow = record(row.lifecycle, `${at}: lifecycle`)
    const lifecycle = Object.fromEntries(
      ['activation', 'reuse', 'revoke', 'expire', 'deny'].map(key => [
        key,
        nonNegativeInteger(lifecycleRow[key], `${at}: lifecycle.${key}`),
      ]),
    ) as unknown as EvalLifecycleCounts
    if (!Array.isArray(row.turns) || row.turns.length === 0) throw new Error(`${at}: turns must be a non-empty array`)
    const turns = row.turns.map((value, turnIndex): EvalTurnFixture => {
      const turnAt = `${at}: turns[${turnIndex}]`
      const turn = record(value, turnAt)
      if (!Array.isArray(turn.steps) || turn.steps.length === 0) {
        throw new Error(`${turnAt}.steps must be a non-empty array`)
      }
      return {
        steps: turn.steps.map((value, stepIndex): EvalStepFixture => {
          const stepAt = `${turnAt}.steps[${stepIndex}]`
          const step = record(value, stepAt)
          if (!Array.isArray(step.tools)) throw new Error(`${stepAt}.tools must be an array`)
          const usage = parseUsage(step.usage, `${stepAt}.usage`)
          if (options.requireUsage === true && usage === undefined) {
            throw new Error(`${stepAt}.usage is required`)
          }
          return {
            tools: step.tools.map((tool, toolIndex) => parseTool(tool, `${stepAt}.tools[${toolIndex}]`)),
            ...usage === undefined ? {} : { usage },
          }
        }),
      }
    })
    return {
      schemaVersion: 1,
      taskId: string(row.taskId, `${at}: taskId`),
      mode: oneOf(row.mode, EVAL_MODES, `${at}: mode`),
      oracleResults,
      interventions: nonNegativeInteger(row.interventions, `${at}: interventions`),
      entitlements,
      lifecycle,
      turns,
    }
  })
}
