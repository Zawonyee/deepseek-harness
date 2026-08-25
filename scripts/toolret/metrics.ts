/** ToolRet retrieval metrics matching the benchmark's public pytrec_eval surface. */

import type { ToolRetQuery } from './dataset.ts'

export const TOOL_RET_K_VALUES = [5, 10, 20] as const

export type ToolRetMetrics = Record<string, number>

function discountedGain(relevance: number, rank: number): number {
  return (2 ** relevance - 1) / Math.log2(rank + 1)
}

function roundMetric(value: number): number {
  return Math.round(value * 100000) / 100000
}

export function evaluateToolRet(
  queries: readonly ToolRetQuery[],
  rankings: ReadonlyMap<string, readonly string[]>,
  kValues: readonly number[] = TOOL_RET_K_VALUES,
): ToolRetMetrics {
  if (queries.length === 0) throw new Error('cannot evaluate an empty ToolRet query set')
  const totals = new Map<string, number>()
  for (const k of kValues) {
    if (!Number.isInteger(k) || k < 1) throw new Error('ToolRet metric cutoffs must be positive integers')
    for (const metric of ['NDCG', 'MAP', 'Recall', 'Precision', 'Comprehensiveness']) {
      totals.set(`${metric}@${k}`, 0)
    }
  }
  for (const query of queries) {
    const ranking = rankings.get(query.id)
    if (ranking === undefined) throw new Error(`missing ranking for query ${JSON.stringify(query.id)}`)
    const relevance = new Map(query.labels.map(label => [label.id, label.relevance]))
    const positive = query.labels.filter(label => label.relevance > 0)
    const ideal = positive.map(label => label.relevance).sort((left, right) => right - left)
    for (const k of kValues) {
      const retrieved = ranking.slice(0, k)
      let relevantHits = 0
      let averagePrecisionNumerator = 0
      let discountedCumulativeGain = 0
      retrieved.forEach((id, index) => {
        const grade = relevance.get(id) ?? 0
        if (grade <= 0) return
        relevantHits += 1
        averagePrecisionNumerator += relevantHits / (index + 1)
        discountedCumulativeGain += discountedGain(grade, index + 1)
      })
      const idealDiscountedCumulativeGain = ideal
        .slice(0, k)
        .reduce((sum, grade, index) => sum + discountedGain(grade, index + 1), 0)
      const recall = relevantHits / positive.length
      totals.set(`NDCG@${k}`, (totals.get(`NDCG@${k}`) ?? 0)
        + (idealDiscountedCumulativeGain === 0 ? 0 : discountedCumulativeGain / idealDiscountedCumulativeGain))
      totals.set(`MAP@${k}`, (totals.get(`MAP@${k}`) ?? 0)
        + averagePrecisionNumerator / Math.min(positive.length, k))
      totals.set(`Recall@${k}`, (totals.get(`Recall@${k}`) ?? 0) + recall)
      totals.set(`Precision@${k}`, (totals.get(`Precision@${k}`) ?? 0) + relevantHits / k)
      totals.set(`Comprehensiveness@${k}`, (totals.get(`Comprehensiveness@${k}`) ?? 0)
        + (recall === 1 ? 1 : 0))
    }
  }
  return Object.fromEntries(
    [...totals].map(([metric, total]) => [metric, roundMetric(total / queries.length)]),
  )
}
