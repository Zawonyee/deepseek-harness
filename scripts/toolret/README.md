# ToolRet retrieval benchmark

English | [中文](README.zh.md)

This directory provides a reproducible local retrieval benchmark for experiments that select a small tool set from a large capability catalog. It downloads the authors' ToolRet evaluation data, validates it at the external-data boundary, and runs a deterministic BM25 baseline without model credentials or changes to the Harness runtime.

## What it prepares

The pinned dataset contains 44,453 tool documents and 7,961 queries across `web`, `code`, and `customized`. The downloader retrieves all 38 Parquet files into `.cache/toolret/raw/`, checks every byte count and SHA-256 digest, and writes `.cache/toolret/manifest.json`. The repository ignores that cache; only the downloader, pinned source metadata, adapter, baseline, tests, and documentation are committed.

The source revisions are `e06c38c75612b6536bd959e08cdd345894aba6a7` for [`mangopy/ToolRet-Tools`](https://huggingface.co/datasets/mangopy/ToolRet-Tools) and `b8c76ad3349ff17497b6bdb28bb5b8f61a0f6445` for [`mangopy/ToolRet-Queries`](https://huggingface.co/datasets/mangopy/ToolRet-Queries). `scripts/toolret/sources.ts` also pins each LFS object's expected size and SHA-256 digest, so a mutable branch or partial download cannot silently change an evaluation.

## Fetch and verify

From the repository root, fetch the complete evaluation set:

```shell
corepack pnpm run benchmark:toolret:fetch
```

The command reuses files only after verifying them. Use `--verify-only` for an offline integrity check, `--repair` to replace a file that fails verification, or `--cache-dir <path>` to select another cache root:

```shell
corepack pnpm run benchmark:toolret:fetch --verify-only
```

## Run the baseline

Run all 7,961 query-only evaluations against the combined 44,453-tool corpus:

```shell
corepack pnpm run benchmark:toolret
```

Run the ToolRet `query + instruction` setting:

```shell
corepack pnpm run benchmark:toolret --with-instruction
```

The default outputs are `.cache/toolret/results/bm25-query-only.json` and `.cache/toolret/results/bm25-with-instruction.json`. Each result records source revisions, selection, corpus and query counts, BM25 parameters, aggregate metrics, category metrics, and local timing. Timing is diagnostic rather than a cross-machine performance score.

For a quick smoke run or a focused task, use `--limit`, repeat `--task`, or select a category. A category selection filters both queries and the corpus so every relevant tool remains in scope:

```shell
corepack pnpm run benchmark:toolret --task toolbench --limit 100 --no-write
corepack pnpm run benchmark:toolret --category code --output .cache/toolret/results/code.json
```

Other controls are `--k1`, `--b`, `--cache-dir`, and `--no-write`. The command always prints the versioned JSON result to standard output and reports progress to standard error.

## Metrics and interpretation

The evaluator reports ToolRet's public `NDCG`, `MAP`, `Recall`, `Precision`, and `Comprehensiveness` at cutoffs 5, 10, and 20. Comprehensiveness is the fraction of queries for which all relevant tools appear by the cutoff. Both aggregate and per-category results use macro averages over queries.

This BM25 implementation is a transparent infrastructure baseline, not a reproduction of a reported neural retrieval model. It tokenizes Unicode text, splits camel case, removes a small fixed English stop-word set, and resolves equal scores by tool ID. Use it to prove the data and metric path, then compare a task-conditioned router or embedding retriever against the same pinned inputs and evaluator.

## Data terms and limitations

The ToolRet dataset cards do not declare one aggregate data license, and ToolRet is assembled from multiple upstream benchmarks. The Apache-2.0 license on the authors' evaluation code does not by itself grant rights to every underlying data source. Keep the data in the ignored local cache and obtain the appropriate review before redistributing it or using it beyond internal research and evaluation.

ToolRet measures retrieval relevance, not tool execution, argument correctness, permission safety, runtime installation, or end-to-end task success. It also reflects public benchmark distributions rather than this project's eventual company workload. A result can justify or reject a retrieval design, but cannot by itself justify runtime self-modification.
