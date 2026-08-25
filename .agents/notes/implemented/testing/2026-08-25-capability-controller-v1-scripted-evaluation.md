# Agent Note: Capability Controller V1 scripted evaluation

Status: implemented

English | [中文](2026-08-25-capability-controller-v1-scripted-evaluation.zh.md)

## Problem

Capability availability strategies cannot be compared from raw Tool lists alone. Full pre-mounting, Raw Cordis runtime activation, and Controller Leases acquire authority differently, so a comparison that does not normalize entitlements can undercount exposure in one mode. A model-backed run also mixes availability policy with sampling, provider behavior, and external failures, making it unsuitable as the only reproducible baseline.

## Decision

The [`capability-controller-eval`](../../../../scripts/capability-controller-eval/README.md) lane owns a fixed, offline scripted comparison of Full, Raw Cordis, and Controller modes. It normalizes pre-mounted capabilities, runtime activation, and Leases as effective entitlements; scores exact per-step Tool schemas; and aggregates task oracles, intervention, exposure, schema churn, lifecycle events, and disjoint token/cache usage under one metric implementation.

The recorded baseline was executed on 2026-08-25 from the repository root with no result files written:

```powershell
pnpm.cmd exec tsx scripts/capability-controller-eval/run.ts --no-write
```

The command completed successfully with one repetition, seven tasks, and seven trials per mode.

## Recorded baseline

| Mode | Task success rate | User intervention rate | Average visible Tool count | Unnecessary grant rate | High-risk exposure | Risk exposure | Schema churn rate |
|---|---:|---:|---:|---:|---:|---:|---:|
| Full | 1 | 0.14286 | 5 | 0.71429 | 1 | 13 | 0 |
| Raw Cordis | 1 | 0.57143 | 9.55 | 0.53846 | 1 | 10.5 | 0.76923 |
| Controller | 1 | 0.57143 | 4.52381 | 0 | 0.375 | 2.5 | 0.71429 |

| Mode | Activation | Reuse | Revoke | Expire | Deny |
|---|---:|---:|---:|---:|---:|
| Full | 0 | 0 | 0 | 0 | 1 |
| Raw Cordis | 6 | 1 | 4 | 0 | 1 |
| Controller | 6 | 1 | 4 | 0 | 1 |

| Mode | Input tokens | Output tokens | Cache-read tokens | Cache-write tokens | Total tokens | Reported / unreported steps |
|---|---:|---:|---:|---:|---:|---:|
| Full | 1,610 | 142 | 70 | 0 | 1,822 | 13 / 0 |
| Raw Cordis | 3,735 | 292 | 90 | 0 | 4,117 | 20 / 0 |
| Controller | 2,393 | 208 | 90 | 0 | 2,691 | 21 / 0 |

## Task corpus

- `doc-only` uses no optional capability.
- `web-single` requires one web search.
- `web-reuse-two-turns` reuses web search across two turns.
- `email-allowed` sends one approved outbox message.
- `email-rejected` observes rejection and produces no outbox call.
- `shell-workspace` runs the workspace-confined shell fixture after capability approval.
- `web-then-email` combines web search with one approved outbox message.

Registry miss remains a safety test rather than a headline task. The email Provider is a deterministic outbox fixture, and the shell Provider is a deterministic workspace fixture that does not execute an operating-system command or treat capability approval as sandbox escalation approval.

## Reproduction and networked entry

The scripted command is the committed baseline entry. Omitting `--no-write` writes only beneath `.cache/capability-controller-eval/results/`; those results are not committed. The assembled Loader runner defaults to the keyless replay engine and is available through `pnpm.cmd run eval:capability-controller --no-write`.

A networked run is explicit and records provider, model, repetition count, and seed:

```powershell
pnpm.cmd run eval:capability-controller --engine real --provider deepseek-official --model deepseek-v4-flash --repeat 3 --seed 42 --no-write
```

The seed is benchmark metadata because the current DeepSeek adapter does not expose a provider sampling-seed parameter. Real-engine observations can omit usage; a persisted run uses an explicit `--output` beneath `.cache/capability-controller-eval/results/` rather than replacing the scripted baseline.

## Alternatives considered

**Use only the assembled Loader replay as the baseline.** Loader replay is valuable integration evidence, but it couples metric regression checks to package builds, Loader startup, and AgentLoop behavior. The normalized scripted lane keeps formulas and the golden corpus independently reproducible, while Loader tests cover the assembled path.

**Commit real-engine measurements as the golden result.** Networked responses vary with model and provider behavior, require credentials, and can fail independently of capability policy. Real runs remain opt-in observations with explicit inputs rather than the source of deterministic pass/fail evidence.

**Compare visible Tool counts without entitlement normalization.** This would omit Full's startup authority or Raw Cordis's critical runtime controls from the denominator and make a lower exposure score an artifact of representation. Effective entitlements give the three acquisition mechanisms the same accounting treatment.

## Consequences

The baseline demonstrates equal scripted task success while the Controller exposes fewer Tools than Full and Raw Cordis, records no unnecessary grant, and reduces risk exposure to 2.5 from 13 and 10.5 respectively. Web reuse contributes one activation and one reuse without granting an optional capability to the document-only task.

These figures validate the fixed fixtures, normalization, and aggregation path; they do not establish real-model task quality, actual prompt-schema token cost, Provider reliability, operating-system sandbox behavior, or latency. Conclusions about those properties require repeated assembled or networked runs with their engine, provider, model, repetition count, seed, and result directory recorded separately.
