# Agent Note: Pinned ToolRet retrieval benchmark

Status: implemented

English | [中文](2026-08-19-pinned-toolret-retrieval-benchmark.zh.md)

## Problem

The dynamic capability-composition experiment has no representative company task stream yet. Measuring it only with hand-written Harness prompts would couple the result to the prototype's own vocabulary and make a favorable result easy to manufacture, while starting with end-to-end execution would mix retrieval quality with tool availability, argument generation, permissions, and runtime failures. The repository also must not silently vendor a multi-source public dataset whose aggregate data license is unspecified.

## Decision

The repository carries a local ToolRet retrieval lane under [`scripts/toolret`](../../../../scripts/toolret/README.md). It pins the authors' tool and query repositories to explicit revisions, pins every Parquet object's size and SHA-256 digest, downloads all data into the ignored `.cache/toolret/` tree, and validates external rows before they enter the evaluator. The adapter preserves the upstream instruction-only query and normalizes only Python-style non-finite numeric literals embedded in otherwise valid label JSON.

The first baseline is an in-process inverted BM25 index over the combined 44,453-tool corpus. It evaluates the 7,961-query set both without and with ToolRet's task instruction, reports the benchmark's `NDCG`, `MAP`, `Recall`, `Precision`, and `Comprehensiveness` at 5, 10, and 20, and emits versioned JSON with source revisions and selection metadata. The lane is evaluation tooling rather than a product package: it does not register a Harness tool, alter the session loop, or create a runtime installation mechanism.

## Alternatives considered

**Vendor the ToolRet Parquet files.** This would make first use offline, but it would add binary data to Git and imply a redistribution posture the aggregate dataset card does not grant. A pinned downloader with content digests gives reproducibility without treating the data as project source.

**Begin with an end-to-end tool-execution benchmark.** MCP-Atlas or an internal replay can later test selection, argument generation, permissions, and outcomes together, but those variables would hide whether the initial capability router retrieves the right tools. Retrieval is the smaller falsifiable question.

**Use only synthetic Harness tool schemas.** Synthetic tasks are useful for deterministic unit tests, but they are too small and share too much vocabulary with the implementation to support a go/no-go decision. They remain fixtures for adapter and metric correctness, not the evaluation corpus.

**Add the benchmark as a workspace package.** A package would suggest a supported runtime or library boundary before any retrieval design has earned product ownership. Root scripts keep the experiment reproducible without expanding the shipped package graph.

## Consequences

The experiment now has a public, fixed, model-key-free baseline that can be rerun on a laptop and compared with a future task-conditioned router. Query-only and query-plus-instruction results share one data adapter and evaluator, so improvements cannot come from changing the corpus or metric implementation between runs. The checked-in unit tests cover source pinning, malformed rows, upstream `NaN`, instruction-only queries, deterministic ranking, and metric calculations.

The lane measures public retrieval relevance only. It does not establish that company traffic has the same distribution, that selected tools execute successfully, that runtime mutation is safe, or that a neural retriever reproduces ToolRet's published numbers. First use requires network access, full runs consume local CPU time, and any redistribution or broader data use still requires review of the underlying datasets' terms.
