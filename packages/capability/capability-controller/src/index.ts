/**
 * Public V1 contracts and model-facing entry points for controlled dynamic capabilities.
 * @module @deepseek-ai/dsh-capability-controller
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue, Session } from '@deepseek-ai/dsh-session'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-goal'
import { AgentScopedCapabilityRuntimeAdapter } from './agent-scoped-adapter.ts'
import type {
  CapabilityExpirationCause,
  CapabilityLeaseBinding,
  CapabilityRequestId,
} from './events.ts'
import { CapabilityLeaseId } from './events.ts'
import type { AgentScopedCapabilityProvider } from './provider.ts'
import { SessionCapabilityLeaseStore } from './session-store.ts'

export { defineCapabilityProvider } from './provider.ts'
export type { AgentScopedCapabilityProvider, CapabilityProvider } from './provider.ts'
export {
  CAPABILITY_CHANGE_VERSION,
  CapabilityLeaseId,
  CapabilityRequestId,
  decodeCapabilityChange,
} from './events.ts'
export type {
  CapabilityChange,
  CapabilityDenialCode,
  CapabilityExpirationCause,
  CapabilityLeaseBinding,
  CapabilityUseOutcome,
} from './events.ts'
export {
  applyCapabilityChange,
  applyCapabilityEvent,
  emptyCapabilityFoldState,
  foldCapabilities,
} from './fold.ts'
export type {
  CapabilityFoldState,
  CapabilityLeaseRecord,
  CapabilityRequestRecord,
  FoldedCapabilities,
} from './fold.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilityController: CapabilityController
  }
}

/** Stable risk classification used by policy and audit ports. */
export type CapabilityRisk = 'low' | 'medium' | 'high' | 'critical'
/** Lease lifetimes enforced by turn, Goal, Agent, idle-TTL, and explicit-release lifecycle owners. */
export type CapabilityLeaseScope = 'turn' | 'task' | 'session' | 'persistent'
/** Persistable terminal state of one capability lease. */
export type CapabilityLeaseStatus = 'active' | 'revoked' | 'expired'

/** One trusted Registry row and its policy-relevant metadata. */
export interface CapabilityDefinition {
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

/** Loader-facing static configuration. Providers are registered separately through the trusted Host service. */
export interface Config {
  /** Trusted capability Registry rows available to this Controller instance. */
  readonly capabilities: CapabilityDefinition[]
}

/** Controller request authenticated by an exact Agent object. */
export interface CapabilityRequest {
  readonly agent: Agent
  readonly capability: string
  readonly reason: string
  readonly requestedScope?: CapabilityLeaseScope
  /** Exact model tool call correlated with approval audit, when available. */
  readonly callId?: CallId
  /** Cancellation of the originating tool call also withdraws any approval question. */
  readonly signal?: AbortSignal
}

/** Explicit release request for one opaque lease id. */
export interface CapabilityReleaseRequest {
  readonly agent: Agent
  readonly leaseId: string
}

/** Structured grant or fail-closed denial returned after any required approval settles. */
export type CapabilityRequestResult =
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

/** Structured result of an owner-authorized release attempt. */
export type CapabilityReleaseResult =
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

/** Materialized capability lease stored by the deployment-selected backend. */
export interface CapabilityLease {
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

/** Fields required to allocate one new active lease. */
export interface CapabilityLeaseCreate {
  readonly sessionId: string
  readonly capability: string
  readonly provider: string
  readonly risk: CapabilityRisk
  readonly scope: CapabilityLeaseScope
  readonly session?: Session
  readonly requestId?: CapabilityRequestId
  readonly binding: CapabilityLeaseBinding
  readonly approvalRequestId?: ApprovalRequestId
  readonly reason: string
  readonly toolNames: readonly string[]
  readonly now: string
  readonly idleTtlSec?: number
  readonly expireAfterSuccessfulUse?: boolean
}

/** Synchronous lease-state persistence port used inside serialized Controller transitions. */
export interface CapabilityLeaseStore {
  findActive(query: {
    readonly sessionId: string
    readonly capability: string
    readonly scope: CapabilityLeaseScope
  }): CapabilityLease | undefined
  create(input: CapabilityLeaseCreate): CapabilityLease
  touch(leaseId: string, now: string, session?: Session): CapabilityLease
  revoke(leaseId: string, now: string, session?: Session): CapabilityLease
  get(leaseId: string, session?: Session): CapabilityLease | undefined
  list(session?: Session): readonly CapabilityLease[]
}

/** Trusted capability lookup with no discovery or generation fallback. */
export interface CapabilityRegistry {
  get(capability: string): CapabilityDefinition | undefined
}

/** Deterministic policy outcome for a trusted Registry row. */
export type CapabilityPolicyDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'approval-required'; readonly reason: string }
  | { readonly kind: 'deny'; readonly reason: string }

/** Deployment policy port evaluated before runtime activation. */
export interface CapabilityPolicy {
  evaluate(input: {
    readonly agent: Agent
    readonly definition: CapabilityDefinition
    readonly reason: string
    readonly requestedScope: CapabilityLeaseScope
  }): CapabilityPolicyDecision | Promise<CapabilityPolicyDecision>
}

/** Runtime activation receipt containing the exact contributed model-tool names. */
export interface CapabilityActivation {
  readonly toolNames: readonly string[]
}

/** Runtime port that activates and deactivates one exact Agent's capability effects. */
export interface CapabilityRuntimeAdapter {
  activate(input: {
    readonly agent: Agent
    readonly definition: CapabilityDefinition
    readonly scope: CapabilityLeaseScope
  }): Promise<CapabilityActivation>
  deactivate(input: { readonly agent: Agent; readonly lease: CapabilityLease }): Promise<void>
}

/** Audit event vocabulary emitted by V1 Controller transitions. */
export type CapabilityTelemetryEventType =
  | 'capability_requested'
  | 'capability_granted'
  | 'capability_denied'
  | 'capability_reused'
  | 'capability_released'
  | 'capability_activation_failed'

/** Detached audit facts for one request, grant, reuse, denial, or release. */
export interface CapabilityTelemetryEvent {
  readonly type: CapabilityTelemetryEventType
  readonly timestamp: string
  readonly sessionId: string
  readonly capability: string
  readonly risk?: CapabilityRisk
  readonly leaseScope?: CapabilityLeaseScope
  readonly leaseId?: string
  readonly reason: string
}

/** Deployment-selected audit sink. */
export interface CapabilityTelemetry {
  record(event: CapabilityTelemetryEvent): void | Promise<void>
}

/** Complete trusted dependency set required by the Controller service. */
export interface CapabilityControllerPorts {
  readonly registry: CapabilityRegistry
  readonly policy: CapabilityPolicy
  readonly leases: CapabilityLeaseStore
  readonly adapter: CapabilityRuntimeAdapter
  readonly telemetry: CapabilityTelemetry
  readonly now?: () => string
}

function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('capability tools require a calling Agent')
  return exec.agent
}

function requestToolValue(result: CapabilityRequestResult): JsonValue {
  if (result.status === 'granted') {
    return {
      status: result.status,
      lease_id: result.leaseId,
      capability: result.capability,
      scope: result.scope,
      reused: result.reused,
    }
  }
  return {
    status: result.status,
    capability: result.capability,
    code: result.code,
    reason: result.reason,
  }
}

function releaseToolValue(result: CapabilityReleaseResult): JsonValue {
  if (result.status === 'released') {
    return { status: result.status, lease_id: result.leaseId, capability: result.capability }
  }
  return {
    status: result.status,
    lease_id: result.leaseId,
    code: result.code,
    reason: result.reason,
  }
}

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Statically discoverable Loader schema for the trusted capability Registry. */
export const Config: z<Config> = z.object({
  capabilities: z.array(z.object({
    capability: z.string().min(1).required(),
    provider: z.string().min(1).required(),
    risk: z.union(['low', 'medium', 'high', 'critical'] as const).required(),
    approvalRequired: z.boolean().required(),
    defaultScope: z.union(['turn', 'task', 'session', 'persistent'] as const).required(),
    allowedScopes: z.array(z.union(['turn', 'task', 'session', 'persistent'] as const)).min(1).required(),
    idleTtlSec: z.number().min(1),
    expireAfterSuccessfulUse: z.boolean().default(false),
  })).required(),
})

function isControllerPorts(value: unknown): value is CapabilityControllerPorts {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['registry'] !== undefined
    && record['policy'] !== undefined
    && record['leases'] !== undefined
    && record['adapter'] !== undefined
    && record['telemetry'] !== undefined
}

const CONTROLLER_CONFIG_SCHEMA: z<Config> = z.transform(z.any(), (value) => {
  // Test and embedding deployments may still inject the original explicit
  // ports. Loader YAML always takes the public Config branch below.
  if (isControllerPorts(value)) return value as unknown as Config
  const input: unknown = value
  const config = Config(input as Config | null | undefined)
  const ids = new Set<string>()
  for (const definition of config.capabilities) {
    if (definition.capability.length === 0 || definition.capability !== definition.capability.trim()) {
      throw new TypeError('capability id must be a non-empty trimmed string')
    }
    if (definition.provider.length === 0 || definition.provider !== definition.provider.trim()) {
      throw new TypeError(`capability "${definition.capability}" Provider must be a non-empty trimmed string`)
    }
    if (ids.has(definition.capability)) {
      throw new TypeError(`duplicate capability id "${definition.capability}"`)
    }
    ids.add(definition.capability)
    if (!definition.allowedScopes.includes(definition.defaultScope)) {
      throw new TypeError(`capability "${definition.capability}" defaultScope must be allowed`)
    }
  }
  return config
})

interface ResolvedCapabilityRequest extends CapabilityRequest {
  readonly requestedScope: CapabilityLeaseScope
  readonly durableRequestId?: CapabilityRequestId
  readonly binding?: CapabilityLeaseBinding
  readonly approvalRequestId?: ApprovalRequestId
}

interface PresentedCapabilityAssembly {
  readonly assembly: PromptAssembly
  readonly authorityLeaseIdsByTool: ReadonlyMap<string, string>
  readonly leaseIdsByTool: ReadonlyMap<string, string>
}

interface DurableExecutionCoordinates {
  readonly turn: number
  readonly step: number
}

interface ExpirationRetryIntent {
  readonly owner: WeakRef<Agent>
  readonly cause: CapabilityExpirationCause
  readonly reason: string
}

const EXPIRATION_RETRY_DELAY_MS = 100

type ControllerLifecycleState = 'running' | 'disposing' | 'disposed'

/** Controller service and the only model-facing capability grant/release entry points. */
export class CapabilityController extends Service {
  static inject = ['tools', 'systemPrompt']

  static Config = CONTROLLER_CONFIG_SCHEMA

  private readonly ownerCtx: Context
  private readonly activeByAgent = new WeakMap<Agent, Map<string, string>>()
  private readonly leaseOwners = new Map<string, WeakRef<Agent>>()
  private readonly pendingByAgent = new WeakMap<Agent, Map<string, Promise<CapabilityRequestResult>>>()
  private readonly pendingReleases = new Map<string, Promise<CapabilityReleaseResult>>()
  private readonly pendingReleaseByAgent = new WeakMap<Agent, Map<string, Promise<CapabilityReleaseResult>>>()
  private readonly transitionTails = new WeakMap<Agent, Map<string, Promise<void>>>()
  private readonly productionStore?: SessionCapabilityLeaseStore
  private readonly runtimeAdapter?: AgentScopedCapabilityRuntimeAdapter
  private readonly configuredProviderNames?: ReadonlySet<string>
  private readonly controlledTools = new Set<string>()
  private readonly toolProviders = new Map<string, string>()
  private readonly controlledSections = new Set<string>()
  private readonly sectionProviders = new Map<string, string>()
  private readonly presentedTools = new WeakMap<Agent, ReadonlySet<string>>()
  private readonly presentedAssemblies = new WeakMap<Agent, PresentedCapabilityAssembly>()
  private readonly stepAdmissions = new WeakMap<Agent, Map<string, ReadonlyMap<string, string>>>()
  private readonly providerValidatedAgents = new WeakSet<Agent>()
  private readonly definitionFingerprints = new Map<string, string>()
  private readonly closingLeases = new Set<string>()
  private readonly leaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inFlightByLease = new Map<string, number>()
  private readonly executionLeases = new WeakMap<ToolExecution, string>()
  private readonly drainWaiters = new Map<string, { readonly promise: Promise<void>; readonly resolve: () => void }>()
  private readonly pendingExpirations = new Map<string, Promise<void>>()
  private readonly expirationRetryIntents = new Map<string, ExpirationRetryIntent>()
  private readonly expirationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly deactivatedLeases = new Set<string>()
  private readonly closingProviders = new Set<string>()
  private readonly pendingActivations = new Map<string, Set<Promise<void>>>()
  private controllerState: ControllerLifecycleState = 'running'
  /** Trusted Registry, policy, lease, activation, and telemetry dependencies used by this instance. */
  readonly ports: CapabilityControllerPorts

  constructor(ctx: Context, config: Config) {
    super(ctx, 'capabilityController')
    this.ownerCtx = ctx

    if (isControllerPorts(config)) {
      this.ports = config
    } else {
      this.assertNoRawCordisTools()
      const definitions = new Map(config.capabilities.map(definition => [definition.capability, definition]))
      const leases = new SessionCapabilityLeaseStore()
      const adapter = new AgentScopedCapabilityRuntimeAdapter(ctx)
      this.productionStore = leases
      this.runtimeAdapter = adapter
      this.configuredProviderNames = new Set(config.capabilities.map(definition => definition.provider))
      this.ports = {
        registry: { get: capability => definitions.get(capability) },
        policy: {
          evaluate: ({ definition }) => Promise.resolve(definition.approvalRequired
            ? { kind: 'approval-required', reason: `capability "${definition.capability}" requires approval` }
            : { kind: 'allow' }),
        },
        leases,
        adapter,
        telemetry: { record: () => undefined },
      }
      ctx.effect(function* (this: CapabilityController) {
        yield ctx.tools.guard(exec => this.productionGuard(exec))
        yield ctx.on('tools/change', () => { this.assertNoRawCordisTools() })
        yield ctx.on('tools/execute', async (exec, next) => {
          const lease = exec.agent === undefined
            ? undefined
            : this.activeLeaseForTool(exec.agent, exec.name)
          if (lease === undefined) return await next()
          this.executionLeases.set(exec, lease.leaseId)
          this.beginExecution(lease.leaseId)
          return await next()
        })
        yield ctx.on('tools/result', (exec, result) => {
          const leaseId = this.executionLeases.get(exec)
          if (leaseId === undefined) return
          try {
            const agent = exec.agent
            const lease = agent === undefined
              ? undefined
              : this.ports.leases.get(leaseId, agent.session)
            if (agent !== undefined && lease !== undefined && lease.status === 'active'
            && this.ownsLease(leaseId, agent)) {
              this.recordProviderUse(agent, lease, String(exec.callId), exec.name,
                result.isError ? 'failed' : 'succeeded', exec.signal.aborted)
            }
          } finally {
            this.endExecution(leaseId)
          }
        })
        yield ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
          await this.expireMatching(agent, lease => lease.binding.kind === 'turn'
          && lease.binding.turn === turn, 'turn-ended', `turn ${turn} is stopping`)
        })
        yield ctx.on('session/event', (session, event) => {
          if (event.type === 'step/end') {
            const agent = this.ownerCtx.get('agents')?.get(session.id)
            if (agent !== undefined) {
              this.stepAdmissions.get(agent)?.delete(stepAdmissionKey(event.data.turn, event.data.step))
            }
            return
          }
          if (event.type !== 'turn/end') return
          this.forEachOwnerInSession(session, (agent) => {
            void this.expireMatching(agent, lease => lease.binding.kind === 'turn'
            && lease.binding.turn === event.data.turn, 'turn-ended',
            `turn ${event.data.turn} ended`).catch((error: unknown) => {
              this.ownerCtx.logger.warn(`capability turn expiry failed: ${errorMessage(error)}`)
            })
          })
        })
        yield ctx.on('goal/changed', ({ agent, change }) => {
          if (change.operation !== 'complete'
          && change.operation !== 'block'
          && change.operation !== 'clear') return
          void this.expireMatching(agent, lease => lease.binding.kind === 'task'
          && lease.binding.goalId === change.ref.id, 'goal-terminal',
          `Goal ${change.ref.id} became terminal`).catch((error: unknown) => {
            this.ownerCtx.logger.warn(`capability Goal expiry failed: ${errorMessage(error)}`)
          })
        })
        yield ctx.on('agent/disposed', ({ agent }) => {
          void this.expireMatching(agent, () => true, 'agent-disposed',
            'the exact Agent was disposed').catch((error: unknown) => {
            this.ownerCtx.logger.warn(`capability Agent expiry failed: ${errorMessage(error)}`)
          })
        })
        yield ctx.on('agent/created', ({ agent }) => {
          this.ensureConfiguredProviders(agent)
        })
        yield ctx.on('agent/session-start', ({ agent }) => {
          this.ensureConfiguredProviders(agent)
          this.reconcileProcessLocalAuthority(agent)
        })
        yield ctx.on('session/disposed', (session) => {
          this.forEachOwnerInSession(session, (agent) => {
            void this.expireMatching(agent, () => true, 'session-disposed',
              'the owning Session was disposed').catch((error: unknown) => {
              this.ownerCtx.logger.warn(`capability Session expiry failed: ${errorMessage(error)}`)
            })
          })
        })
        yield ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
          const transformed = await next()
          const agent = context.agent
          if (agent !== undefined) {
            this.ensureConfiguredProviders(agent)
            await this.reconcileRegistryAuthority(agent)
          }
          const authorityLeaseIds = agent === undefined
            ? new Map<string, string>()
            : this.activeLeaseIdsByTool(agent)
          const filtered: PromptAssembly = {
            ...transformed,
            tools: transformed.tools.filter(tool => !tool.name.startsWith('cordis_')
            && (!this.controlledTools.has(tool.name) || authorityLeaseIds.has(tool.name))),
            sections: transformed.sections.filter(section => !this.controlledSections.has(section.name)
            || this.sectionIsAllowed(section.name, agent)),
          }
          if (agent !== undefined) {
            const presented = new Set(filtered.tools.map(tool => tool.name))
            const leaseIdsByTool = new Map([...authorityLeaseIds]
              .filter(([toolName]) => presented.has(toolName)))
            this.presentedTools.set(agent, presented)
            this.presentedAssemblies.set(agent, {
              assembly: filtered,
              authorityLeaseIdsByTool: authorityLeaseIds,
              leaseIdsByTool,
            })
          }
          return filtered
        }, true)
        yield ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
          const prepared = this.presentedAssemblies.get(agent)
          const decision = await next()
          if (decision.kind === 'reject' || signal.aborted) return decision

          await this.reconcileRegistryAuthority(agent)
          let effective = prepared
          const authorityLeaseIds = this.activeLeaseIdsByTool(agent)
          if (prepared !== undefined
          && !sameStringMap(prepared.authorityLeaseIdsByTool, authorityLeaseIds)) {
            const systemPrompt = this.ownerCtx.get('systemPrompt')
            if (systemPrompt === undefined) {
              throw new Error('CapabilityController cannot reassemble without SystemPrompt')
            }
            const refreshed = await systemPrompt.assemble(assembleContextFor(agent, signal))
            overwriteAssembly(prepared.assembly, refreshed)
            const presented = this.presentedAssemblies.get(agent)
            if (presented !== undefined) {
              effective = { ...presented, assembly: prepared.assembly }
              this.presentedAssemblies.set(agent, effective)
            }
          }
          this.stepAdmissionMap(agent).set(
            stepAdmissionKey(turn, step),
            new Map(effective?.leaseIdsByTool ?? []),
          )
          return decision
        }, true)
        yield async () => { await this.disposeProductionAuthority() }
      }.bind(this), 'capability-controller: enforce and expire process-local authority')
    }

    ctx.tools.register(defineTool({
      name: 'request_capability',
      description: 'Request one capability from the trusted Registry. Omit requested_scope to use its configured default; do not guess or probe alternative scopes. Save lease_id from a granted result for release_capability.',
      parameters: {
        capability: { type: 'string', required: true },
        reason: { type: 'string', required: true },
        requested_scope: {
          type: 'string',
          enum: ['turn', 'task', 'session', 'persistent'],
          description: 'Optional scope override. Omit this field to use the trusted Registry default; do not guess or retry alternative scopes.',
        },
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => this.request({
        agent: requireAgent(exec),
        capability: args.capability,
        reason: args.reason,
        ...args.requested_scope === undefined ? {} : { requestedScope: args.requested_scope },
        callId: exec.callId,
        signal: exec.signal,
      }).then(requestToolValue),
    }))

    ctx.tools.register(defineTool({
      name: 'release_capability',
      description: 'Release one active capability lease owned by the calling Session. Pass the exact lease_id returned by request_capability when that lease is still active after its last required use.',
      parameters: {
        lease_id: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => this.release({
        agent: requireAgent(exec),
        leaseId: args.lease_id,
      }).then(releaseToolValue),
    }))
  }

  /**
   * Register one trusted Host-owned provider for Loader-configured capabilities.
   * @param provider - immutable Provider descriptor and its exact Tool and Prompt-section ownership.
   * @returns an async effect disposer that synchronously closes active authority before expiring its Leases.
   */
  registerProvider(provider: AgentScopedCapabilityProvider): () => Promise<void> {
    if (this.runtimeAdapter === undefined) {
      throw new Error('trusted provider registration is only available with Loader Config')
    }
    if (this.controllerState !== 'running') {
      throw new Error('trusted provider registration is unavailable while CapabilityController is stopping')
    }
    if (this.closingProviders.has(provider.name)) {
      throw new Error(`capability Provider "${provider.name}" is still unloading`)
    }
    for (const name of provider.toolNames) {
      const owner = this.toolProviders.get(name)
      if (owner !== undefined) {
        throw new Error(`capability tool "${name}" is already owned by Provider "${owner}"`)
      }
    }
    const sectionNames = provider.promptSectionNames ?? []
    if (new Set(sectionNames).size !== sectionNames.length) {
      throw new Error(`capability Provider "${provider.name}" must declare unique Prompt section names`)
    }
    for (const name of sectionNames) {
      const owner = this.sectionProviders.get(name)
      if (owner !== undefined) {
        throw new Error(`capability prompt section "${name}" is already owned by Provider "${owner}"`)
      }
    }
    const disposeRegistration = this.runtimeAdapter.registerProvider(provider)
    for (const name of provider.toolNames) {
      this.controlledTools.add(name)
      this.toolProviders.set(name, provider.name)
    }
    for (const name of sectionNames) {
      this.controlledSections.add(name)
      this.sectionProviders.set(name, provider.name)
    }
    let disposed = false
    let unloading: Promise<void> | undefined
    return () => {
      if (disposed) return Promise.resolve()
      if (unloading !== undefined) return unloading
      this.closingProviders.add(provider.name)
      for (const { lease } of this.activeProviderLeases(provider.name)) {
        this.closingLeases.add(lease.leaseId)
      }
      disposeRegistration()
      const operation = (async () => {
        await this.waitForPendingActivations(provider.name)
        const owned = this.activeProviderLeases(provider.name)
        for (const { lease } of owned) this.closingLeases.add(lease.leaseId)
        const results = await Promise.allSettled(owned.map(({ agent, lease }) => this.expireLease(
          agent,
          lease,
          'provider-unloaded',
          `capability Provider "${provider.name}" was unloaded`,
        )))
        const failures: unknown[] = []
        for (const result of results) {
          if (result.status === 'rejected') failures.push(result.reason as unknown)
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, `capability Provider "${provider.name}" unload failed`)
        for (const name of provider.toolNames) {
          if (this.toolProviders.get(name) !== provider.name) continue
          this.controlledTools.delete(name)
          this.toolProviders.delete(name)
        }
        for (const name of sectionNames) {
          if (this.sectionProviders.get(name) !== provider.name) continue
          this.controlledSections.delete(name)
          this.sectionProviders.delete(name)
        }
        this.closingProviders.delete(provider.name)
        disposed = true
      })()
      const current = operation.finally(() => {
        if (unloading === current) unloading = undefined
      })
      unloading = current
      return current
    }
  }

  /**
   * Resolve policy and activate at most one exact-Agent Lease for this capability.
   * A request waits for preceding transitions before selecting reuse, activation, or denial.
   * @param request - exact Agent authority, capability, reason, and requested scope.
   * @returns a structured grant or denial after any required approval settles.
   */
  async request(request: CapabilityRequest): Promise<CapabilityRequestResult> {
    if (this.productionStore === undefined) return await this.resolveRequestAdmission(request)
    return await this.serializeCapability(
      request.agent,
      request.capability,
      () => this.resolveRequestAdmission(request),
    )
  }

  private async resolveRequestAdmission(
    request: CapabilityRequest,
  ): Promise<CapabilityRequestResult> {
    this.assertLiveWhenRegistryIsPresent(request.agent)
    const definition = this.ports.registry.get(request.capability)
    const resolvedRequest: ResolvedCapabilityRequest = {
      ...request,
      requestedScope: request.requestedScope ?? definition?.defaultScope ?? 'session',
      ...this.productionStore === undefined
        ? {}
        : { durableRequestId: this.productionStore.requestId() },
    }
    if (this.productionStore !== undefined && resolvedRequest.durableRequestId !== undefined) {
      this.productionStore.recordRequested({
        session: resolvedRequest.agent.session,
        requestId: resolvedRequest.durableRequestId,
        capability: resolvedRequest.capability,
        requestedScope: resolvedRequest.requestedScope,
        reason: resolvedRequest.reason,
      })
    }
    await this.record({
      type: 'capability_requested',
      sessionId: this.sessionId(request.agent),
      capability: request.capability,
      leaseScope: resolvedRequest.requestedScope,
      reason: request.reason,
    })

    if (definition === undefined || definition.capability !== request.capability) {
      return await this.denyRequest(
        resolvedRequest,
        'registry-miss',
        'capability is not present in the trusted registry',
      )
    }

    const cancelledAfterRequest = this.denyIfRequestCancelled(resolvedRequest, definition)
    if (cancelledAfterRequest !== undefined) return await cancelledAfterRequest

    if (this.productionStore !== undefined && this.controllerState !== 'running') {
      return await this.denyRequest(
        resolvedRequest,
        'activation-failed',
        'CapabilityController is not accepting new activations',
        definition,
      )
    }

    if (!definition.allowedScopes.includes(resolvedRequest.requestedScope)) {
      return await this.denyRequest(
        resolvedRequest,
        'scope-not-allowed',
        `requested scope "${resolvedRequest.requestedScope}" is not allowed for this capability`,
        definition,
      )
    }

    if (this.runtimeAdapter !== undefined
      && (this.closingProviders.has(definition.provider)
        || this.runtimeAdapter.resolveProvider(definition.provider) === undefined)) {
      return await this.denyRequest(
        resolvedRequest,
        'provider-unavailable',
        `trusted capability provider "${definition.provider}" is not registered`,
        definition,
      )
    }

    const binding = this.resolveBinding(resolvedRequest.agent, resolvedRequest.requestedScope)
    if (binding === undefined) {
      const task = resolvedRequest.requestedScope === 'task'
      return await this.denyRequest(
        resolvedRequest,
        task ? 'task-goal-required' : 'lifecycle-context-missing',
        task
          ? 'task capability requires a current non-terminal Goal'
          : `${resolvedRequest.requestedScope} capability requires an active lifecycle context`,
        definition,
      )
    }
    const boundRequest: ResolvedCapabilityRequest = { ...resolvedRequest, binding }

    if (this.productionStore !== undefined) {
      const owned = this.findOwnedActiveCapability(boundRequest.agent, boundRequest.capability)
      if (owned !== undefined) {
        if (owned.scope !== boundRequest.requestedScope
          || !sameBinding(owned.binding, boundRequest.binding)) {
          return await this.denyRequest(
            boundRequest,
            'lease-scope-conflict',
            'an active Lease for this capability has a different scope or lifecycle binding',
            definition,
          )
        }
        return await this.reuse(boundRequest, owned)
      }
    }

    let decision: CapabilityPolicyDecision
    try {
      decision = await this.ports.policy.evaluate({
        agent: boundRequest.agent,
        definition,
        reason: boundRequest.reason,
        requestedScope: boundRequest.requestedScope,
      })
    } catch (error) {
      const cancelled = this.denyIfRequestCancelled(boundRequest, definition)
      if (cancelled !== undefined) return await cancelled
      return await this.denyRequest(
        boundRequest,
        'policy-denied',
        `capability policy evaluation failed: ${errorMessage(error)}`,
        definition,
      )
    }

    const cancelledAfterPolicy = this.denyIfRequestCancelled(boundRequest, definition)
    if (cancelledAfterPolicy !== undefined) return await cancelledAfterPolicy

    if (decision.kind === 'deny') {
      return await this.denyRequest(boundRequest, 'policy-denied', decision.reason, definition)
    }
    let admittedRequest = boundRequest
    if (decision.kind === 'approval-required') {
      const approval = this.ownerCtx.get('approval')
      if (approval === undefined) {
        return await this.denyRequest(
          boundRequest,
          'approval-unavailable',
          'capability approval channel is unavailable',
          definition,
        )
      }
      let outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
      try {
        const receipt = await approval.requestWithReceipt({
          agent: boundRequest.agent,
          toolName: 'request_capability',
          reason: decision.reason,
          ...boundRequest.callId === undefined ? {} : { callId: boundRequest.callId },
          ...boundRequest.signal === undefined ? {} : { signal: boundRequest.signal },
        })
        outcome = receipt.outcome
        admittedRequest = { ...boundRequest, approvalRequestId: receipt.id }
      } catch {
        outcome = 'unavailable'
      }
      const cancelled = this.denyIfRequestCancelled(admittedRequest, definition)
      if (cancelled !== undefined) return await cancelled
      if (outcome !== 'allowed-once') {
        const code = outcome === 'rejected'
          ? 'approval-rejected'
          : outcome === 'cancelled' ? 'approval-cancelled' : 'approval-unavailable'
        const reason = outcome === 'rejected'
          ? 'capability approval was explicitly rejected by the user'
          : outcome === 'cancelled'
            ? 'capability approval was cancelled by the user'
            : 'capability approval channel is unavailable'
        return await this.denyRequest(admittedRequest, code, reason, definition)
      }
    }

    return await this.resolveRequestTransition(admittedRequest, definition)
  }

  private denyIfRequestCancelled(
    request: ResolvedCapabilityRequest,
    definition: CapabilityDefinition,
  ): Promise<CapabilityRequestResult> | undefined {
    if (request.signal?.aborted !== true) return undefined
    return this.denyRequest(
      request,
      'request-cancelled',
      'capability request was cancelled',
      definition,
    )
  }

  private async resolveRequestTransition(
    boundRequest: ResolvedCapabilityRequest,
    definition: CapabilityDefinition,
  ): Promise<CapabilityRequestResult> {
    const key = requestKey(boundRequest.capability, boundRequest.requestedScope)
    const pendingRelease = this.pendingReleaseByAgent.get(boundRequest.agent)?.get(key)
    if (pendingRelease !== undefined && this.productionStore === undefined) await pendingRelease
    if (this.productionStore !== undefined) {
      const owned = this.findOwnedActiveCapability(boundRequest.agent, boundRequest.capability)
      if (owned !== undefined) {
        if (owned.scope !== boundRequest.requestedScope
          || !sameBinding(owned.binding, boundRequest.binding)) {
          return await this.denyRequest(
            boundRequest,
            'lease-scope-conflict',
            'an active Lease for this capability has a different scope or lifecycle binding',
            definition,
          )
        }
        return await this.reuse(boundRequest, owned)
      }
    }
    const active = this.findOwnedActive(boundRequest.agent, key, boundRequest)
    if (active !== undefined) return await this.reuse(boundRequest, active)

    const pending = this.pendingMap(boundRequest.agent)
    const existing = pending.get(key)
    if (existing !== undefined) {
      const outcome = await existing
      if (outcome.status !== 'granted') return outcome
      const lease = this.ports.leases.get(outcome.leaseId, boundRequest.agent.session)
      if (lease !== undefined
        && lease.status === 'active'
        && this.ownsLease(lease.leaseId, boundRequest.agent)) {
        return await this.reuse(boundRequest, lease)
      }
      return outcome
    }

    // Defer activation by one microtask so the in-flight entry is visible even
    // to a request re-entered synchronously by an adapter.
    const operation = Promise.resolve().then(() => this.activateAndGrant(boundRequest, definition, key))
    pending.set(key, operation)
    try {
      return await operation
    } finally {
      if (pending.get(key) === operation) pending.delete(key)
    }
  }

  /**
   * Revoke only an active lease owned by the exact calling Agent object.
   * Concurrent releases of the same lease share one deactivation and terminal result.
   * @param request - exact Agent authority and lease id to release.
   * @returns the committed release or a structured denial.
   */
  async release(request: CapabilityReleaseRequest): Promise<CapabilityReleaseResult> {
    this.assertLiveWhenRegistryIsPresent(request.agent)
    const lease = this.ports.leases.get(request.leaseId, request.agent.session)
    if (lease === undefined) {
      return {
        status: 'denied',
        leaseId: request.leaseId,
        code: 'lease-not-found',
        reason: 'lease was not found',
      }
    }
    if (lease.status !== 'active') {
      return {
        status: 'denied',
        leaseId: request.leaseId,
        code: 'lease-not-active',
        reason: 'lease is not active',
      }
    }
    if (!this.ownsLease(request.leaseId, request.agent)) {
      return {
        status: 'denied',
        leaseId: request.leaseId,
        code: 'lease-not-owned',
        reason: 'lease belongs to another Session',
      }
    }

    const expiring = this.pendingExpirations.get(request.leaseId)
    if (expiring !== undefined) {
      try {
        await expiring
      } catch {
        // The automatic owner keeps the Lease fail-closed and retries below;
        // an explicit release cannot steal that already-started terminal path.
      }
      return {
        status: 'denied',
        leaseId: request.leaseId,
        code: 'lease-not-active',
        reason: 'lease expired before explicit release could take ownership',
      }
    }
    if (this.expirationRetryIntents.has(request.leaseId)) {
      return {
        status: 'denied',
        leaseId: request.leaseId,
        code: 'lease-not-active',
        reason: 'lease is closing after an automatic expiry and cannot be explicitly released',
      }
    }

    const existing = this.pendingReleases.get(request.leaseId)
    if (existing !== undefined) {
      return await existing
    }

    const key = requestKey(lease.capability, lease.scope)
    this.closingLeases.add(lease.leaseId)
    const transition = () => this.deactivateAndRevoke(request.agent, lease)
    const operation = this.productionStore === undefined
      ? Promise.resolve().then(transition)
      : this.serializeCapability(request.agent, lease.capability, transition)
    const pendingForAgent = this.pendingReleaseMap(request.agent)
    this.pendingReleases.set(request.leaseId, operation)
    pendingForAgent.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.pendingReleases.get(request.leaseId) === operation) {
        this.pendingReleases.delete(request.leaseId)
      }
      if (pendingForAgent.get(key) === operation) pendingForAgent.delete(key)
    }
  }

  private ownsLease(leaseId: string, agent: Agent): boolean {
    const owner = this.leaseOwners.get(leaseId)
    const value = owner?.deref()
    if (owner !== undefined && value === undefined) this.leaseOwners.delete(leaseId)
    return value === agent
  }

  private forEachOwnerInSession(session: Session, visit: (agent: Agent) => void): void {
    const visited = new Set<Agent>()
    for (const [leaseId, ref] of this.leaseOwners) {
      const agent = ref.deref()
      if (agent === undefined) {
        this.leaseOwners.delete(leaseId)
        continue
      }
      if (agent.session !== session || visited.has(agent)) continue
      visited.add(agent)
      visit(agent)
    }
  }

  private activeProviderLeases(provider: string): { readonly agent: Agent; readonly lease: CapabilityLease }[] {
    const owned: { agent: Agent; lease: CapabilityLease }[] = []
    for (const [leaseId, ref] of this.leaseOwners) {
      const agent = ref.deref()
      if (agent === undefined) {
        this.leaseOwners.delete(leaseId)
        continue
      }
      const lease = this.ports.leases.get(leaseId, agent.session)
      if (lease?.status === 'active' && lease.provider === provider && this.ownsLease(leaseId, agent)) {
        owned.push({ agent, lease })
      }
    }
    return owned
  }

  private activeLeaseForTool(agent: Agent, toolName: string): CapabilityLease | undefined {
    if (this.controllerState !== 'running') return undefined
    const active = this.activeByAgent.get(agent)
    if (active === undefined) return undefined
    for (const [key, leaseId] of active) {
      const lease = this.ports.leases.get(leaseId, agent.session)
      if (lease === undefined
        || lease.status !== 'active'
        || !this.ownsLease(leaseId, agent)
        || this.closingLeases.has(leaseId)
        || this.closingProviders.has(lease.provider)
        || (this.runtimeAdapter !== undefined
          && !this.runtimeAdapter.isActive(agent, lease.capability))) {
        active.delete(key)
        continue
      }
      if (lease.toolNames.includes(toolName)) return lease
    }
    return undefined
  }

  private beginExecution(leaseId: string): void {
    this.inFlightByLease.set(leaseId, (this.inFlightByLease.get(leaseId) ?? 0) + 1)
  }

  private endExecution(leaseId: string): void {
    const next = (this.inFlightByLease.get(leaseId) ?? 1) - 1
    if (next > 0) {
      this.inFlightByLease.set(leaseId, next)
      return
    }
    this.inFlightByLease.delete(leaseId)
    const waiter = this.drainWaiters.get(leaseId)
    this.drainWaiters.delete(leaseId)
    waiter?.resolve()
  }

  private waitForDrain(leaseId: string): Promise<void> {
    if ((this.inFlightByLease.get(leaseId) ?? 0) === 0) return Promise.resolve()
    const existing = this.drainWaiters.get(leaseId)
    if (existing !== undefined) return existing.promise
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    this.drainWaiters.set(leaseId, { promise, resolve })
    return promise
  }

  private recordProviderUse(
    agent: Agent,
    lease: CapabilityLease,
    callId: string,
    toolName: string,
    outcome: 'succeeded' | 'failed',
    aborted: boolean,
  ): void {
    if (this.productionStore === undefined) return
    this.productionStore.recordUsed({
      session: agent.session,
      leaseId: CapabilityLeaseId(lease.leaseId),
      callId,
      toolName,
      outcome,
    })
    const touched = this.ports.leases.get(lease.leaseId, agent.session)
    if (touched === undefined || touched.status !== 'active') return
    if (outcome === 'succeeded' && !aborted && touched.expireAfterSuccessfulUse === true) {
      void this.expireLease(agent, touched, 'revoke-after-success',
        `controlled tool "${toolName}" completed successfully`).catch((error: unknown) => {
        this.ownerCtx.logger.warn(`capability successful-use expiry failed: ${errorMessage(error)}`)
      })
      return
    }
    if (!this.closingLeases.has(touched.leaseId)) this.armIdleTimer(agent, touched)
  }

  private armIdleTimer(agent: Agent, lease: CapabilityLease): void {
    const existing = this.leaseTimers.get(lease.leaseId)
    if (existing !== undefined) clearTimeout(existing)
    this.leaseTimers.delete(lease.leaseId)
    if (lease.idleTtlSec === undefined || lease.status !== 'active') return
    const owner = new WeakRef(agent)
    const dueAt = Date.parse(lease.lastUsedAt) + lease.idleTtlSec * 1000
    const delay = Math.max(0, dueAt - Date.now())
    const timer = setTimeout(() => {
      if (this.leaseTimers.get(lease.leaseId) !== timer) return
      this.leaseTimers.delete(lease.leaseId)
      const currentAgent = owner.deref()
      if (currentAgent === undefined || !this.ownsLease(lease.leaseId, currentAgent)) return
      const current = this.ports.leases.get(lease.leaseId, currentAgent.session)
      if (current === undefined || current.status !== 'active') return
      const currentDueAt = Date.parse(current.lastUsedAt) + (current.idleTtlSec ?? 0) * 1000
      if (currentDueAt > Date.now()) {
        this.armIdleTimer(currentAgent, current)
        return
      }
      void this.expireLease(currentAgent, current, 'idle-ttl',
        `capability was idle for ${current.idleTtlSec ?? lease.idleTtlSec} seconds`).catch((error: unknown) => {
        this.ownerCtx.logger.warn(`capability idle expiry failed: ${errorMessage(error)}`)
      })
    }, delay)
    this.leaseTimers.set(lease.leaseId, timer)
  }

  private async expireMatching(
    agent: Agent,
    predicate: (lease: CapabilityLease) => boolean,
    cause: CapabilityExpirationCause,
    reason: string,
  ): Promise<void> {
    const active = this.activeByAgent.get(agent)
    if (active === undefined) return
    const leases = [...new Set(active.values())].flatMap((leaseId) => {
      const lease = this.ports.leases.get(leaseId, agent.session)
      return lease !== undefined && lease.status === 'active'
        && this.ownsLease(leaseId, agent) && predicate(lease) ? [lease] : []
    })
    await Promise.all(leases.map(lease => this.expireLease(agent, lease, cause, reason)))
  }

  /**
   * Durable active facts never restore process-local authority implicitly.
   * A resumed Agent must request again so policy and Provider activation run in
   * this process; startup therefore closes every active log Lease lacking its
   * exact owned Fiber.
   */
  private reconcileProcessLocalAuthority(agent: Agent): void {
    if (this.productionStore === undefined) return
    this.productionStore.bind(agent.session)
    for (const lease of this.productionStore.list(agent.session)) {
      if (lease.status !== 'active') continue
      if (this.ownsLease(lease.leaseId, agent)
        && this.runtimeAdapter?.isActive(agent, lease.capability) === true) continue
      const granted = agent.session.events.find(event => event.type === 'capability/change'
        && event.data.kind === 'granted' && event.data.leaseId === lease.leaseId)
      const seeded = granted !== undefined && granted.seq < agent.session.firstLiveSeq
      this.productionStore.expire(
        lease.leaseId,
        agent.session,
        seeded ? 'process-restarted' : 'activation-lost',
        seeded
          ? 'durable Lease was active when this process resumed'
          : 'durable Lease has no exact process-local Provider activation',
      )
      this.retireLease(agent, lease)
    }
  }

  /** Validate the complete Loader Registry only after Host Provider injectors had a chance to register. */
  private ensureConfiguredProviders(agent: Agent): void {
    if (this.runtimeAdapter === undefined
      || this.configuredProviderNames === undefined
      || this.providerValidatedAgents.has(agent)) return
    const missing = [...this.configuredProviderNames]
      .filter(provider => this.runtimeAdapter?.resolveProvider(provider) === undefined)
      .sort()
    if (missing.length > 0) {
      throw new Error(`configured capability Providers are not registered: ${missing.map(value => JSON.stringify(value)).join(', ')}`)
    }
    this.providerValidatedAgents.add(agent)
  }

  /** Close process-local authority whose complete Registry row no longer matches its grant generation. */
  private async reconcileRegistryAuthority(agent: Agent): Promise<void> {
    if (this.productionStore === undefined) return
    const active = this.activeByAgent.get(agent)
    if (active === undefined) return
    const leases = [...new Set(active.values())].flatMap((leaseId) => {
      const lease = this.ports.leases.get(leaseId, agent.session)
      return lease !== undefined && lease.status === 'active' && this.ownsLease(leaseId, agent)
        ? [lease]
        : []
    })
    await Promise.all(leases.map(async (lease) => {
      const grantedFingerprint = this.definitionFingerprints.get(lease.leaseId)
      if (grantedFingerprint === undefined) return
      const definition = this.ports.registry.get(lease.capability)
      if (definition === undefined) {
        await this.expireLease(
          agent,
          lease,
          'registry-miss',
          `capability "${lease.capability}" is no longer present in the trusted Registry`,
        )
        return
      }
      if (capabilityDefinitionFingerprint(definition) !== grantedFingerprint) {
        await this.expireLease(
          agent,
          lease,
          'definition-changed',
          `trusted Registry definition for capability "${lease.capability}" changed`,
        )
      }
    }))
  }

  private async expireLease(
    agent: Agent,
    lease: CapabilityLease,
    cause: CapabilityExpirationCause,
    reason: string,
  ): Promise<void> {
    if (this.productionStore === undefined) return
    const releasing = this.pendingReleases.get(lease.leaseId)
    if (releasing !== undefined) {
      const result = await releasing
      if (result.status === 'released') return
    }
    const existing = this.pendingExpirations.get(lease.leaseId)
    if (existing !== undefined) {
      await existing
      return
    }
    const current = this.ports.leases.get(lease.leaseId, agent.session)
    if (current === undefined || current.status !== 'active' || !this.ownsLease(lease.leaseId, agent)) {
      this.clearExpirationRetry(lease.leaseId)
      return
    }
    const retainedIntent = this.expirationRetryIntents.get(lease.leaseId)
    const intent = retainedIntent ?? {
      owner: new WeakRef(agent),
      cause,
      reason,
    }
    this.expirationRetryIntents.set(lease.leaseId, intent)
    this.closingLeases.add(lease.leaseId)
    const transition = () => this.completeExpirationTransition(agent, lease, intent)
    const operation = this.serializeCapability(agent, lease.capability, transition)
    this.pendingExpirations.set(lease.leaseId, operation)
    try {
      await operation
    } catch (error: unknown) {
      this.scheduleExpirationRetry(lease.leaseId)
      throw error
    } finally {
      if (this.pendingExpirations.get(lease.leaseId) === operation) {
        this.pendingExpirations.delete(lease.leaseId)
      }
    }
  }

  private async completeExpirationTransition(
    agent: Agent,
    lease: CapabilityLease,
    intent: ExpirationRetryIntent,
  ): Promise<void> {
    await this.waitForDrain(lease.leaseId)
    if (!this.deactivatedLeases.has(lease.leaseId)) {
      await this.ports.adapter.deactivate({ agent, lease })
      this.deactivatedLeases.add(lease.leaseId)
    }
    this.productionStore?.expire(lease.leaseId, agent.session, intent.cause, intent.reason)
    this.retireLease(agent, lease)
  }

  private scheduleExpirationRetry(leaseId: string): void {
    if (this.expirationRetryTimers.has(leaseId)) return
    const timer = setTimeout(() => {
      if (this.expirationRetryTimers.get(leaseId) !== timer) return
      this.expirationRetryTimers.delete(leaseId)
      const intent = this.expirationRetryIntents.get(leaseId)
      const agent = intent?.owner.deref()
      if (intent === undefined || agent === undefined) {
        this.clearExpirationRetry(leaseId)
        return
      }
      const lease = this.ports.leases.get(leaseId, agent.session)
      if (lease === undefined || lease.status !== 'active' || !this.ownsLease(leaseId, agent)) {
        this.clearExpirationRetry(leaseId)
        return
      }
      void this.expireLease(agent, lease, intent.cause, intent.reason).catch((error: unknown) => {
        this.ownerCtx.logger.warn(`capability automatic expiry retry failed: ${errorMessage(error)}`)
      })
    }, EXPIRATION_RETRY_DELAY_MS)
    this.expirationRetryTimers.set(leaseId, timer)
  }

  private clearExpirationRetry(leaseId: string): void {
    const timer = this.expirationRetryTimers.get(leaseId)
    if (timer !== undefined) clearTimeout(timer)
    this.expirationRetryTimers.delete(leaseId)
    this.expirationRetryIntents.delete(leaseId)
  }

  private async disposeProductionAuthority(): Promise<void> {
    if (this.productionStore === undefined) return
    if (this.controllerState === 'disposed') return
    this.controllerState = 'disposing'
    const owners = new Set<Agent>()
    const collectOwners = () => {
      for (const [leaseId, ref] of this.leaseOwners) {
        const agent = ref.deref()
        if (agent === undefined) {
          this.leaseOwners.delete(leaseId)
          continue
        }
        const lease = this.ports.leases.get(leaseId, agent.session)
        if (lease?.status === 'active') this.closingLeases.add(leaseId)
        owners.add(agent)
      }
    }
    collectOwners()
    await this.waitForPendingActivations()
    collectOwners()
    await Promise.all([...owners].map(agent => this.expireMatching(
      agent,
      () => true,
      'controller-unloaded',
      'CapabilityController was unloaded',
    )))
    for (const timer of this.leaseTimers.values()) clearTimeout(timer)
    this.leaseTimers.clear()
    this.controllerState = 'disposed'
  }

  private retireLease(agent: Agent, lease: CapabilityLease): void {
    const timer = this.leaseTimers.get(lease.leaseId)
    if (timer !== undefined) clearTimeout(timer)
    this.leaseTimers.delete(lease.leaseId)
    const active = this.activeByAgent.get(agent)
    if (active !== undefined) {
      for (const [key, leaseId] of active) {
        if (leaseId === lease.leaseId) active.delete(key)
      }
    }
    this.leaseOwners.delete(lease.leaseId)
    this.clearExpirationRetry(lease.leaseId)
    this.definitionFingerprints.delete(lease.leaseId)
    this.closingLeases.delete(lease.leaseId)
    this.deactivatedLeases.delete(lease.leaseId)
  }

  /**
   * Enforce the last synchronous authority check immediately before dispatch.
   * A Provider tool is callable only after the exact Agent's current prompt
   * assembly exposed it and while its committed Lease/Fiber remain active.
   */
  private productionGuard(exec: ToolExecution): string | undefined {
    if (exec.name.startsWith('cordis_')
      && this.ownerCtx.tools.get(exec.name, exec.agent) !== undefined) {
      return `dynamic Cordis control tool "${exec.name}" is not available in a controlled Agent`
    }
    if (!this.controlledTools.has(exec.name)) return undefined
    if (exec.agent === undefined) {
      return `controlled tool "${exec.name}" requires an exact Agent owner`
    }
    if (!this.ownerCtx.tools[TOOL_RUNTIME_SCHEDULER].isPreparedExecution(exec)) {
      return `controlled tool "${exec.name}" cannot be invoked through direct ToolRuntime execution`
    }
    const agents = this.ownerCtx.get('agents')
    if (agents === undefined || agents.currentInitiator() !== exec.agent) {
      return `controlled tool "${exec.name}" was not dispatched by the exact AgentLoop owner`
    }
    try {
      this.assertLiveWhenRegistryIsPresent(exec.agent)
    } catch {
      return `controlled tool "${exec.name}" does not belong to the exact live Agent`
    }
    const lease = this.activeLeaseForTool(exec.agent, exec.name)
    if (lease === undefined) {
      const capability = this.staleCapabilityForTool(exec.agent, exec.name)
      if (capability !== undefined) {
        return `controlled tool "${exec.name}" has no active committed Lease for capability "${capability}"; call request_capability for "${capability}" before retrying this tool`
      }
      return `controlled tool "${exec.name}" has no active committed Lease`
    }
    if (!this.presentedTools.get(exec.agent)?.has(exec.name)) {
      return `controlled tool "${exec.name}" was not presented in the current schema generation`
    }
    const coordinates = this.durableExecutionCoordinates(exec)
    if (coordinates === undefined) {
      return `controlled tool "${exec.name}" was not admitted by the current AgentLoop step`
    }
    const generation = this.stepAdmissions.get(exec.agent)
      ?.get(stepAdmissionKey(coordinates.turn, coordinates.step))
    if (generation === undefined) {
      return `controlled tool "${exec.name}" has no live schema generation for its AgentLoop step`
    }
    if (generation.get(exec.name) !== lease.leaseId) {
      return `controlled tool "${exec.name}" belongs to an obsolete schema generation`
    }
    return undefined
  }

  /** Infer the last exact-session capability that contributed one now-stale Provider tool. */
  private staleCapabilityForTool(agent: Agent, toolName: string): string | undefined {
    const provider = this.toolProviders.get(toolName)
    if (provider === undefined) return undefined
    return this.ports.leases.list(agent.session).findLast(lease => lease.provider === provider
      && lease.sessionId === String(agent.id)
      && lease.toolNames.includes(toolName))?.capability
  }

  private durableExecutionCoordinates(exec: ToolExecution): DurableExecutionCoordinates | undefined {
    const events = exec.agent?.session.events
    if (events === undefined) return undefined
    if (exec.parent !== undefined) {
      const startedAt = events.findLastIndex(event => event.type === 'tool/code-dispatch-start'
        && event.data.subCallId === exec.callId && event.data.name === exec.name
        && sameJson(event.data.arguments, exec.arguments))
      if (startedAt < 0 || events.slice(startedAt + 1).some(event => event.type === 'tool/code-dispatch'
        && event.data.subCallId === exec.callId)) return undefined
      const started = events[startedAt]
      if (started?.type !== 'tool/code-dispatch-start') return undefined
      const root = events.findLast(event => event.type === 'tool/call'
        && event.data.callId === started.data.rootCallId)
      return root?.type === 'tool/call'
        ? { turn: root.data.turn, step: root.data.step }
        : undefined
    }
    const calledAt = events.findLastIndex((event) => {
      if (event.type !== 'tool/call'
        || event.data.callId !== exec.callId
        || event.data.name !== exec.name) return false
      try {
        return sameJson(event.data.arguments ? JSON.parse(event.data.arguments) : {}, exec.arguments)
      } catch {
        return event.data.arguments === exec.arguments
      }
    })
    if (calledAt < 0 || events.slice(calledAt + 1).some(event => event.type === 'tool/result'
      && event.data.message.content.some(block => block.toolCallId === exec.callId))) return undefined
    const called = events[calledAt]
    return called?.type === 'tool/call'
      ? { turn: called.data.turn, step: called.data.step }
      : undefined
  }

  private assertNoRawCordisTools(): void {
    const installed = this.ownerCtx.tools.schemas().find(tool => tool.name.startsWith('cordis_'))
    if (installed !== undefined) {
      throw new Error(`raw Cordis control Tool "${installed.name}" cannot be installed with CapabilityController`)
    }
  }

  /** Resolve the exact active Lease generation behind every currently authorized Provider Tool. */
  private activeLeaseIdsByTool(agent: Agent): Map<string, string> {
    const allowed = new Map<string, string>()
    if (this.controllerState !== 'running') return allowed
    const active = this.activeByAgent.get(agent)
    if (active === undefined) return allowed
    for (const [key, leaseId] of active) {
      const lease = this.ports.leases.get(leaseId, agent.session)
      if (lease === undefined
        || lease.status !== 'active'
        || !this.ownsLease(leaseId, agent)
        || this.closingLeases.has(leaseId)
        || this.closingProviders.has(lease.provider)
        || (this.runtimeAdapter !== undefined
          && !this.runtimeAdapter.isActive(agent, lease.capability))) {
        active.delete(key)
        continue
      }
      for (const name of lease.toolNames) allowed.set(name, lease.leaseId)
    }
    return allowed
  }

  private stepAdmissionMap(agent: Agent): Map<string, ReadonlyMap<string, string>> {
    let admissions = this.stepAdmissions.get(agent)
    if (admissions === undefined) {
      admissions = new Map()
      this.stepAdmissions.set(agent, admissions)
    }
    return admissions
  }

  /** Filter Provider guidance with the same committed-Lease authority as its tools. */
  private sectionIsAllowed(sectionName: string, agent: Agent | undefined): boolean {
    if (agent === undefined || this.controllerState !== 'running') return false
    const provider = this.sectionProviders.get(sectionName)
    if (provider === undefined) return false
    const active = this.activeByAgent.get(agent)
    if (active === undefined) return false
    for (const leaseId of active.values()) {
      const lease = this.ports.leases.get(leaseId, agent.session)
      if (lease !== undefined
        && lease.status === 'active'
        && lease.provider === provider
        && this.ownsLease(leaseId, agent)
        && !this.closingLeases.has(leaseId)
        && !this.closingProviders.has(lease.provider)
        && (this.runtimeAdapter === undefined
          || this.runtimeAdapter.isActive(agent, lease.capability))) return true
    }
    return false
  }

  private now(): string {
    return this.ports.now?.() ?? new Date().toISOString()
  }

  private sessionId(agent: Agent): string {
    return String(agent.id)
  }

  private resolveBinding(agent: Agent, scope: CapabilityLeaseScope): CapabilityLeaseBinding | undefined {
    if (scope === 'session') return { kind: 'session' }
    if (scope === 'persistent') return { kind: 'persistent' }
    if (scope === 'turn') {
      const events = agent.session.events
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type === 'turn/end') return undefined
        if (event?.type === 'turn/start') return { kind: 'turn', turn: event.data.turn }
      }
      return undefined
    }
    const goals = this.ownerCtx.get('goals')
    const goal = goals?.get(agent)
    if (goal === undefined || goal.phase === 'complete' || goal.phase === 'blocked') return undefined
    return { kind: 'task', goalId: goal.id }
  }

  private assertLiveWhenRegistryIsPresent(agent: Agent): void {
    const agents = this.ownerCtx.get('agents')
    if (agents !== undefined && agents.get(agent.id) !== agent) {
      throw new Error(`agent "${agent.id}" is not the exact live registry entry`)
    }
  }

  private beginPendingActivation(provider: string): () => void {
    if (this.productionStore === undefined) return () => undefined
    let pending = this.pendingActivations.get(provider)
    if (pending === undefined) {
      pending = new Set()
      this.pendingActivations.set(provider, pending)
    }
    let resolve!: () => void
    const completion = new Promise<void>((done) => { resolve = done })
    pending.add(completion)
    let finished = false
    return () => {
      if (finished) return
      finished = true
      pending.delete(completion)
      if (pending.size === 0) this.pendingActivations.delete(provider)
      resolve()
    }
  }

  private async waitForPendingActivations(provider?: string): Promise<void> {
    while (true) {
      const pending = provider === undefined
        ? [...this.pendingActivations.values()].flatMap(entries => [...entries])
        : [...(this.pendingActivations.get(provider) ?? [])]
      if (pending.length === 0) return
      await Promise.all(pending)
    }
  }

  private async serializeCapability<T>(
    agent: Agent,
    capability: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    let tails = this.transitionTails.get(agent)
    if (tails === undefined) {
      tails = new Map()
      this.transitionTails.set(agent, tails)
    }
    const previous = tails.get(capability)
    let unlock!: () => void
    const current = new Promise<void>((resolve) => { unlock = resolve })
    tails.set(capability, current)
    if (previous !== undefined) await previous
    try {
      return await operation()
    } finally {
      unlock()
      if (tails.get(capability) === current) tails.delete(capability)
    }
  }

  private pendingMap(agent: Agent): Map<string, Promise<CapabilityRequestResult>> {
    let map = this.pendingByAgent.get(agent)
    if (map === undefined) {
      map = new Map()
      this.pendingByAgent.set(agent, map)
    }
    return map
  }

  private pendingReleaseMap(agent: Agent): Map<string, Promise<CapabilityReleaseResult>> {
    let map = this.pendingReleaseByAgent.get(agent)
    if (map === undefined) {
      map = new Map()
      this.pendingReleaseByAgent.set(agent, map)
    }
    return map
  }

  private activeMap(agent: Agent): Map<string, string> {
    let map = this.activeByAgent.get(agent)
    if (map === undefined) {
      map = new Map()
      this.activeByAgent.set(agent, map)
    }
    return map
  }

  private findOwnedActive(
    agent: Agent,
    key: string,
    request: ResolvedCapabilityRequest,
  ): CapabilityLease | undefined {
    this.productionStore?.bind(agent.session)
    const active = this.activeMap(agent)
    const leaseId = active.get(key)
    if (leaseId !== undefined) {
      const lease = this.ports.leases.get(leaseId, agent.session)
      if (lease !== undefined
        && lease.status === 'active'
        && this.ownsLease(leaseId, agent)
        && !this.closingLeases.has(leaseId)
        && !this.closingProviders.has(lease.provider)) return lease
      active.delete(key)
    }

    const lease = this.ports.leases.findActive({
      sessionId: this.sessionId(agent),
      capability: request.capability,
      scope: request.requestedScope,
    })
    if (lease === undefined
      || !this.ownsLease(lease.leaseId, agent)
      || this.closingLeases.has(lease.leaseId)
      || this.closingProviders.has(lease.provider)) return undefined
    active.set(key, lease.leaseId)
    return lease
  }

  private findOwnedActiveCapability(agent: Agent, capability: string): CapabilityLease | undefined {
    const active = this.activeByAgent.get(agent)
    if (active === undefined) return undefined
    for (const [key, leaseId] of active) {
      const lease = this.ports.leases.get(leaseId, agent.session)
      if (lease === undefined || lease.status !== 'active' || !this.ownsLease(leaseId, agent)) {
        active.delete(key)
        continue
      }
      if (this.closingLeases.has(leaseId) || this.closingProviders.has(lease.provider)) continue
      if (lease.capability === capability) return lease
    }
    return undefined
  }

  private async reuse(
    request: ResolvedCapabilityRequest,
    lease: CapabilityLease,
  ): Promise<CapabilityRequestResult> {
    const touched = this.ports.leases.touch(lease.leaseId, this.now(), request.agent.session)
    if (this.productionStore !== undefined && request.durableRequestId !== undefined) {
      this.productionStore.recordReused(
        request.agent.session,
        request.durableRequestId,
        CapabilityLeaseId(lease.leaseId),
      )
    }
    await this.record({
      type: 'capability_reused',
      sessionId: touched.sessionId,
      capability: touched.capability,
      risk: touched.risk,
      leaseScope: touched.scope,
      leaseId: touched.leaseId,
      reason: request.reason,
    })
    return {
      status: 'granted',
      leaseId: touched.leaseId,
      capability: touched.capability,
      scope: touched.scope,
      reused: true,
    }
  }

  private async activateAndGrant(
    request: ResolvedCapabilityRequest,
    definition: CapabilityDefinition,
    key: string,
  ): Promise<CapabilityRequestResult> {
    const expectedProvider = this.runtimeAdapter?.resolveProvider(definition.provider)
    const admissionFailure = this.activationAdmissionFailure(request, definition, expectedProvider)
    if (admissionFailure !== undefined) {
      return await this.denyRequest(
        request,
        admissionFailure.code,
        admissionFailure.reason,
        definition,
      )
    }

    const completeActivation = this.beginPendingActivation(definition.provider)
    try {
      return await this.activateAndGrantTracked(request, definition, key, expectedProvider)
    } finally {
      completeActivation()
    }
  }

  private async activateAndGrantTracked(
    request: ResolvedCapabilityRequest,
    definition: CapabilityDefinition,
    key: string,
    expectedProvider: AgentScopedCapabilityProvider | undefined,
  ): Promise<CapabilityRequestResult> {
    const definitionFingerprint = capabilityDefinitionFingerprint(definition)
    let activation: CapabilityActivation
    try {
      activation = await this.ports.adapter.activate({
        agent: request.agent,
        definition,
        scope: request.requestedScope,
      })
    } catch (error) {
      const admissionFailure = this.activationAdmissionFailure(request, definition, expectedProvider)
      if (admissionFailure !== undefined) {
        return await this.denyRequest(
          request,
          admissionFailure.code,
          admissionFailure.reason,
          definition,
        )
      }
      const reason = `capability activation failed: ${errorMessage(error)}`
      const denied = await this.denyRequest(request, 'activation-failed', reason, definition)
      await this.record({
        type: 'capability_activation_failed',
        sessionId: this.sessionId(request.agent),
        capability: request.capability,
        risk: definition.risk,
        leaseScope: request.requestedScope,
        reason,
      })
      return denied
    }

    let admissionFailure = this.activationAdmissionFailure(request, definition, expectedProvider)
    try {
      this.assertLiveWhenRegistryIsPresent(request.agent)
    } catch (error: unknown) {
      admissionFailure = {
        code: 'activation-failed',
        reason: `capability activation lost its exact Agent owner: ${errorMessage(error)}`,
      }
    }
    if (admissionFailure !== undefined) {
      await this.rollbackUncommittedActivation(request, definition, activation)
      return await this.denyRequest(
        request,
        admissionFailure.code,
        admissionFailure.reason,
        definition,
      )
    }

    const now = this.now()
    let lease: CapabilityLease | undefined
    try {
      lease = this.ports.leases.create({
        sessionId: this.sessionId(request.agent),
        session: request.agent.session,
        ...request.durableRequestId === undefined ? {} : { requestId: request.durableRequestId },
        binding: request.binding as CapabilityLeaseBinding,
        ...request.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: request.approvalRequestId },
        capability: request.capability,
        provider: definition.provider,
        risk: definition.risk,
        scope: request.requestedScope,
        reason: request.reason,
        toolNames: activation.toolNames,
        now,
        ...definition.idleTtlSec === undefined ? {} : { idleTtlSec: definition.idleTtlSec },
        ...definition.expireAfterSuccessfulUse === undefined
          ? {}
          : { expireAfterSuccessfulUse: definition.expireAfterSuccessfulUse },
      })
      this.leaseOwners.set(lease.leaseId, new WeakRef(request.agent))
      this.definitionFingerprints.set(lease.leaseId, definitionFingerprint)
      this.activeMap(request.agent).set(key, lease.leaseId)
      this.armIdleTimer(request.agent, lease)

      await this.record({
        type: 'capability_granted',
        sessionId: lease.sessionId,
        capability: lease.capability,
        risk: lease.risk,
        leaseScope: lease.scope,
        leaseId: lease.leaseId,
        reason: request.reason,
      })
      return {
        status: 'granted',
        leaseId: lease.leaseId,
        capability: lease.capability,
        scope: lease.scope,
        reused: false,
      }
    } catch (error: unknown) {
      return await this.rollbackActivation(request, definition, activation, lease, key, now, error)
    }
  }

  private activationAdmissionFailure(
    request: ResolvedCapabilityRequest,
    definition: CapabilityDefinition,
    expectedProvider: AgentScopedCapabilityProvider | undefined,
  ): {
    readonly code: 'request-cancelled' | 'provider-unavailable' | 'activation-failed'
    readonly reason: string
  } | undefined {
    if (request.signal?.aborted === true) {
      return { code: 'request-cancelled', reason: 'capability request was cancelled' }
    }
    if (this.productionStore === undefined) return undefined
    if (this.controllerState !== 'running') {
      return {
        code: 'activation-failed',
        reason: 'CapabilityController stopped while the capability was activating',
      }
    }
    const currentProvider = this.runtimeAdapter?.resolveProvider(definition.provider)
    if (expectedProvider === undefined
      || currentProvider !== expectedProvider
      || this.closingProviders.has(definition.provider)) {
      return {
        code: 'provider-unavailable',
        reason: `trusted capability provider "${definition.provider}" became unavailable during activation`,
      }
    }
    return undefined
  }

  private async rollbackUncommittedActivation(
    request: ResolvedCapabilityRequest,
    definition: CapabilityDefinition,
    activation: CapabilityActivation,
  ): Promise<void> {
    const now = this.now()
    await this.ports.adapter.deactivate({
      agent: request.agent,
      lease: {
        leaseId: `rollback:${request.capability}`,
        sessionId: this.sessionId(request.agent),
        capability: request.capability,
        provider: definition.provider,
        risk: definition.risk,
        scope: request.requestedScope,
        binding: request.binding as CapabilityLeaseBinding,
        reason: request.reason,
        status: 'active',
        toolNames: [...activation.toolNames],
        grantedAt: now,
        lastUsedAt: now,
      },
    })
  }

  private async rollbackActivation(
    request: ResolvedCapabilityRequest,
    definition: CapabilityDefinition,
    activation: CapabilityActivation,
    lease: CapabilityLease | undefined,
    key: string,
    now: string,
    cause: unknown,
  ): Promise<never> {
    const rollbackLease: CapabilityLease = lease ?? {
      leaseId: `rollback:${request.capability}`,
      sessionId: this.sessionId(request.agent),
      capability: request.capability,
      provider: definition.provider,
      risk: definition.risk,
      scope: request.requestedScope,
      binding: request.binding as CapabilityLeaseBinding,
      reason: request.reason,
      status: 'active',
      toolNames: [...activation.toolNames],
      grantedAt: now,
      lastUsedAt: now,
    }
    const failures: unknown[] = [cause]
    if (lease !== undefined && this.productionStore !== undefined) {
      const intent: ExpirationRetryIntent = {
        owner: new WeakRef(request.agent),
        cause: 'activation-lost',
        reason: `post-commit capability activation bookkeeping failed: ${errorMessage(cause)}`,
      }
      this.expirationRetryIntents.set(lease.leaseId, intent)
      this.closingLeases.add(lease.leaseId)
      try {
        // The request already owns this capability's FIFO transition. Running
        // the terminal body directly avoids enqueueing behind ourselves while
        // preserving the same drain -> deactivate -> durable-expire order.
        await this.completeExpirationTransition(request.agent, lease, intent)
      } catch (error: unknown) {
        this.scheduleExpirationRetry(lease.leaseId)
        failures.push(error)
      }
    } else {
      try {
        await this.ports.adapter.deactivate({ agent: request.agent, lease: rollbackLease })
      } catch (error: unknown) {
        failures.push(error)
      }

      if (lease !== undefined) {
        const active = this.activeByAgent.get(request.agent)
        if (active?.get(key) === lease.leaseId) active.delete(key)
        this.leaseOwners.delete(lease.leaseId)
        this.definitionFingerprints.delete(lease.leaseId)
        try {
          if (this.ports.leases.get(lease.leaseId, request.agent.session)?.status === 'active') {
            this.ports.leases.revoke(lease.leaseId, this.now(), request.agent.session)
          }
        } catch (error: unknown) {
          failures.push(error)
        }
      }
    }

    if (failures.length === 1) throw cause
    throw new AggregateError(failures, 'capability grant failed and rollback was incomplete')
  }

  private async deactivateAndRevoke(
    agent: Agent,
    lease: CapabilityLease,
  ): Promise<CapabilityReleaseResult> {
    try {
      await this.waitForDrain(lease.leaseId)
      if (!this.deactivatedLeases.has(lease.leaseId)) {
        await this.ports.adapter.deactivate({ agent, lease })
        this.deactivatedLeases.add(lease.leaseId)
      }
    } catch (error) {
      return {
        status: 'denied',
        leaseId: lease.leaseId,
        code: 'deactivation-failed',
        reason: `capability deactivation failed: ${errorMessage(error)}`,
      }
    }

    const revoked = this.ports.leases.revoke(lease.leaseId, this.now(), agent.session)
    this.retireLease(agent, revoked)

    await this.record({
      type: 'capability_released',
      sessionId: revoked.sessionId,
      capability: revoked.capability,
      risk: revoked.risk,
      leaseScope: revoked.scope,
      leaseId: revoked.leaseId,
      reason: revoked.reason,
    })
    return { status: 'released', leaseId: revoked.leaseId, capability: revoked.capability }
  }

  private async denyRequest(
    request: ResolvedCapabilityRequest,
    code: Extract<CapabilityRequestResult, { status: 'denied' }>['code'],
    reason: string,
    definition?: CapabilityDefinition,
  ): Promise<CapabilityRequestResult> {
    if (this.productionStore !== undefined && request.durableRequestId !== undefined) {
      this.productionStore.recordDenied(
        request.agent.session,
        request.durableRequestId,
        code,
        reason,
        request.approvalRequestId,
      )
    }
    await this.record({
      type: 'capability_denied',
      sessionId: this.sessionId(request.agent),
      capability: request.capability,
      ...definition === undefined ? {} : { risk: definition.risk },
      leaseScope: request.requestedScope,
      reason,
    })
    return { status: 'denied', capability: request.capability, code, reason }
  }

  private async record(event: Omit<CapabilityTelemetryEvent, 'timestamp'>): Promise<void> {
    try {
      await this.ports.telemetry.record({ ...event, timestamp: this.now() })
    } catch (error: unknown) {
      this.ownerCtx.logger.warn(`capability telemetry observation failed: ${errorMessage(error)}`)
    }
  }
}

function requestKey(capability: string, scope: CapabilityLeaseScope): string {
  return JSON.stringify([capability, scope])
}

function stepAdmissionKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function sameStringMap(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false
  }
  return true
}

function overwriteAssembly(target: PromptAssembly, source: PromptAssembly): void {
  target.sections = source.sections
  target.contexts = source.contexts
  target.tools = source.tools
  target.variables = source.variables
}

function capabilityDefinitionFingerprint(definition: CapabilityDefinition): string {
  return JSON.stringify({
    capability: definition.capability,
    provider: definition.provider,
    risk: definition.risk,
    approvalRequired: definition.approvalRequired,
    defaultScope: definition.defaultScope,
    allowedScopes: [...definition.allowedScopes].sort(),
    idleTtlSec: definition.idleTtlSec ?? null,
    expireAfterSuccessfulUse: definition.expireAfterSuccessfulUse ?? false,
  })
}

function sameBinding(
  left: CapabilityLeaseBinding,
  right: CapabilityLeaseBinding | undefined,
): boolean {
  if (right === undefined || left.kind !== right.kind) return false
  if (left.kind === 'turn' && right.kind === 'turn') return left.turn === right.turn
  if (left.kind === 'task' && right.kind === 'task') return left.goalId === right.goalId
  return left.kind === 'session' || left.kind === 'persistent'
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default CapabilityController

export * from './agent-scoped-adapter.ts'
