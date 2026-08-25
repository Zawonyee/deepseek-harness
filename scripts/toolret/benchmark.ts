/** Run the local BM25 baseline over the pinned ToolRet evaluation set. */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { Bm25Index } from './bm25.ts'
import { loadToolRetQueries, loadToolRetTools, type ToolRetQuery } from './dataset.ts'
import { DEFAULT_TOOL_RET_CACHE } from './fetch.ts'
import { evaluateToolRet, TOOL_RET_K_VALUES } from './metrics.ts'
import {
  TOOL_RET_CATEGORIES,
  TOOL_RET_REPOSITORIES,
  type ToolRetCategory,
} from './sources.ts'

interface BenchmarkOptions {
  cacheRoot: string
  category: ToolRetCategory | 'all'
  tasks: ReadonlySet<string> | undefined
  limit: number | undefined
  withInstruction: boolean
  k1: number
  b: number
  output: string | undefined
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function finiteNumber(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`)
  return parsed
}

function parseCategory(value: string): ToolRetCategory | 'all' {
  if (value === 'all' || (TOOL_RET_CATEGORIES as readonly string[]).includes(value)) {
    return value as ToolRetCategory | 'all'
  }
  throw new Error(`category must be all, ${TOOL_RET_CATEGORIES.join(', ')}`)
}

function parseOptions(args: string[]): BenchmarkOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      'cache-dir': { type: 'string' },
      category: { type: 'string', default: 'all' },
      task: { type: 'string', multiple: true },
      limit: { type: 'string' },
      'with-instruction': { type: 'boolean', default: false },
      k1: { type: 'string', default: '1.2' },
      b: { type: 'string', default: '0.75' },
      output: { type: 'string' },
      'no-write': { type: 'boolean', default: false },
    },
  })
  const cacheRoot = resolve(values['cache-dir'] ?? DEFAULT_TOOL_RET_CACHE)
  const defaultOutputName = values['with-instruction']
    ? 'bm25-with-instruction.json'
    : 'bm25-query-only.json'
  return {
    cacheRoot,
    category: parseCategory(values.category),
    tasks: values.task === undefined ? undefined : new Set(values.task),
    limit: values.limit === undefined ? undefined : positiveInteger(values.limit, '--limit'),
    withInstruction: values['with-instruction'],
    k1: finiteNumber(values.k1, '--k1'),
    b: finiteNumber(values.b, '--b'),
    output: values['no-write']
      ? undefined
      : resolve(values.output ?? resolve(cacheRoot, 'results', defaultOutputName)),
  }
}

function assertGoldToolsExist(queries: readonly ToolRetQuery[], toolIds: ReadonlySet<string>): void {
  const missing = new Set<string>()
  for (const query of queries) {
    for (const label of query.labels) {
      if (label.relevance > 0 && !toolIds.has(label.id)) missing.add(label.id)
    }
  }
  if (missing.size > 0) {
    const examples = [...missing].sort().slice(0, 10)
    throw new Error(`${missing.size} relevant tool ids are absent from the selected corpus: ${examples.join(', ')}`)
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) {
    const name = key(value)
    counts[name] = (counts[name] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareText(left, right)))
}

export async function runToolRetBenchmark(options: BenchmarkOptions): Promise<Record<string, unknown>> {
  const [tools, loadedQueries] = await Promise.all([
    loadToolRetTools(options.cacheRoot, options.category),
    loadToolRetQueries(options.cacheRoot, options.tasks),
  ])
  let queries = loadedQueries
    .filter(query => options.category === 'all' || query.category === options.category)
    .sort((left, right) => compareText(left.id, right.id))
  if (options.limit !== undefined) queries = queries.slice(0, options.limit)
  if (queries.length === 0) throw new Error('the selected ToolRet query set is empty')
  assertGoldToolsExist(queries, new Set(tools.map(tool => tool.id)))

  const indexStarted = performance.now()
  const index = new Bm25Index(tools, { k1: options.k1, b: options.b })
  const indexMilliseconds = performance.now() - indexStarted
  const rankings = new Map<string, string[]>()
  const searchStarted = performance.now()
  queries.forEach((query, indexWithinQueries) => {
    const input = options.withInstruction
      ? `${query.instruction}\n${query.query}`
      : query.query
    rankings.set(query.id, index.search(input, Math.max(...TOOL_RET_K_VALUES)).map(result => result.id))
    if ((indexWithinQueries + 1) % 500 === 0 || indexWithinQueries + 1 === queries.length) {
      process.stderr.write(`toolret-benchmark: ranked ${indexWithinQueries + 1}/${queries.length} queries\n`)
    }
  })
  const searchMilliseconds = performance.now() - searchStarted
  const categories = Object.fromEntries(TOOL_RET_CATEGORIES.flatMap((category) => {
    const subset = queries.filter(query => query.category === category)
    return subset.length === 0 ? [] : [[category, evaluateToolRet(subset, rankings)]]
  }))
  const result = {
    formatVersion: 1,
    benchmark: 'ToolRet',
    sourceRevisions: {
      tools: TOOL_RET_REPOSITORIES.tools.revision,
      queries: TOOL_RET_REPOSITORIES.queries.revision,
    },
    baseline: {
      name: 'BM25',
      tokenizer: 'unicode-camelcase-with-english-stop-words',
      k1: index.k1,
      b: index.b,
      withInstruction: options.withInstruction,
    },
    selection: {
      category: options.category,
      tasks: options.tasks === undefined ? 'all' : [...options.tasks].sort(),
      limit: options.limit ?? null,
    },
    counts: {
      tools: tools.length,
      queries: queries.length,
      queriesByCategory: countBy(queries, query => query.category),
      queriesByTask: countBy(queries, query => query.task),
    },
    metrics: evaluateToolRet(queries, rankings),
    metricsByCategory: categories,
    timingMilliseconds: {
      index: Math.round(indexMilliseconds),
      search: Math.round(searchMilliseconds),
    },
  }
  if (options.output !== undefined) {
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`)
    process.stderr.write(`toolret-benchmark: wrote ${options.output}\n`)
  }
  return result
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runToolRetBenchmark(parseOptions(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`toolret-benchmark: ${detail}\n`)
    process.exitCode = 1
  }
}
