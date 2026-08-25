import { describe, expect, it } from 'vitest'

import { Bm25Index, tokenizeToolRetText } from './bm25.ts'
import { parseQueryRows, parseToolRows, type ToolRetQuery, type ToolRetTool } from './dataset.ts'
import { evaluateToolRet } from './metrics.ts'
import { TOOL_RET_SOURCES, sourceUrl } from './sources.ts'

function tool(id: string, documentation: string): ToolRetTool {
  return { id, documentation, category: 'web' }
}

function query(labels: ToolRetQuery['labels']): ToolRetQuery {
  return {
    id: 'query-1',
    query: 'find tools',
    instruction: 'retrieve tools',
    labels,
    category: 'web',
    task: 'fixture',
  }
}

describe('ToolRet source manifest', () => {
  it('pins every source to one unique safe path and checksum', () => {
    expect(TOOL_RET_SOURCES).toHaveLength(38)
    expect(new Set(TOOL_RET_SOURCES.map(source => `${source.kind}/${source.path}`)).size).toBe(38)
    for (const source of TOOL_RET_SOURCES) {
      expect(source.path).not.toMatch(/(^|\/)\.\.?($|\/)/u)
      expect(source.sha256).toMatch(/^[a-f\d]{64}$/u)
      expect(source.expectedBytes).toBeGreaterThan(0)
      expect(sourceUrl(source)).toContain('/resolve/')
      expect(sourceUrl(source)).toContain(source.sha256 === '' ? 'unreachable' : source.path)
    }
  })
})

describe('ToolRet dataset boundary', () => {
  it('normalizes valid tools and JSON-encoded relevance labels', () => {
    expect(parseToolRows([{ id: 'tool-1', documentation: '{"name":"weather"}' }], 'web', 'tools')).toEqual([
      { id: 'tool-1', documentation: '{"name":"weather"}', category: 'web' },
    ])
    expect(parseQueryRows([{
      id: 'query-1',
      query: 'weather tomorrow',
      instruction: 'retrieve a forecast tool',
      labels: '[{"id":"tool-1","relevance":1}]',
      category: 'web',
    }], 'fixture', 'queries')).toEqual([{
      id: 'query-1',
      query: 'weather tomorrow',
      instruction: 'retrieve a forecast tool',
      labels: [{ id: 'tool-1', relevance: 1 }],
      category: 'web',
      task: 'fixture',
    }])
  })

  it('normalizes upstream Python non-finite numbers without changing strings', () => {
    const rows = parseQueryRows([{
      id: 'query-1',
      query: 'weather tomorrow',
      instruction: 'retrieve a forecast tool',
      labels: '[{"id":"tool-1","doc":{"default":NaN,"text":"NaN"},"relevance":1}]',
      category: 'web',
    }], 'fixture', 'queries')
    expect(rows[0]?.labels).toEqual([{ id: 'tool-1', relevance: 1 }])
  })

  it('retains upstream instruction-only queries', () => {
    const rows = parseQueryRows([{
      id: 'query-1',
      query: '',
      instruction: 'retrieve a content generation tool',
      labels: '[{"id":"tool-1","relevance":1}]',
      category: 'web',
    }], 'fixture', 'queries')
    expect(rows[0]?.query).toBe('')
  })

  it('rejects malformed external rows with their source location', () => {
    expect(() => parseToolRows([{ id: '', documentation: 'doc' }], 'web', 'tools')).toThrow(
      'tools: row 0: id must be a non-empty string',
    )
    expect(() => parseQueryRows([{
      id: 'query-1',
      query: 'weather',
      instruction: 'retrieve',
      labels: 'not-json',
      category: 'web',
    }], 'fixture', 'queries')).toThrow('queries: row 0: labels is not valid JSON')
  })
})

describe('ToolRet BM25 baseline', () => {
  it('splits camel case and removes common English stop words', () => {
    expect(tokenizeToolRetText('GetWeatherForecast for the City')).toEqual([
      'get', 'weather', 'forecast', 'city',
    ])
  })

  it('ranks matching documentation first and resolves zero-score ties by id', () => {
    const index = new Bm25Index([
      tool('weather', '{"name":"getWeatherForecast","description":"forecast by city"}'),
      tool('music', '{"name":"findAlbum","description":"search music releases"}'),
      tool('alpha', '{"name":"calculator"}'),
    ])
    expect(index.search('weather forecast for a city', 2).map(result => result.id)).toEqual([
      'weather', 'alpha',
    ])
    expect(index.search('unseen vocabulary', 2)).toEqual([
      { id: 'alpha', score: 0 },
      { id: 'music', score: 0 },
    ])
  })
})

describe('ToolRet metrics', () => {
  it('computes cutoff metrics and complete-recall comprehensiveness', () => {
    const metrics = evaluateToolRet(
      [query([{ id: 'a', relevance: 1 }, { id: 'b', relevance: 1 }])],
      new Map([['query-1', ['a', 'x', 'b']]]),
      [5],
    )
    expect(metrics['NDCG@5']).toBeCloseTo(0.91972, 5)
    expect(metrics['MAP@5']).toBeCloseTo(0.83333, 5)
    expect(metrics['Recall@5']).toBe(1)
    expect(metrics['Precision@5']).toBe(0.4)
    expect(metrics['Comprehensiveness@5']).toBe(1)
  })

  it('rejects missing rankings instead of silently lowering the score', () => {
    expect(() => evaluateToolRet([query([{ id: 'a', relevance: 1 }])], new Map(), [5])).toThrow(
      'missing ranking for query "query-1"',
    )
  })
})
