/** Deterministic in-memory BM25 baseline for ToolRet's tool corpus. */

import type { ToolRetTool } from './dataset.ts'

const ENGLISH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here',
  'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my',
  'of', 'on', 'or', 'our', 'she', 'should', 'that', 'the', 'their', 'them',
  'there', 'these', 'they', 'this', 'those', 'to', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
])

interface Posting {
  documentIndex: number
  termFrequency: number
}

export interface RankedTool {
  id: string
  score: number
}

export interface Bm25Options {
  k1?: number
  b?: number
}

export function tokenizeToolRetText(text: string): string[] {
  const expanded = text
    .normalize('NFKC')
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
    .toLocaleLowerCase('en-US')
  const tokens = expanded.match(/[\p{L}\p{N}]+/gu) ?? []
  return tokens.filter(token => !ENGLISH_STOP_WORDS.has(token))
}

function isBetter(left: RankedTool, right: RankedTool): boolean {
  return left.score > right.score || (left.score === right.score && left.id < right.id)
}

function isWorse(left: RankedTool, right: RankedTool): boolean {
  return isBetter(right, left)
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function pushBounded(heap: RankedTool[], candidate: RankedTool, capacity: number): void {
  if (heap.length < capacity) {
    heap.push(candidate)
    let index = heap.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (!isWorse(heap[index] as RankedTool, heap[parent] as RankedTool)) break
      ;[heap[index], heap[parent]] = [heap[parent] as RankedTool, heap[index] as RankedTool]
      index = parent
    }
    return
  }
  if (!isBetter(candidate, heap[0] as RankedTool)) return
  heap[0] = candidate
  let index = 0
  while (true) {
    const left = index * 2 + 1
    const right = left + 1
    let worst = index
    if (left < heap.length && isWorse(heap[left] as RankedTool, heap[worst] as RankedTool)) worst = left
    if (right < heap.length && isWorse(heap[right] as RankedTool, heap[worst] as RankedTool)) worst = right
    if (worst === index) break
    ;[heap[index], heap[worst]] = [heap[worst] as RankedTool, heap[index] as RankedTool]
    index = worst
  }
}

export class Bm25Index {
  readonly documentCount: number
  readonly k1: number
  readonly b: number

  private readonly documentIds: string[]
  private readonly documentLengths: number[]
  private readonly averageDocumentLength: number
  private readonly postings = new Map<string, Posting[]>()

  constructor(tools: readonly ToolRetTool[], options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.2
    this.b = options.b ?? 0.75
    if (!(this.k1 > 0)) throw new Error('BM25 k1 must be greater than zero')
    if (!(this.b >= 0 && this.b <= 1)) throw new Error('BM25 b must be between zero and one')
    const documents = [...tools].sort((left, right) => compareIds(left.id, right.id))
    this.documentIds = documents.map(document => document.id)
    this.documentCount = documents.length
    this.documentLengths = new Array<number>(documents.length)
    let totalLength = 0
    documents.forEach((document, documentIndex) => {
      const tokens = tokenizeToolRetText(document.documentation)
      this.documentLengths[documentIndex] = tokens.length
      totalLength += tokens.length
      const frequencies = new Map<string, number>()
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
      for (const [token, termFrequency] of frequencies) {
        const posting = { documentIndex, termFrequency }
        const existing = this.postings.get(token)
        if (existing === undefined) this.postings.set(token, [posting])
        else existing.push(posting)
      }
    })
    this.averageDocumentLength = documents.length === 0 ? 1 : Math.max(1, totalLength / documents.length)
  }

  search(query: string, limit: number): RankedTool[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('BM25 result limit must be a positive integer')
    const resultLimit = Math.min(limit, this.documentCount)
    if (resultLimit === 0) return []
    const scores = new Map<number, number>()
    for (const token of new Set(tokenizeToolRetText(query))) {
      const postings = this.postings.get(token)
      if (postings === undefined) continue
      const inverseDocumentFrequency = Math.log(
        1 + (this.documentCount - postings.length + 0.5) / (postings.length + 0.5),
      )
      for (const posting of postings) {
        const length = this.documentLengths[posting.documentIndex] as number
        const normalization = posting.termFrequency + this.k1 * (
          1 - this.b + this.b * length / this.averageDocumentLength
        )
        const contribution = inverseDocumentFrequency
          * posting.termFrequency * (this.k1 + 1) / normalization
        scores.set(posting.documentIndex, (scores.get(posting.documentIndex) ?? 0) + contribution)
      }
    }
    const heap: RankedTool[] = []
    for (const [documentIndex, score] of scores) {
      pushBounded(heap, { id: this.documentIds[documentIndex] as string, score }, resultLimit)
    }
    const selected = new Set(heap.map(result => result.id))
    if (heap.length < resultLimit) {
      for (const id of this.documentIds) {
        if (selected.has(id)) continue
        heap.push({ id, score: 0 })
        if (heap.length === resultLimit) break
      }
    }
    return heap.sort((left, right) => isBetter(left, right) ? -1 : isBetter(right, left) ? 1 : 0)
  }
}
