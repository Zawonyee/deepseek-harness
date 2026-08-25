# Capability Controller V1 eval

English | [中文](README.zh.md)

This directory is the reproducible metric and fixture layer for comparing three capability-availability modes: a Full agent that receives every optional capability at startup, a Raw Cordis agent that can author and run dynamic plugins directly, and a Controller agent that can only request and release trusted capabilities. Both default commands are keyless and offline. The scripted baseline only reads committed normalized trajectories; the assembled Loader runner exercises process-local fixture tools and lifecycle transitions but performs no network request, operating-system shell command, email delivery, or other external side effect.

## Run the scripted baseline

Run the checked-in normalized baseline directly when validating formulas and golden fixtures:

```shell
corepack pnpm exec tsx scripts/capability-controller-eval/run.ts --no-write
```

Omit `--no-write` to write `manifest.json`, `trials.jsonl`, and `summary.json` under `.cache/capability-controller-eval/results/latest/`. The command always prints the summary to standard output and sends progress or failures to standard error. Filter with repeatable `--mode` and `--task`, change the positive repetition count with `--repeat`, or select another result directory with `--output`:

```shell
corepack pnpm exec tsx scripts/capability-controller-eval/run.ts \
  --mode controller --task web-reuse-two-turns --repeat 3 \
  --output .cache/capability-controller-eval/results/controller-smoke
```

`tasks.jsonl` is the fixed task corpus. Each row carries prompts, required and allowed capabilities, deterministic approval answers, success-oracle declarations, and the fixture path for each mode. `fixtures/scripted/*.jsonl` contains the normalized observation for every mode/task pair: exact per-step tool schemas, disjoint token usage, capability entitlements, lifecycle counters, intervention count, and oracle outcomes. `fixtures/expected-scripted-summary.json` pins the complete default result.

## Run the assembled Loader benchmark

The built-in Loader runner executes the same corpus through fresh mode-pinned Cordis compositions and the real AgentLoop request path. Its default `replay` engine is keyless and offline: it uses the official replay adapter plus deterministic in-memory web, email-outbox, and shell fixtures. The shell fixture never invokes an operating-system shell. Session events are normalized by the production-session collector, so tool schemas, Provider results, approvals, capability lifecycle facts, and usage come from the executed composition rather than a scripted trial row.

```shell
pnpm run eval:capability-controller -- --no-write
```

The root script first builds the Host libraries consumed by the JavaScript-only Loader facade, then runs the equivalent of `corepack pnpm exec tsx scripts/capability-controller-eval/loader-runner.ts`. This prevents a clean checkout or stale local bundle from changing the result.

Omit `--no-write` to write `manifest.json`, `trials.jsonl`, and `summary.json` under `.cache/capability-controller-eval/loader-latest/`. Repeatable `--mode` and `--task`, plus `--repeat`, `--seed`, and `--output`, have the same filtering purpose as the scripted runner. Each trial gets a fresh Loader tree. The three leaves under `compositions/` pin the Full, Raw Cordis, and Controller modes; the runner supplies per-trial replay paths and other runtime values as Loader patches.

An explicitly networked run currently supports the `deepseek-official` adapter. It requires a usable `DEEPSEEK_API_KEY` plus explicit provider, model, and seed inputs:

```shell
corepack pnpm exec tsx scripts/capability-controller-eval/loader-runner.ts \
  --engine real --provider deepseek-official --model deepseek-v4-flash \
  --seed 42 --mode controller --task web-single --no-write
```

The seed is validated and recorded as a benchmark input, but the current DeepSeek adapter does not expose a provider sampling-seed parameter; it does not make a networked model response deterministic.

## Comparison modes

- `full` starts every task with `web.search`, `email.send`, and `shell.execute` available. These startup rows count as effective entitlements even though no Lease event created them.
- `raw-cordis` starts with the current seven raw controls: `cordis_inspect_list`, `cordis_inspect_query`, `cordis_inspect_self`, `cordis_define`, `cordis_run`, `cordis_stop`, and `cordis_undefine`. They are scored together as the critical-risk `cordis.runtime` capability. Task capabilities appear after a successful normalized activation.
- `controller` starts with `request_capability` and `release_capability`, and with no optional task capability. Normalized grants, reuse, revocation, expiry, and denial come from Controller audit facts.

All three modes retain the same two core document tools in these fixtures. The scripted trajectories intentionally describe observable requests rather than pretending to be real Loader runs. The assembled Loader runner is the production integration of the same parser, metric layer, and output format.

## Fixed tasks

The corpus covers a task needing no optional capability, one web lookup, web reuse across two turns, an approved email, a rejected email with no delivery, a workspace-confined shell call, and a mixed web-then-email flow. `email.send` uses an outbox provider name because the repository has no production email provider. `shell-workspace` never requests `sandbox_permissions`: a capability grant and a command-specific sandbox escalation are separate approvals, and the former never implies `danger-full-access`.

## Metrics

Metrics derive from additive trial numerators so tasks with more steps cannot be averaged twice.

- Task success rate is successful all-clause oracles divided by trials; a runtime error is a failure.
- User intervention rate is trials with at least one approval or question divided by trials. The summary also reports interventions per trial.
- Average visible tool count is the sum of `header.tools` counts over model steps divided by model steps.
- Unnecessary capability grant rate counts distinct effective entitlements not named in the task's `requiredCapabilities`, divided by all distinct effective entitlements. Startup Full capabilities and Raw Cordis access use the same denominator as Controller Leases; a zero denominator produces zero.
- `Exposure(c)` is turns where any tool mapped to capability `c` was visible in at least one model step, divided by turns containing a model step. High-risk exposure is the corresponding union for `high` and `critical` capabilities.
- Risk exposure is `sum(weight(risk(c)) * Exposure(c))`, with fixed weights `low=1`, `medium=2`, `high=4`, and `critical=8`. Normalized risk exposure divides that value by the catalog's total weight.
- Tool schema churn hashes tools sorted by name after recursively sorting object keys. The first schema is a baseline; churn counts only unequal adjacent model-step hashes and divides by the number of adjacent transitions.
- Token totals sum the disjoint `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens` fields. Billed input is input plus both cache fields; total is billed input plus output. Reasoning tokens are reported but not added again. Scripted fixtures must report usage for every step.

Replay usage is deterministic plumbing data for exercising aggregation and cache accounting; it is not a measurement of real prompt-schema token cost. Use an explicitly networked repeated run before drawing model-cost conclusions.

The committed baseline is evidence that the calculation path is stable, not evidence that the Controller has passed a real task. Wall time is deliberately absent from the golden result.

## Collect a production session

`session-collector.ts` converts one fresh persisted DSH session into the same normalized trial vocabulary used by the metric layer. It reads plaintext `.jsonl` and Zstandard `.jsonl.zstd` artifacts, expands packed chunk rows, carries each durable `request/header` forward until it changes, and records the exact schema and optional `assistant/message` usage for every model step. Controller lifecycle and entitlement counts come only from durable `capability/change` facts; approvals come from `approval/asked`; successful Provider-call proxies require a matching non-error `tool/result`.

```shell
corepack pnpm exec tsx scripts/capability-controller-eval/session-collector.ts \
  --session /path/to/session.jsonl.zstd \
  --task web-single --mode controller \
  --output .cache/capability-controller-eval/web-single-controller.json
```

The collector requires exactly the task's number of complete turns starting at turn 1. This intentionally rejects resumed, seeded, partial, or multi-task sessions instead of attributing unrelated history to a trial. In Controller mode it also rejects a request schema that exposes Raw Cordis controls, exposes a catalog capability without an active durable Lease, or omits a leased catalog tool. A revoke at the end of the session still needs the runtime integration test to prove the next real request no longer contains the tool; a log with no subsequent request cannot establish that fact by itself.

The fixed provider oracles map `web-search-fixture` to `web_search`, `email-outbox-fixture` to `send_email`, and `shell-workspace-fixture` to `bash` or `pwsh`. These are successful-tool-result proxies. A real driver with a Provider-owned outbox or call counter should pass exact observations with repeatable `--provider-call <provider>=<count>`; exact counts take precedence. `file-sha256` clauses require `--workspace`. Real adapters are allowed to omit usage, and summaries report those requests as `unreportedSteps`; committed scripted fixtures still require usage on every step.

## External normalized driver

The CLI exposes an explicit extension point without making the default networked:

```shell
corepack pnpm exec tsx scripts/capability-controller-eval/run.ts \
  --engine real --provider deepseek-official --model deepseek-v4-flash \
  --driver ./path/to/built-real-driver.mjs
```

The driver must default-export, or export as `driver`, an object with `run(options)`. It receives the selected tasks, modes, repetitions, provider, and model, and returns normalized trial observations conforming to `EvalTrialFixture`. The CLI validates those observations again before scoring. A driver can call `readSessionArtifact()` and `collectSessionTrial()` after each run. Prefer the assembled Loader runner above for the built-in DeepSeek path; this extension point remains for independently hosted or externally orchestrated producers of normalized trials.

## Provider mapping carried by the eval

`web.search` maps to the `web_search` consumer. Production should keep `@deepseek-ai/dsh-web` and `@deepseek-ai/dsh-web-search-deepseek` on the Host and mount only `@deepseek-ai/dsh-tool-web` with search enabled and fetch disabled in the Agent scope. `web_fetch` is not part of this grant.

`shell.execute` maps to `bash` on POSIX and `pwsh` on Windows. Production must reuse the corresponding sandbox executor, sandbox policy, and user-approval service already mounted by the Host; Controller activation must never replace them with an unconfined local executor. `email.send` remains a high-risk pluggable provider and uses only the deterministic outbox fixture here.

## Verification

Run the focused parser, formula, corpus, and golden checks:

```shell
corepack pnpm exec vitest run \
  scripts/capability-controller-eval/eval.spec.ts \
  scripts/capability-controller-eval/session-collector.spec.ts \
  scripts/capability-controller-eval/loader-runner.spec.ts
```

The checks reject malformed JSONL, unsafe fixture paths, unknown modes and capabilities, missing scripted usage, fixture/task mismatches, corrupt or incomplete session logs, Controller schema/Lease disagreement, and golden drift. They also boot all three Loader compositions, exercise Controller grant, approval, reuse, release, and post-release request schemas, and assert that Controller retains equal success while reducing visible tools and risk exposure relative to Full, remains below Raw Cordis risk exposure, and never exposes `cordis.runtime`.
