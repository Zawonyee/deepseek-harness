/** Fetch the pinned ToolRet dataset into the ignored local cache. */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { sourceCachePath } from './dataset.ts'
import {
  TOOL_RET_REPOSITORIES,
  TOOL_RET_SOURCES,
  sourceRepository,
  sourceUrl,
  type ToolRetSourceFile,
} from './sources.ts'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const DEFAULT_TOOL_RET_CACHE = resolve(REPOSITORY_ROOT, '.cache', 'toolret')

export interface FetchToolRetOptions {
  cacheRoot: string
  repair?: boolean
  verifyOnly?: boolean
  fetchImpl?: typeof globalThis.fetch
  log?: (message: string) => void
}

interface FileInspection {
  state: 'missing' | 'valid' | 'invalid'
  detail?: string
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk)
  return hash.digest('hex')
}

export async function inspectSourceFile(path: string, source: ToolRetSourceFile): Promise<FileInspection> {
  if (!existsSync(path)) return { state: 'missing' }
  const metadata = await stat(path)
  if (metadata.size !== source.expectedBytes) {
    return { state: 'invalid', detail: `expected ${source.expectedBytes} bytes, found ${metadata.size}` }
  }
  const actualHash = await sha256File(path)
  if (actualHash !== source.sha256) {
    return { state: 'invalid', detail: `expected sha256 ${source.sha256}, found ${actualHash}` }
  }
  return { state: 'valid' }
}

async function responseBytes(response: Response, source: ToolRetSourceFile): Promise<Buffer> {
  if (response.body === null) throw new Error('response has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > source.expectedBytes) {
        throw new Error(`response exceeded expected size ${source.expectedBytes}`)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (received !== source.expectedBytes) {
    throw new Error(`expected ${source.expectedBytes} bytes, received ${received}`)
  }
  return Buffer.concat(chunks, received)
}

async function downloadSource(
  cacheRoot: string,
  source: ToolRetSourceFile,
  fetchImpl: typeof globalThis.fetch,
  repair: boolean,
): Promise<'downloaded' | 'verified'> {
  const destination = sourceCachePath(cacheRoot, source)
  const inspection = await inspectSourceFile(destination, source)
  if (inspection.state === 'valid') return 'verified'
  if (inspection.state === 'invalid' && !repair) {
    throw new Error(`${source.kind}/${source.path} failed verification (${inspection.detail}); rerun with --repair to replace it`)
  }
  const response = await fetchImpl(sourceUrl(source), { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  const bytes = await responseBytes(response, source)
  const actualHash = createHash('sha256').update(bytes).digest('hex')
  if (actualHash !== source.sha256) {
    throw new Error(`expected sha256 ${source.sha256}, received ${actualHash}`)
  }
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    if (inspection.state === 'invalid') await rm(destination)
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
  return 'downloaded'
}

async function writeManifest(cacheRoot: string): Promise<void> {
  const manifest = {
    formatVersion: 1,
    benchmark: 'ToolRet',
    repositories: TOOL_RET_REPOSITORIES,
    files: TOOL_RET_SOURCES.map(source => ({
      ...source,
      repository: sourceRepository(source).id,
      revision: sourceRepository(source).revision,
      localPath: `raw/${source.kind}/${source.path}`,
    })),
  }
  await mkdir(cacheRoot, { recursive: true })
  await writeFile(resolve(cacheRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function fetchToolRet(options: FetchToolRetOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const log = options.log ?? (() => {})
  if (options.verifyOnly) {
    const failures: string[] = []
    for (const source of TOOL_RET_SOURCES) {
      const inspection = await inspectSourceFile(sourceCachePath(options.cacheRoot, source), source)
      if (inspection.state !== 'valid') {
        failures.push(`${source.kind}/${source.path}: ${inspection.detail ?? inspection.state}`)
      }
    }
    if (failures.length > 0) throw new Error(`ToolRet cache verification failed:\n${failures.join('\n')}`)
    await writeManifest(options.cacheRoot)
    log(`verified ${TOOL_RET_SOURCES.length} ToolRet files`)
    return
  }
  let downloaded = 0
  for (const [index, source] of TOOL_RET_SOURCES.entries()) {
    let outcome: 'downloaded' | 'verified'
    try {
      outcome = await downloadSource(options.cacheRoot, source, fetchImpl, options.repair ?? false)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`failed to fetch ${source.kind}/${source.path}: ${detail}`)
    }
    if (outcome === 'downloaded') downloaded += 1
    log(`[${index + 1}/${TOOL_RET_SOURCES.length}] ${outcome} ${source.kind}/${source.path}`)
  }
  await writeManifest(options.cacheRoot)
  log(`ToolRet cache ready: ${downloaded} downloaded, ${TOOL_RET_SOURCES.length - downloaded} reused`)
}

function parseOptions(args: string[]): FetchToolRetOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      'cache-dir': { type: 'string' },
      repair: { type: 'boolean', default: false },
      'verify-only': { type: 'boolean', default: false },
    },
  })
  return {
    cacheRoot: resolve(values['cache-dir'] ?? DEFAULT_TOOL_RET_CACHE),
    repair: values.repair,
    verifyOnly: values['verify-only'],
    log: message => process.stdout.write(`${message}\n`),
  }
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    await fetchToolRet(parseOptions(process.argv.slice(2)))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`toolret-fetch: ${detail}\n`)
    process.exitCode = 1
  }
}
