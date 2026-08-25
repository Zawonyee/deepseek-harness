# @deepseek-ai/dsh-capability-controller

English | [中文](README.zh.md)

The Capability Controller keeps optional model tools absent until an exact Agent receives a policy-approved lease. Loader config supplies a closed Registry, trusted Host plugins register Providers, and the Session log records every request, grant, use, reuse, denial, revoke, and expiry as required-on-read `capability/change` events. The log is the only authoritative lease state; process memory retains weak incremental folds and live Provider Fibers only.

## Loader configuration

The default export is the Loader-compatible `CapabilityController` service. Each `capabilities` row requires `capability`, `provider`, `risk`, `approvalRequired`, `defaultScope`, and non-empty `allowedScopes`; `idleTtlSec` and `expireAfterSuccessfulUse` are optional. Duplicate capability ids, invalid values, a default scope outside `allowedScopes`, raw `cordis_*` tools, or a Registry Provider still missing when an Agent starts fail the composition.

`requested_scope` on `request_capability` is optional and defaults to the Registry row. A request returns only `granted` or `denied`. An exact Agent may hold one active lease per capability; a duplicate with the same scope and lifecycle binding reuses the lease without extending its idle deadline, while another scope or binding returns `lease-scope-conflict`.

The fixed Provider entries are `@deepseek-ai/dsh-capability-controller/provider-web` and `@deepseek-ai/dsh-capability-controller/provider-shell`. Both register through the Host-only `ctx.capabilityController.registerProvider()` effect and mount their tool plugin below `agent.ctx` only after a grant. Provider names, Tool names, and Prompt section names are unique; Providers may not shadow an existing Tool or contribute either Controller Tool or any `cordis_*` Tool. An external Provider implements the root-exported `AgentScopedCapabilityProvider` interface and follows the same restrictions.

## Lease lifecycle and execution

`turn` leases bind to the current turn and expire during normal `agent/turn-stopping` or the durable `turn/end` fallback. `task` leases require the current non-terminal Goal and expire on complete, block, or clear; editing and pausing retain them. `session` and `persistent` leases expire with their exact Agent, and `persistent` deliberately does not cross a process restart. Idle TTL starts at the grant event and advances only after a real controlled Provider Tool produces its final `tools/result`. `expireAfterSuccessfulUse` expires only after a successful, non-aborted Provider call. Only explicit `release_capability` writes `revoked`; every automatic terminal path writes `expired` with its cause.

Prompt assembly publishes only controlled Tools and guidance backed by a committed, non-closing lease. Execution also requires the exact owner Agent, the current schema generation, and the matching unsettled `tool/call`; Code Mode nested calls require the matching dispatch record. Release and expiry synchronously hide the schema, reject new calls, drain in-flight calls, dispose the Provider Fiber, then append one terminal event. A deactivation or append failure retains fail-closed state for retry rather than publishing a false terminal state.

Approval-required rows call `ApprovalService.requestWithReceipt()`. Only `allowed-once` proceeds; `rejected`, `cancelled`, missing support, and answerer failures produce stable denial codes. Capability approval does not bypass a shell command's separate sandbox-escalation approval.

## `controlled-doc` preset

The shipped `controlled-doc` Agent preset starts with document `read`, `write`, and `edit`, conditionally adds `read_image`, and exposes only `request_capability` and `release_capability` as capability controls. It registers approval-required `web.search` through `provider-web` with a 600-second session TTL and approval-required `shell.execute` through the platform shell Provider with a turn-bound, success-expiring Lease. It does not register `email.send`, Web or shell Tools before a grant, Goal Tools, raw Cordis Tools, or Provider guidance without its Tool.

Start the repository application, then choose **Controlled document** in the new-session preset picker:

```sh
pnpm dsh
```

## Model Experience

### Dynamic capability controls

#### What the model sees

The model always sees `request_capability` and `release_capability`. A granted Provider Tool and its guidance first appear in the next assembled request and disappear from the next request after release or expiry. Denials are compact structured Tool results rather than execution failures.

#### Token effect

The two control schemas add a stable baseline. Optional Provider schemas and guidance consume input tokens only on turns where their committed lease is visible; each lifecycle Tool result adds a small JSON record to history.

#### KV Cache effect

Requests with an unchanged entitlement set retain the same canonical Tool schema. A grant, release, or expiry changes the next schema and can invalidate cache reuse at that boundary; exact duplicate reuse does not change the schema generation.

## Known Limitations and Deferred Work

- V1 does not generate or promote Registry misses, install Marketplace Providers, rewrite Agent Runtime, switch live presets, or provide a visual composition builder.
- `email.send` is an external Provider integration contract with a deterministic test outbox; the shipped preset does not register an email implementation.
- Persistent leases represent an Agent-lifetime policy choice, not restartable authority. Startup expires a logged active lease instead of reactivating its Provider.
- Telemetry observes committed events only. Sink failures are warnings and cannot roll back or create authority.
