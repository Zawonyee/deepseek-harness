/** Read and validate the pinned ToolRet Parquet files at the external-data boundary. */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet'

import {
  TOOL_RET_CATEGORIES,
  TOOL_RET_QUERY_SOURCES,
  TOOL_RET_TOOL_SOURCES,
  type ToolRetCategory,
  type ToolRetSourceFile,
} from './sources.ts'

export interface ToolRetTool {
  id: string
  documentation: string
  category: ToolRetCategory
}

interface ToolRetLabel {
  id: string
  relevance: number
}

export interface ToolRetQuery {
  id: string
  query: string
  instruction: string
  labels: ToolRetLabel[]
  category: ToolRetCategory
  task: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(
  row: Record<string, unknown>,
  field: string,
  context: string,
  allowEmpty = false,
): string {
  const value = row[field]
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    const requirement = allowEmpty ? 'a string' : 'a non-empty string'
    throw new Error(`${context}: ${field} must be ${requirement}`)
  }
  return value
}

function parseCategory(value: unknown, context: string): ToolRetCategory {
  if (typeof value === 'string' && (TOOL_RET_CATEGORIES as readonly string[]).includes(value)) {
    return value as ToolRetCategory
  }
  throw new Error(`${context}: category must be one of ${TOOL_RET_CATEGORIES.join(', ')}`)
}

function normalizeNonFiniteJsonNumbers(value: string): string {
  let normalized = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length;) {
    const character = value[index] as string
    if (inString) {
      normalized += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      index += 1
      continue
    }
    if (character === '"') {
      inString = true
      normalized += character
      index += 1
      continue
    }
    const remainder = value.slice(index)
    const match = /^(?:-?Infinity|NaN)(?![\p{L}\p{N}_])/u.exec(remainder)
    if (match !== null) {
      normalized += 'null'
      index += match[0].length
      continue
    }
    normalized += character
    index += 1
  }
  return normalized
}

function parseLabels(value: unknown, context: string): ToolRetLabel[] {
  if (typeof value !== 'string') throw new Error(`${context}: labels must be a JSON string`)
  let parsed: unknown
  try {
    parsed = JSON.parse(normalizeNonFiniteJsonNumbers(value))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${context}: labels is not valid JSON: ${detail}`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${context}: labels must contain at least one relevance judgment`)
  }
  const labels = parsed.map((label, index): ToolRetLabel => {
    const labelContext = `${context}: labels[${index}]`
    if (!isRecord(label)) throw new Error(`${labelContext} must be an object`)
    const id = requiredString(label, 'id', labelContext)
    const relevance = label.relevance
    if (typeof relevance !== 'number' || !Number.isInteger(relevance) || relevance < 0) {
      throw new Error(`${labelContext}: relevance must be a non-negative integer`)
    }
    return { id, relevance }
  })
  if (!labels.some(label => label.relevance > 0)) {
    throw new Error(`${context}: labels must contain at least one relevant tool`)
  }
  if (new Set(labels.map(label => label.id)).size !== labels.length) {
    throw new Error(`${context}: labels must not contain duplicate tool ids`)
  }
  return labels
}

export function parseToolRows(
  rows: readonly unknown[],
  category: ToolRetCategory,
  source: string,
): ToolRetTool[] {
  return rows.map((row, index) => {
    const context = `${source}: row ${index}`
    if (!isRecord(row)) throw new Error(`${context} must be an object`)
    return {
      id: requiredString(row, 'id', context),
      documentation: requiredString(row, 'documentation', context),
      category,
    }
  })
}

export function parseQueryRows(rows: readonly unknown[], task: string, source: string): ToolRetQuery[] {
  return rows.map((row, index) => {
    const context = `${source}: row ${index}`
    if (!isRecord(row)) throw new Error(`${context} must be an object`)
    return {
      id: requiredString(row, 'id', context),
      query: requiredString(row, 'query', context, true),
      instruction: requiredString(row, 'instruction', context),
      labels: parseLabels(row.labels, context),
      category: parseCategory(row.category, context),
      task,
    }
  })
}

export function sourceCachePath(cacheRoot: string, source: ToolRetSourceFile): string {
  return resolve(cacheRoot, 'raw', source.kind, ...source.path.split('/'))
}

async function readSource(cacheRoot: string, source: ToolRetSourceFile): Promise<Record<string, unknown>[]> {
  const path = sourceCachePath(cacheRoot, source)
  if (!existsSync(path)) {
    throw new Error(`missing ToolRet source ${source.kind}/${source.path}; run the fetch command first`)
  }
  const file = await asyncBufferFromFile(path)
  return parquetReadObjects({ file, columns: source.kind === 'tools'
    ? ['id', 'documentation']
    : ['id', 'query', 'instruction', 'labels', 'category'] })
}

function assertUniqueIds(records: readonly { id: string }[], label: string): void {
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.id)) throw new Error(`duplicate ${label} id ${JSON.stringify(record.id)}`)
    seen.add(record.id)
  }
}

export async function loadToolRetTools(
  cacheRoot: string,
  category: ToolRetCategory | 'all' = 'all',
): Promise<ToolRetTool[]> {
  const selected = category === 'all'
    ? TOOL_RET_TOOL_SOURCES
    : TOOL_RET_TOOL_SOURCES.filter(source => source.config === category)
  const chunks = await Promise.all(selected.map(async (source) => {
    const rows = await readSource(cacheRoot, source)
    return parseToolRows(rows, source.config as ToolRetCategory, source.path)
  }))
  const tools = chunks.flat()
  assertUniqueIds(tools, 'tool')
  return tools
}

export async function loadToolRetQueries(
  cacheRoot: string,
  tasks: ReadonlySet<string> | undefined,
): Promise<ToolRetQuery[]> {
  const selected = tasks === undefined
    ? TOOL_RET_QUERY_SOURCES
    : TOOL_RET_QUERY_SOURCES.filter(source => tasks.has(source.config))
  if (tasks !== undefined) {
    const known = new Set(TOOL_RET_QUERY_SOURCES.map(source => source.config))
    const unknown = [...tasks].filter(task => !known.has(task))
    if (unknown.length > 0) throw new Error(`unknown ToolRet task(s): ${unknown.sort().join(', ')}`)
  }
  const chunks = await Promise.all(selected.map(async (source) => {
    const rows = await readSource(cacheRoot, source)
    return parseQueryRows(rows, source.config, source.path)
  }))
  const queries = chunks.flat()
  assertUniqueIds(queries, 'query')
  return queries
}
