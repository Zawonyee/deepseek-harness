# 能力控制

[English](capability.md) | 中文

[Capability Controller](../../packages/capability/capability-controller/README.zh.md) 是模型工具之上的可选权限层。Loader composition 声明封闭的能力 Registry，可信 Host 插件注册 Provider。只有 Registry、生命周期、策略与可选的用户审批检查全部通过后，精确 Agent 才会获得带作用域的 Lease。Session 日志是已提交权限的权威来源；Provider Fiber、in-flight 计数与 schema generation 属于进程内执行限制状态。

源码：[`index.ts`](../../packages/capability/capability-controller/src/index.ts)、[`events.ts`](../../packages/capability/capability-controller/src/events.ts)、[`provider.ts`](../../packages/capability/capability-controller/src/provider.ts)、[`package.json`](../../packages/capability/capability-controller/package.json)

## 发布入口与 Registry 配置

该包仅发布四个代码入口，不导出 `./src/*`，也不为旧 experimental 包保留兼容别名。

| 入口 | 约定 |
|---|---|
| `@deepseek-ai/dsh-capability-controller` | Loader-compatible 默认 `CapabilityController`、具名 service、运行时 `Config` schema、公开申请/Lease/事件/fold 类型，以及 Host-only `registerProvider()` service effect。 |
| `@deepseek-ai/dsh-capability-controller/provider-web` | 注册可信 `provider-web` descriptor；active Lease 仅贡献 `web_search` 及其匹配 guidance。 |
| `@deepseek-ai/dsh-capability-controller/provider-shell` | 注册可信 `provider-shell` descriptor；active Lease 在 Windows 上贡献 `pwsh`，在其他平台贡献 `bash`，且仍使用现有 shell executor 与 sandbox policy。 |
| `@deepseek-ai/dsh-capability-controller/invariant` | 为 required-on-read `capability/change` 流安装关系校验。 |

根入口导出的 `Config` 可由 Loader 静态发现。其必填 `capabilities` 数组就是封闭 Registry：每一行均声明 capability 与 Provider 标识、风险、审批策略、默认与允许作用域，以及可选的生命周期缩短规则。校验会拒绝重复 capability ID、格式错误的 Provider/risk/scope 值、空作用域集合或不在该集合内的默认值；如果 Agent 启动时仍缺少已配置 Provider，也会故障关闭。

```ts type-equiv
/** One trusted Registry row and its policy-relevant metadata. */
interface CapabilityDefinition {
  /** Stable capability identifier requested by the model, for example `web.search`. */
  readonly capability: string
  /** Unique trusted Provider name that supplies this capability at runtime. */
  readonly provider: string
  /** Risk class used by approval policy and exposure reporting. */
  readonly risk: CapabilityRisk
  /** Whether every new activation must complete the user-approval flow. */
  readonly approvalRequired: boolean
  /** Lease scope selected when `request_capability` omits `requested_scope`. */
  readonly defaultScope: CapabilityLeaseScope
  /** Complete set of lease scopes callers may request for this capability. */
  readonly allowedScopes: CapabilityLeaseScope[]
  /** Optional idle timeout, in seconds, measured from grant or last successful use. */
  readonly idleTtlSec?: number
  /** Expire the lease after its first successful, non-aborted Provider tool call. */
  readonly expireAfterSuccessfulUse?: boolean
}
```

```ts type-equiv
/** Loader-facing static configuration. Providers are registered separately through the trusted Host service. */
interface Config {
  /** Trusted capability Registry rows available to this Controller instance. */
  readonly capabilities: CapabilityDefinition[]
}
```

## Provider descriptor

`AgentScopedCapabilityProvider` 声明一个不可变的 Provider 标识，以及其插件贡献的精确工具名与提示词段落名。注册不会激活插件。Controller 仅在已提交 Lease 存在期间将插件挂载到申请 Agent 下，并拒绝重复所有权、覆盖现有工具、Controller 工具名和 `cordis_*` 名称。

```ts type-equiv
/**
 * One trusted Provider that the Host may register with the Controller.
 *
 * Registration only declares an activatable Cordis plugin. The Controller
 * mounts that plugin below the requesting Agent's scope after policy and
 * approval succeed; declaring a Provider never grants its tools by itself.
 */
interface AgentScopedCapabilityProvider {
  /** Unique Registry-facing Provider name. */
  readonly name: string
  /** Cordis plugin mounted in the exact requesting Agent's private scope. */
  readonly plugin: Plugin
  /** Optional configuration passed unchanged to the Provider plugin. */
  readonly config?: unknown
  /** Complete, exact set of model Tool names contributed by the plugin. */
  readonly toolNames: readonly string[]
  /** Complete, exact set of system-prompt section names contributed by the plugin. */
  readonly promptSectionNames?: readonly string[]
}
```

## 申请与作用域

Lease 作用域是权限本身的一部分，而非展示信息。`turn` Lease 随所在 turn 过期，`task` Lease 绑定当前未终结 Goal，`session` 与 `persistent` Lease 持续到其精确 Agent 被 dispose。`persistent` 不会在进程重启后恢复权限。idle TTL 与成功使用后过期可以缩短任一已配置生命周期。

```ts type-equiv
/** Lease lifetimes enforced by turn, Goal, Agent, idle-TTL, and explicit-release lifecycle owners. */
type CapabilityLeaseScope = 'turn' | 'task' | 'session' | 'persistent'
```

每个已授权 Lease 都会捕获恰好一个必填 binding，且其变体必须与作用域匹配。决定由哪个 turn 或 Goal 终态负责清理的是该 binding，而不是之后再次读取 Agent 的可变状态。

```ts type-equiv
/** Durable lifetime owner captured when a lease is granted. */
type CapabilityLeaseBinding =
  | { readonly kind: 'turn'; readonly turn: number }
  | { readonly kind: 'task'; readonly goalId: string }
  | { readonly kind: 'session' }
  | { readonly kind: 'persistent' }
```

物化 Lease 仍要求该 binding 必填。如果激活前发生过审批提问，`approvalRequestId` 会携带与审批审计事件对共享的持久 receipt 标识。

```ts type-equiv
/** Materialized capability lease stored by the deployment-selected backend. */
interface CapabilityLease {
  readonly leaseId: string
  readonly sessionId: string
  readonly capability: string
  readonly provider: string
  readonly risk: CapabilityRisk
  readonly scope: CapabilityLeaseScope
  readonly binding: CapabilityLeaseBinding
  readonly approvalRequestId?: ApprovalRequestId
  readonly reason: string
  readonly status: CapabilityLeaseStatus
  readonly toolNames: readonly string[]
  readonly grantedAt: string
  readonly lastUsedAt: string
  readonly revokedAt?: string
  readonly idleTtlSec?: number
  readonly expireAfterSuccessfulUse?: boolean
}
```

申请使用 live Agent 作为权限身份。`requestedScope` 可省略；省略时选择 Registry 条目的默认值。`callId` 将必要审批关联到发起申请的模型工具调用，而中止 `signal` 会撤回待处理审批并阻止激活。

```ts type-equiv
/** Controller request authenticated by an exact Agent object. */
interface CapabilityRequest {
  readonly agent: Agent
  readonly capability: string
  readonly reason: string
  readonly requestedScope?: CapabilityLeaseScope
  /** Exact model tool call correlated with approval audit, when available. */
  readonly callId?: CallId
  /** Cancellation of the originating tool call also withdraws any approval question. */
  readonly signal?: AbortSignal
}
```

## 授权与拒绝结果

`request()` 只返回已提交授权或故障关闭拒绝。授权会报告它是否复用了该精确 Agent 的 active Lease；复用要求作用域与生命周期 binding 完全相同，且不会刷新 idle TTL。拒绝码会区分 Registry 或 Provider 缺失、策略与作用域决定、生命周期上下文缺失、审批结果、取消、Lease 冲突和激活失败。

```ts type-equiv
/** Structured grant or fail-closed denial returned after any required approval settles. */
type CapabilityRequestResult =
  | {
    readonly status: 'granted'
    readonly leaseId: string
    readonly capability: string
    readonly scope: CapabilityLeaseScope
    readonly reused: boolean
  }
  | {
    readonly status: 'denied'
    readonly capability: string
    readonly code:
      | 'registry-miss'
      | 'provider-unavailable'
      | 'policy-denied'
      | 'scope-not-allowed'
      | 'task-goal-required'
      | 'lease-scope-conflict'
      | 'approval-rejected'
      | 'approval-cancelled'
      | 'approval-unavailable'
      | 'request-cancelled'
      | 'lifecycle-context-missing'
      | 'activation-failed'
    readonly reason: string
  }
```

显式 release 会指定一个不透明 Lease 与其 live Agent owner。Controller 会区分 Lease 不存在、属于其他 Agent、已终结或 teardown 失败，并且不会发布虚假的终态事实。

```ts type-equiv
/** Explicit release request for one opaque lease id. */
interface CapabilityReleaseRequest {
  readonly agent: Agent
  readonly leaseId: string
}
```

```ts type-equiv
/** Structured result of an owner-authorized release attempt. */
type CapabilityReleaseResult =
  | {
    readonly status: 'released'
    readonly leaseId: string
    readonly capability: string
  }
  | {
    readonly status: 'denied'
    readonly leaseId: string
    readonly code: 'lease-not-found' | 'lease-not-owned' | 'lease-not-active' | 'deactivation-failed'
    readonly reason: string
  }
```

## 持久权限与执行限制

Required-on-read 的 [`capability/change`](../persistence-catalog.zh.md#capabilitychange--log-only) 事件记录申请、拒绝、新授权、复用、成功使用、显式撤销与自动过期。一次申请只会到达一个申请终态，一个 Lease 最多到达一个 Lease 终态。所有持久时间均来自事件 envelope。

当策略要求审批时，Controller 会调用 `ApprovalService.requestWithReceipt()`。其 `ApprovalReceipt.id` 会以 `approvalRequestId` 写入最终的 `denied` 事件或新 `granted` 事件，并与同一组 `approval/asked` 和 `approval/decided` 事件匹配。未发起审批的路径会省略该字段；复用完全一致的 Lease 不会产生第二份审批 receipt。

```ts type-equiv
/**
 * Required-on-read transition for one request or lease. Event envelope time is
 * authoritative for request, grant, use, reuse, and terminal timestamps.
 */
type CapabilityChange =
  | {
    readonly kind: 'requested'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly requestId: CapabilityRequestId
    readonly agentId: string
    readonly capability: string
    readonly requestedScope: CapabilityLeaseScope
    readonly reason: string
  }
  | {
    readonly kind: 'denied'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly requestId: CapabilityRequestId
    /** Approval audit pair that resolved this request, when policy asked. */
    readonly approvalRequestId?: ApprovalRequestId
    readonly code: CapabilityDenialCode
    readonly reason: string
  }
  | {
    readonly kind: 'granted'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly requestId: CapabilityRequestId
    readonly leaseId: CapabilityLeaseId
    /** Approval audit pair that authorized this grant, when policy asked. */
    readonly approvalRequestId?: ApprovalRequestId
    readonly provider: string
    readonly risk: CapabilityRisk
    readonly scope: CapabilityLeaseScope
    readonly binding: CapabilityLeaseBinding
    readonly toolNames: readonly string[]
    readonly idleTtlMs?: number
    readonly revokeAfterSuccess: boolean
  }
  | {
    readonly kind: 'reused'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly requestId: CapabilityRequestId
    readonly leaseId: CapabilityLeaseId
  }
  | {
    readonly kind: 'used'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly leaseId: CapabilityLeaseId
    readonly callId: string
    readonly toolName: string
    readonly outcome: CapabilityUseOutcome
  }
  | {
    readonly kind: 'revoked'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly leaseId: CapabilityLeaseId
    readonly reason: string
  }
  | {
    readonly kind: 'expired'
    readonly version: typeof CAPABILITY_CHANGE_VERSION
    readonly leaseId: CapabilityLeaseId
    readonly cause: CapabilityExpirationCause
    readonly reason: string
  }
```

Prompt assembly 与工具执行会分别强制检查同一份已提交权限。关闭 Lease 时先隐藏其工具与 guidance 并拒绝新调用，再等待 in-flight 调用结束、dispose 精确 Provider Fiber，最后追加 terminal event。Provider teardown 或 terminal append 失败会让权限保持故障关闭且可重试。恢复过程绝不会在缺少精确进程内 Fiber 时重新激活日志中的 Lease。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcapabilitycontroller--capabilitycontroller"></a>

### `ctx.capabilityController` — `CapabilityController`

Controller service and the only model-facing capability grant/release entry points.

```ts cordis-catalog
/**
 * Register one trusted Host-owned provider for Loader-configured capabilities.
 * @param provider - immutable Provider descriptor and its exact Tool and Prompt-section ownership.
 * @returns an async effect disposer that synchronously closes active authority before expiring its Leases.
 */
registerProvider(provider: AgentScopedCapabilityProvider): () => Promise<void>

/**
 * Resolve policy and activate at most one exact-Agent Lease for this capability.
 * A request waits for preceding transitions before selecting reuse, activation, or denial.
 * @param request - exact Agent authority, capability, reason, and requested scope.
 * @returns a structured grant or denial after any required approval settles.
 */
async request(request: CapabilityRequest): Promise<CapabilityRequestResult>

/**
 * Revoke only an active lease owned by the exact calling Agent object.
 * Concurrent releases of the same lease share one deactivation and terminal result.
 * @param request - exact Agent authority and lease id to release.
 * @returns the committed release or a structured denial.
 */
async release(request: CapabilityReleaseRequest): Promise<CapabilityReleaseResult>
```

Source: [`packages/capability/capability-controller/src/index.ts`](../../packages/capability/capability-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->
