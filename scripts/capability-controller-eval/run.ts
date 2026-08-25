/** Run the fixed Full / Raw Cordis / Controller comparison over normalized trajectories. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import {
  CAPABILITY_CATALOG,
  aggregateTrials,
  evaluateTrial,
  type EvalBenchmarkSummary,
  type EvaluatedTrial,
} from './metrics.ts'
import {
  EVAL_MODES,
  parseTasksJsonl,
  parseTrialJsonl,
  type EvalMode,
  type EvalTask,
  type EvalTrialFixture,
} from './types.ts'

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_ROOT, '..', '..')
const DEFAULT_OUTPUT = resolve(REPOSITORY_ROOT, '.cache', 'capability-controller-eval', 'results', 'latest')

/** Options for the deterministic in-repository scripted run. */
export interface ScriptedEvalOptions {
  root: string
  modes?: readonly EvalMode[]
  taskIds?: ReadonlySet<string>
  repetitions?: number
}

/** Input supplied to an explicit real-model driver module. */
interface RealEvalDriverOptions {
  root: string
  tasks: readonly EvalTask[]
  modes: readonly EvalMode[]
  repetitions: number
  provider: string
  model: string
}

/** A real-model driver stays outside this keyless metric package and returns normalized observations. */
interface RealEvalDriver {
  run(options: RealEvalDriverOptions): Promise<readonly EvalTrialFixture[]>
}

interface EvalRun {
  summary: EvalBenchmarkSummary
  trials: EvaluatedTrial[]
  taskIds: string[]
  modes: EvalMode[]
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive safe integer`)
  return number
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

async function loadTasks(root: string, taskIds?: ReadonlySet<string>): Promise<EvalTask[]> {
  const path = resolve(root, 'tasks.jsonl')
  const tasks = parseTasksJsonl(await readFile(path, 'utf8'), path)
  if (taskIds === undefined) return tasks
  const known = new Set(tasks.map(task => task.id))
  for (const id of taskIds) {
    if (!known.has(id)) throw new Error(`unknown eval task ${JSON.stringify(id)}`)
  }
  return tasks.filter(task => taskIds.has(task.id))
}

function fixtureIndex(fixtures: readonly EvalTrialFixture[], source: string): Map<string, EvalTrialFixture> {
  const rows = new Map<string, EvalTrialFixture>()
  for (const fixture of fixtures) {
    const key = JSON.stringify([fixture.mode, fixture.taskId])
    if (rows.has(key)) throw new Error(`${source}: duplicate fixture for ${fixture.mode}/${fixture.taskId}`)
    rows.set(key, fixture)
  }
  return rows
}

function validateCapabilities(tasks: readonly EvalTask[], fixtures: readonly EvalTrialFixture[]): void {
  const known = new Set(CAPABILITY_CATALOG.map(row => row.capability))
  for (const task of tasks) {
    for (const capability of [...task.requiredCapabilities, ...task.allowedCapabilities]) {
      if (!known.has(capability)) {
        throw new Error(`task ${JSON.stringify(task.id)} references unknown capability ${JSON.stringify(capability)}`)
      }
    }
  }
  for (const fixture of fixtures) {
    for (const entitlement of fixture.entitlements) {
      if (!known.has(entitlement.capability)) {
        throw new Error(`fixture ${fixture.mode}/${fixture.taskId} references unknown entitlement ${JSON.stringify(entitlement.capability)}`)
      }
    }
  }
}

async function scriptedRun(options: ScriptedEvalOptions): Promise<EvalRun> {
  const modes = options.modes === undefined ? [...EVAL_MODES] : [...options.modes]
  const repetitions = options.repetitions ?? 1
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new Error('repetitions must be a positive safe integer')
  }
  const tasks = await loadTasks(options.root, options.taskIds)
  const cache = new Map<string, Map<string, EvalTrialFixture>>()
  const allFixtures: EvalTrialFixture[] = []
  const fixtureFor = async (task: EvalTask, mode: EvalMode): Promise<EvalTrialFixture> => {
    const relative = task.scripts[mode]
    const source = resolve(options.root, relative)
    let index = cache.get(source)
    if (index === undefined) {
      const fixtures = parseTrialJsonl(await readFile(source, 'utf8'), source, { requireUsage: true })
      allFixtures.push(...fixtures)
      index = fixtureIndex(fixtures, source)
      cache.set(source, index)
    }
    const fixture = index.get(JSON.stringify([mode, task.id]))
    if (fixture === undefined) throw new Error(`${source}: missing fixture for ${mode}/${task.id}`)
    return fixture
  }
  const selected: { task: EvalTask; fixture: EvalTrialFixture }[] = []
  for (const task of tasks) {
    for (const mode of modes) selected.push({ task, fixture: await fixtureFor(task, mode) })
  }
  validateCapabilities(tasks, allFixtures)
  const trials: EvaluatedTrial[] = []
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const row of selected) {
      trials.push(evaluateTrial(row.task, row.fixture, CAPABILITY_CATALOG, repetition))
    }
  }
  return {
    summary: aggregateTrials(trials, CAPABILITY_CATALOG, {
      engine: 'scripted',
      taskCount: tasks.length,
      repetitions,
    }),
    trials,
    taskIds: tasks.map(task => task.id),
    modes,
  }
}

/** Load and evaluate the committed keyless scripted corpus. */
export async function runScriptedEval(options: ScriptedEvalOptions): Promise<EvalBenchmarkSummary> {
  return (await scriptedRun(options)).summary
}

async function realRun(options: {
  root: string
  modes: EvalMode[]
  taskIds?: ReadonlySet<string>
  repetitions: number
  provider: string | undefined
  model: string | undefined
  driver: string | undefined
}): Promise<EvalRun> {
  if (options.provider === undefined || options.provider.length === 0) throw new Error('--engine real requires --provider')
  if (options.model === undefined || options.model.length === 0) throw new Error('--engine real requires --model')
  if (options.driver === undefined || options.driver.length === 0) {
    throw new Error('--engine real requires --driver <module>; the default benchmark is intentionally keyless')
  }
  const tasks = await loadTasks(options.root, options.taskIds)
  const imported = await import(pathToFileURL(resolve(options.driver)).href) as {
    default?: RealEvalDriver
    driver?: RealEvalDriver
  }
  const driver = imported.default ?? imported.driver
  if (driver === undefined || typeof driver.run !== 'function') {
    throw new Error(`real eval driver ${JSON.stringify(options.driver)} must export { run(options) } as default or "driver"`)
  }
  const raw = await driver.run({
    root: options.root,
    tasks,
    modes: options.modes,
    repetitions: options.repetitions,
    provider: options.provider,
    model: options.model,
  })
  const fixtures = parseTrialJsonl(raw.map(row => JSON.stringify(row)).join('\n'), `${options.driver}: result`)
  validateCapabilities(tasks, fixtures)
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const expectedTrials = tasks.length * options.modes.length * options.repetitions
  if (fixtures.length !== expectedTrials) {
    throw new Error(`real eval driver returned ${fixtures.length} trials; expected ${expectedTrials}`)
  }
  const occurrence = new Map<string, number>()
  const trials = fixtures.map((fixture) => {
    const task = taskById.get(fixture.taskId)
    if (task === undefined) throw new Error(`real eval driver returned unknown task ${JSON.stringify(fixture.taskId)}`)
    if (!options.modes.includes(fixture.mode)) throw new Error(`real eval driver returned unselected mode ${fixture.mode}`)
    const key = JSON.stringify([fixture.mode, fixture.taskId])
    const repetition = occurrence.get(key) ?? 0
    occurrence.set(key, repetition + 1)
    return evaluateTrial(task, fixture, CAPABILITY_CATALOG, repetition)
  })
  for (const task of tasks) {
    for (const mode of options.modes) {
      const count = occurrence.get(JSON.stringify([mode, task.id])) ?? 0
      if (count !== options.repetitions) {
        throw new Error(`real eval driver returned ${count} trials for ${mode}/${task.id}; expected ${options.repetitions}`)
      }
    }
  }
  return {
    summary: aggregateTrials(trials, CAPABILITY_CATALOG, {
      engine: 'real',
      taskCount: tasks.length,
      repetitions: options.repetitions,
    }),
    trials,
    taskIds: tasks.map(task => task.id),
    modes: options.modes,
  }
}

async function writeResults(
  output: string,
  run: EvalRun,
  options: { engine: 'scripted' | 'real'; provider?: string; model?: string },
): Promise<void> {
  await mkdir(output, { recursive: true })
  const manifest = {
    formatVersion: 1,
    benchmark: 'CapabilityControllerV1',
    engine: options.engine,
    modes: run.modes,
    tasks: run.taskIds,
    repetitions: run.summary.repetitions,
    ...options.provider === undefined ? {} : { provider: options.provider },
    ...options.model === undefined ? {} : { model: options.model },
  }
  await Promise.all([
    writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(resolve(output, 'trials.jsonl'), `${run.trials.map(row => JSON.stringify(row)).join('\n')}\n`),
    writeFile(resolve(output, 'summary.json'), `${JSON.stringify(run.summary, null, 2)}\n`),
  ])
}

async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      engine: { type: 'string', default: 'scripted' },
      mode: { type: 'string', multiple: true },
      task: { type: 'string', multiple: true },
      repeat: { type: 'string', default: '1' },
      root: { type: 'string', default: SCRIPT_ROOT },
      output: { type: 'string', default: DEFAULT_OUTPUT },
      'no-write': { type: 'boolean', default: false },
      provider: { type: 'string' },
      model: { type: 'string' },
      driver: { type: 'string' },
    },
  })
  if (values.engine !== 'scripted' && values.engine !== 'real') {
    throw new Error('--engine must be scripted or real')
  }
  const modes = selectedModes(values.mode)
  const repetitions = positiveInteger(values.repeat, '--repeat')
  const root = resolve(values.root)
  const taskIds = values.task === undefined ? undefined : new Set(values.task)
  const run = values.engine === 'scripted'
    ? await scriptedRun({
      root,
      modes,
      ...taskIds === undefined ? {} : { taskIds },
      repetitions,
    })
    : await realRun({
      root,
      modes,
      ...taskIds === undefined ? {} : { taskIds },
      repetitions,
      provider: values.provider,
      model: values.model,
      driver: values.driver,
    })
  if (!values['no-write']) {
    await writeResults(resolve(values.output), run, {
      engine: values.engine,
      ...values.provider === undefined ? {} : { provider: values.provider },
      ...values.model === undefined ? {} : { model: values.model },
    })
    process.stderr.write(`capability-controller-eval: wrote ${resolve(values.output)}\n`)
  }
  process.stdout.write(`${JSON.stringify(run.summary, null, 2)}\n`)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2))
  } catch (error: unknown) {
    process.stderr.write(`capability-controller-eval: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
