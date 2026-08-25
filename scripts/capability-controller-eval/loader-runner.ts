/** Drive real Loader compositions and AgentLoop turns for the Capability Controller benchmark. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { CallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import type { FixtureProviderCalls } from './compositions/composition.ts'
import { CAPABILITY_CATALOG, aggregateTrials, evaluateTrial, type EvalBenchmarkSummary } from './metrics.ts'
import { collectSessionTrial, type EvalSessionEvent } from './session-collector.ts'
import {
  EVAL_MODES,
  parseTasksJsonl,
  type EvalMode,
  type EvalTask,
  type EvalTrialFixture,
} from './types.ts'

const NAME = 'capability-controller-eval-loader'
const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_ROOT, '..', '..')
const DEFAULT_TASKS = resolve(SCRIPT_ROOT, 'tasks.jsonl')
const DEFAULT_OUTPUT = resolve(REPOSITORY_ROOT, '.cache', 'capability-controller-eval', 'loader-latest')
const REPLAY_PROVIDER = 'capability-eval-replay'
const REPLAY_MODEL = 'deterministic'
const SHELL_TOOL_NAME = process.platform === 'win32' ? 'pwsh' : 'bash'

/** Mode-pinned Loader configurations used by the assembled benchmark. */
export const COMPOSITION_PATHS: Readonly<Record<EvalMode, string>> = {
  full: resolve(SCRIPT_ROOT, 'compositions', 'full.cordis.yml'),
  'raw-cordis': resolve(SCRIPT_ROOT, 'compositions', 'raw-cordis.cordis.yml'),
  controller: resolve(SCRIPT_ROOT, 'compositions', 'controller.cordis.yml'),
}

/** Parsed command-line inputs for replay or explicitly networked execution. */
export interface LoaderRunnerCliOptions {
  readonly engine: 'replay' | 'real'
  readonly modes: readonly EvalMode[]
  readonly taskIds?: ReadonlySet<string>
  readonly tasksPath: string
  readonly output: string
  readonly noWrite: boolean
  readonly repeat: number
  readonly seed: number
  readonly provider?: string
  readonly model?: string
}

/** Inputs for one fresh Loader + AgentLoop trial. */
export interface LoaderTrialOptions {
  readonly engine: 'replay' | 'real'
  readonly mode: EvalMode
  readonly task: EvalTask
  readonly seed: number
  readonly provider?: string
  readonly model?: string
  readonly workspace?: string
}

/** Inputs for a complete selected Loader benchmark. */
export interface LoaderBenchmarkOptions {
  readonly engine: 'replay' | 'real'
  readonly tasks: readonly EvalTask[]
  readonly modes: readonly EvalMode[]
  readonly repeat: number
  readonly seed: number
  readonly provider?: string
  readonly model?: string
  readonly workspace?: string
}

/** Normalized trials plus the metric summary derived from them. */
export interface LoaderBenchmarkRun {
  readonly trials: readonly EvalTrialFixture[]
  readonly summary: EvalBenchmarkSummary
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer`)
  return parsed
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return parsed
}

function selectedModes(values: readonly string[] | undefined): EvalMode[] {
  if (values === undefined) return [...EVAL_MODES]
  const modes = values.map((value) => {
    if (!(EVAL_MODES as readonly string[]).includes(value)) {
      throw new Error(`--mode must be one of ${EVAL_MODES.join(', ')}`)
    }
    return value as EvalMode
  })
  return [...new Set(modes)]
}

/** Parse the explicit network gate without starting a Loader or model request. */
export function parseLoaderRunnerArgs(args: readonly string[]): LoaderRunnerCliOptions {
  const forwardedArgs = args[0] === '--' ? args.slice(1) : args
  const { values } = parseArgs({
    args: [...forwardedArgs],
    allowPositionals: false,
    strict: true,
    options: {
      engine: { type: 'string', default: 'replay' },
      mode: { type: 'string', multiple: true },
      task: { type: 'string', multiple: true },
      tasks: { type: 'string', default: DEFAULT_TASKS },
      output: { type: 'string', default: DEFAULT_OUTPUT },
      'no-write': { type: 'boolean', default: false },
      repeat: { type: 'string', default: '1' },
      seed: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
    },
  })
  if (values.engine !== 'replay' && values.engine !== 'real') {
    throw new Error('--engine must be replay or real')
  }
  const repeat = positiveInteger(values.repeat, '--repeat')
  if (values.engine === 'real') {
    if (values.provider === undefined || values.provider.length === 0) {
      throw new Error('--engine real requires --provider')
    }
    if (values.model === undefined || values.model.length === 0) {
      throw new Error('--engine real requires --model')
    }
    if (values.seed === undefined) throw new Error('--engine real requires --seed')
  }
  const seed = values.seed === undefined ? 0 : nonNegativeInteger(values.seed, '--seed')
  return {
    engine: values.engine,
    modes: selectedModes(values.mode),
    ...values.task === undefined ? {} : { taskIds: new Set(values.task) },
    tasksPath: resolve(values.tasks),
    output: resolve(values.output),
    noWrite: values['no-write'],
    repeat,
    seed,
    ...values.provider === undefined ? {} : { provider: values.provider },
    ...values.model === undefined ? {} : { model: values.model },
  }
}

interface ScriptBuilder {
  readonly entries: ReplayEntry[]
  tool(name: string, args: unknown): void
  text(value: string): void
}

function replayBuilder(): ScriptBuilder {
  const entries: ReplayEntry[] = []
  let call = 0
  const usage = (outputTokens: number) => ({
    inputTokens: 100 + call * 3,
    outputTokens,
  })
  return {
    entries,
    tool(name, args): void {
      call += 1
      const id = CallId(`capability-eval-call-${call}`)
      const serialized = JSON.stringify(args)
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: serialized },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: serialized } },
        { type: 'usage', usage: usage(8) },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
      entries.push({ kind: 'chunks', chunks })
    },
    text(value): void {
      call += 1
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: value },
        { type: 'block-end', index: 0, block: { type: 'text', text: value } },
        { type: 'usage', usage: usage(Math.max(1, Math.ceil(value.length / 4))) },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      entries.push({ kind: 'chunks', chunks })
    },
  }
}

const WEB_ARGS = { queries: ['capability eval fixture release'] }
const DOCUMENT_ARGS = { path: 'fixture-document.txt' }
const EMAIL_ARGS = {
  to: 'fixture@example.invalid',
  subject: 'Capability eval fixture',
  body: 'Deterministic approved fixture message.',
}
const SHELL_ARGS = {
  command: process.platform === 'win32' ? 'Write-Output SHELL_FIXTURE_OK' : 'printf SHELL_FIXTURE_OK',
  description: 'Print deterministic shell fixture marker',
}
const SHELL_ESCALATION_ARGS = {
  ...SHELL_ARGS,
  sandbox_permissions: 'workspace-write',
  justification: 'The exact fixture command needs workspace write access.',
}

function fullReplay(task: EvalTask, script: ScriptBuilder): void {
  switch (task.id) {
    case 'doc-only':
      script.tool('read', DOCUMENT_ARGS)
      script.text('DOCUMENT_OK')
      return
    case 'web-single':
      script.tool('web_search', WEB_ARGS)
      script.text('Fixture release source found.')
      return
    case 'web-reuse-two-turns':
      script.tool('web_search', WEB_ARGS)
      script.text('First fixture release fact found.')
      script.tool('web_search', { queries: ['second capability eval fixture release fact'] })
      script.text('Second fixture release fact found.')
      return
    case 'email-allowed':
    case 'email-rejected':
      script.tool('send_email', EMAIL_ARGS)
      script.text(task.id === 'email-allowed' ? 'Fixture message sent.' : 'Rejected approval respected; nothing sent.')
      return
    case 'shell-workspace':
      script.tool(SHELL_TOOL_NAME, SHELL_ARGS)
      script.text('SHELL_FIXTURE_OK')
      return
    case 'web-then-email':
      script.tool('web_search', WEB_ARGS)
      script.tool('send_email', EMAIL_ARGS)
      script.text('Fixture release summary sent.')
      return
    default:
      throw new Error(`no Full replay plan for task ${JSON.stringify(task.id)}`)
  }
}

function rawWebCode(): string {
  return `return {
    name: 'capability-eval-raw-web',
    inject: ['tools', 'capabilityEvalFixture'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'web_search',
        description: 'Search the deterministic capability-eval fixture.',
        parameters: { queries: { type: 'array', items: { type: 'string' }, required: true } },
        output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] } },
        async execute(args) { return ctx.capabilityEvalFixture.webSearch(args.queries.join(' | ')) },
      }))
    },
  }`
}

function rawEmailCode(): string {
  return `return {
    name: 'capability-eval-raw-email',
    inject: ['tools', 'capabilityEvalFixture'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: 'send_email',
        description: 'Send one message to the deterministic capability-eval outbox.',
        parameters: {
          to: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          body: { type: 'string', required: true },
        },
        output: { schema: { type: 'json' }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] } },
        async execute(args) { return ctx.capabilityEvalFixture.sendEmail(args.to, args.subject, args.body) },
      }))
    },
  }`
}

function rawShellCode(): string {
  return `return {
    name: 'capability-eval-raw-shell',
    inject: ['tools', 'capabilityEvalFixture'],
    apply(ctx) {
      harness.registerTool(ctx, harness.defineTool({
        name: ${JSON.stringify(SHELL_TOOL_NAME)},
        description: 'Run the deterministic capability-eval shell marker.',
        parameters: {
          command: { type: 'string', required: true },
          description: { type: 'string', required: true },
        },
        output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
        async execute(args) { return ctx.capabilityEvalFixture.runShell(args.command) },
      }))
    },
  }`
}

interface RawActivation {
  readonly pluginId: string
}

function activateRaw(
  script: ScriptBuilder,
  ordinal: number,
  prefix: string,
  name: string,
  purpose: string,
  host: string,
): RawActivation {
  const pluginId = `${prefix}-${ordinal}`
  const packageId = `pkg-${ordinal}`
  script.tool('cordis_define', {
    plugin: { kind: 'new', idPrefix: prefix },
    name,
    purpose,
    code: { host },
  })
  script.tool('cordis_run', { pluginId, packageId, mode: 'run' })
  return { pluginId }
}

function rawReplay(task: EvalTask, script: ScriptBuilder): void {
  switch (task.id) {
    case 'doc-only':
      script.tool('read', DOCUMENT_ARGS)
      script.text('DOCUMENT_OK')
      return
    case 'web-single': {
      activateRaw(script, 1, 'webcap', 'Fixture web search', 'Expose deterministic fixture search.', rawWebCode())
      script.tool('web_search', WEB_ARGS)
      script.text('Fixture release source found.')
      return
    }
    case 'web-reuse-two-turns': {
      const web = activateRaw(script, 1, 'webcap', 'Fixture web search', 'Expose deterministic fixture search.', rawWebCode())
      script.tool('web_search', WEB_ARGS)
      script.text(`First fixture release fact found with ${web.pluginId}.`)
      script.tool('web_search', { queries: ['second capability eval fixture release fact'] })
      script.text('Second fixture release fact found through the still-running Plugin.')
      return
    }
    case 'email-rejected':
      script.text('Rejected approval respected; no email capability was created and nothing was sent.')
      return
    case 'email-allowed': {
      const email = activateRaw(script, 1, 'mailer', 'Fixture email', 'Expose deterministic fixture email.', rawEmailCode())
      script.tool('send_email', EMAIL_ARGS)
      script.tool('cordis_stop', { pluginId: email.pluginId })
      script.text('Fixture message sent and dynamic email Plugin stopped.')
      return
    }
    case 'shell-workspace': {
      const shell = activateRaw(script, 1, 'shellx', 'Fixture shell', 'Expose deterministic fixture shell.', rawShellCode())
      script.tool(SHELL_TOOL_NAME, SHELL_ARGS)
      script.tool('cordis_stop', { pluginId: shell.pluginId })
      script.text('SHELL_FIXTURE_OK; dynamic shell Plugin stopped.')
      return
    }
    case 'web-then-email': {
      const web = activateRaw(script, 1, 'webcap', 'Fixture web search', 'Expose deterministic fixture search.', rawWebCode())
      script.tool('web_search', WEB_ARGS)
      const email = activateRaw(script, 2, 'mailer', 'Fixture email', 'Expose deterministic fixture email.', rawEmailCode())
      script.tool('send_email', EMAIL_ARGS)
      script.tool('cordis_stop', { pluginId: email.pluginId })
      script.tool('cordis_stop', { pluginId: web.pluginId })
      script.text('Fixture release summary sent; both dynamic Plugins stopped.')
      return
    }
    default:
      throw new Error(`no Raw Cordis replay plan for task ${JSON.stringify(task.id)}`)
  }
}

const LEASE_FROM_REQUEST = '{{fromRequest:(capability-lease-[0-9a-f-]+)}}'

function requestCapability(script: ScriptBuilder, capability: string): void {
  script.tool('request_capability', {
    capability,
    reason: `Capability eval task needs ${capability}`,
  })
}

function releaseLatestCapability(script: ScriptBuilder): void {
  script.tool('release_capability', { lease_id: LEASE_FROM_REQUEST })
}

function controllerReplay(task: EvalTask, script: ScriptBuilder): void {
  switch (task.id) {
    case 'doc-only':
      script.tool('read', DOCUMENT_ARGS)
      script.text('DOCUMENT_OK')
      return
    case 'web-single':
      requestCapability(script, 'web.search')
      script.tool('web_search', WEB_ARGS)
      releaseLatestCapability(script)
      script.text('Fixture release source found; web capability released.')
      return
    case 'web-reuse-two-turns':
      requestCapability(script, 'web.search')
      script.tool('web_search', WEB_ARGS)
      script.text('First fixture release fact found.')
      requestCapability(script, 'web.search')
      script.tool('web_search', { queries: ['second capability eval fixture release fact'] })
      releaseLatestCapability(script)
      script.text('Second fixture release fact found; reused capability released.')
      return
    case 'email-rejected':
      requestCapability(script, 'email.send')
      script.text('Rejected approval respected; nothing sent.')
      return
    case 'email-allowed':
      requestCapability(script, 'email.send')
      script.tool('send_email', EMAIL_ARGS)
      releaseLatestCapability(script)
      script.text('Fixture message sent; email capability released.')
      return
    case 'shell-workspace':
      requestCapability(script, 'shell.execute')
      script.tool(SHELL_TOOL_NAME, SHELL_ARGS)
      releaseLatestCapability(script)
      script.text('SHELL_FIXTURE_OK; shell capability released.')
      return
    case 'shell-escalation-rejected':
      requestCapability(script, 'shell.execute')
      script.tool(SHELL_TOOL_NAME, SHELL_ESCALATION_ARGS)
      releaseLatestCapability(script)
      script.text('Rejected command escalation respected; shell capability released.')
      return
    case 'web-then-email':
      requestCapability(script, 'web.search')
      script.tool('web_search', WEB_ARGS)
      releaseLatestCapability(script)
      requestCapability(script, 'email.send')
      script.tool('send_email', EMAIL_ARGS)
      releaseLatestCapability(script)
      script.text('Fixture release summary sent; both capabilities released.')
      return
    default:
      throw new Error(`no Controller replay plan for task ${JSON.stringify(task.id)}`)
  }
}

/** Build the deterministic model-call script consumed by the official replay adapter. */
export function buildLoaderReplay(task: EvalTask, mode: EvalMode): ReplayEntry[] {
  const script = replayBuilder()
  switch (mode) {
    case 'full':
      fullReplay(task, script)
      break
    case 'raw-cordis':
      rawReplay(task, script)
      break
    case 'controller':
      controllerReplay(task, script)
      break
  }
  return script.entries
}

async function replayFiles(task: EvalTask, mode: EvalMode): Promise<{
  readonly directory: string
  readonly file: string
  readonly overrideFile: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-capability-controller-eval-'))
  const file = join(directory, 'session.jsonl')
  const overrideFile = join(directory, 'replay.override.json')
  await writeFile(overrideFile, `${JSON.stringify(buildLoaderReplay(task, mode), null, 2)}\n`)
  return { directory, file, overrideFile }
}

function assertTrialOptions(options: LoaderTrialOptions): void {
  if (!Number.isSafeInteger(options.seed) || options.seed < 0) {
    throw new Error('seed must be a non-negative safe integer')
  }
  if (options.engine !== 'real') return
  if (options.provider === undefined || options.provider.length === 0) {
    throw new Error('real Loader trial requires provider')
  }
  if (options.model === undefined || options.model.length === 0) {
    throw new Error('real Loader trial requires model')
  }
}

function fixtureCalls(ctx: Context): FixtureProviderCalls {
  const fixture = ctx.get('capabilityEvalFixture')
  if (fixture === undefined) throw new Error('Loader composition omitted capabilityEvalFixture')
  return fixture.providerCalls()
}

/** Drive one fresh assembled Loader composition through every turn of one task. */
export async function runLoaderTrial(options: LoaderTrialOptions): Promise<EvalTrialFixture> {
  assertTrialOptions(options)
  const replay = options.engine === 'replay' ? await replayFiles(options.task, options.mode) : undefined
  let ctx: Context | undefined
  try {
    const provider = options.engine === 'replay' ? REPLAY_PROVIDER : options.provider as string
    const model = options.engine === 'replay' ? REPLAY_MODEL : options.model as string
    ctx = await boot(NAME, COMPOSITION_PATHS[options.mode], [{
      id: 'capability-controller-eval',
      name: './composition.ts',
      config: {
        mode: options.mode,
        engine: options.engine,
        provider,
        model,
        seed: options.seed,
        workspace: resolve(options.workspace ?? REPOSITORY_ROOT),
        approvalAnswers: [...options.task.approvalAnswers],
        ...replay === undefined ? {} : {
          replayFile: replay.file,
          replayOverrideFile: replay.overrideFile,
        },
      },
    }])
    const events: SessionEvent[] = []
    let sessionId: string | undefined
    for (const turn of options.task.turns) {
      const result = await runFixtureTurn(ctx, {
        task: turn.prompt,
        onEvent: (id, event) => {
          if (sessionId !== undefined && sessionId !== id) {
            throw new Error(`Loader trial changed session from ${sessionId} to ${id}`)
          }
          sessionId = id
          events.push(event)
        },
      })
      if (sessionId === undefined) sessionId = result.sessionId
      if (result.sessionId !== sessionId) {
        throw new Error(`Loader trial result changed session from ${sessionId} to ${result.sessionId}`)
      }
    }
    if (sessionId === undefined) throw new Error('Loader trial produced no session id')
    return await collectSessionTrial({
      session: {
        source: `loader:${options.mode}/${options.task.id}/seed-${options.seed}`,
        header: { version: 0, id: sessionId, createdAt: 0, delegationDepth: 0 },
        events: events as EvalSessionEvent[],
      },
      task: options.task,
      mode: options.mode,
      providerCalls: fixtureCalls(ctx),
      workspace: resolve(options.workspace ?? REPOSITORY_ROOT),
    })
  } finally {
    await ctx?.fiber.dispose()
    if (replay !== undefined) await rm(replay.directory, { recursive: true, force: true })
  }
}

/** Run every selected task/mode/repetition as a fresh real Loader composition. */
export async function runLoaderBenchmark(options: LoaderBenchmarkOptions): Promise<LoaderBenchmarkRun> {
  if (!Number.isSafeInteger(options.repeat) || options.repeat < 1) {
    throw new Error('repeat must be a positive safe integer')
  }
  const trials: EvalTrialFixture[] = []
  for (let repetition = 0; repetition < options.repeat; repetition += 1) {
    for (const task of options.tasks) {
      for (const mode of options.modes) {
        trials.push(await runLoaderTrial({
          engine: options.engine,
          mode,
          task,
          seed: options.seed + repetition,
          ...options.provider === undefined ? {} : { provider: options.provider },
          ...options.model === undefined ? {} : { model: options.model },
          ...options.workspace === undefined ? {} : { workspace: options.workspace },
        }))
      }
    }
  }
  const taskById = new Map(options.tasks.map(task => [task.id, task]))
  const occurrences = new Map<string, number>()
  const evaluated = trials.map((trial) => {
    const task = taskById.get(trial.taskId)
    if (task === undefined) throw new Error(`Loader trial returned unknown task ${JSON.stringify(trial.taskId)}`)
    const key = JSON.stringify([trial.mode, trial.taskId])
    const repetition = occurrences.get(key) ?? 0
    occurrences.set(key, repetition + 1)
    return evaluateTrial(task, trial, CAPABILITY_CATALOG, repetition)
  })
  return {
    trials,
    summary: aggregateTrials(evaluated, CAPABILITY_CATALOG, {
      engine: options.engine,
      taskCount: options.tasks.length,
      repetitions: options.repeat,
    }),
  }
}

async function selectedTasks(path: string, taskIds: ReadonlySet<string> | undefined): Promise<EvalTask[]> {
  const tasks = parseTasksJsonl(await readFile(path, 'utf8'), path)
  if (taskIds === undefined) return tasks
  const known = new Set(tasks.map(task => task.id))
  for (const id of taskIds) {
    if (!known.has(id)) throw new Error(`unknown eval task ${JSON.stringify(id)}`)
  }
  return tasks.filter(task => taskIds.has(task.id))
}

async function writeRun(output: string, options: LoaderRunnerCliOptions, run: LoaderBenchmarkRun): Promise<void> {
  await mkdir(output, { recursive: true })
  await Promise.all([
    writeFile(resolve(output, 'manifest.json'), `${JSON.stringify({
      formatVersion: 1,
      benchmark: 'CapabilityControllerV1',
      runner: 'loader-agent-loop',
      engine: options.engine,
      modes: options.modes,
      repetitions: options.repeat,
      seed: options.seed,
      ...options.provider === undefined ? {} : { provider: options.provider },
      ...options.model === undefined ? {} : { model: options.model },
    }, null, 2)}\n`),
    writeFile(resolve(output, 'trials.jsonl'), `${run.trials.map(trial => JSON.stringify(trial)).join('\n')}\n`),
    writeFile(resolve(output, 'summary.json'), `${JSON.stringify(run.summary, null, 2)}\n`),
  ])
}

/** Run the assembled Loader benchmark command. */
export async function runLoaderRunnerCli(args: readonly string[]): Promise<void> {
  const options = parseLoaderRunnerArgs(args)
  const tasks = await selectedTasks(options.tasksPath, options.taskIds)
  const run = await runLoaderBenchmark({
    engine: options.engine,
    tasks,
    modes: options.modes,
    repeat: options.repeat,
    seed: options.seed,
    ...options.provider === undefined ? {} : { provider: options.provider },
    ...options.model === undefined ? {} : { model: options.model },
  })
  if (!options.noWrite) {
    await writeRun(options.output, options, run)
    process.stderr.write(`capability-controller-eval: wrote ${options.output}\n`)
  }
  process.stdout.write(`${JSON.stringify(run.summary, null, 2)}\n`)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    await runLoaderRunnerCli(process.argv.slice(2))
  } catch (error: unknown) {
    process.stderr.write(`capability-controller-eval: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
