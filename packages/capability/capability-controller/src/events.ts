/** Durable Capability Controller request and lease event vocabulary. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { CapabilityLeaseScope, CapabilityRisk } from './index.ts'

/** Version of the durable `capability/change` payload vocabulary. */
export const CAPABILITY_CHANGE_VERSION = 1 as const

/** Opaque identity of one capability request. */
export type CapabilityRequestId = Branded<'CapabilityRequestId'>

/**
 * Brand a string as a capability request id.
 * @param id - opaque request identity minted by the Controller.
 * @returns the same string with its same-process request-id brand.
 */
export function CapabilityRequestId(id: string): CapabilityRequestId {
  return id as CapabilityRequestId
}

/** Opaque identity of one granted capability lease. */
export type CapabilityLeaseId = Branded<'CapabilityLeaseId'>

/**
 * Brand a string as a capability lease id.
 * @param id - opaque lease identity minted by the Controller.
 * @returns the same string with its same-process lease-id brand.
 */
export function CapabilityLeaseId(id: string): CapabilityLeaseId {
  return id as CapabilityLeaseId
}

/** Durable lifetime owner captured when a lease is granted. */
export type CapabilityLeaseBinding =
  | { readonly kind: 'turn'; readonly turn: number }
  | { readonly kind: 'task'; readonly goalId: string }
  | { readonly kind: 'session' }
  | { readonly kind: 'persistent' }

/** Closed denial reasons used by deterministic V1 request resolution. */
export type CapabilityDenialCode =
  | 'registry-miss'
  | 'policy-denied'
  | 'scope-not-allowed'
  | 'task-goal-required'
  | 'lease-scope-conflict'
  | 'approval-rejected'
  | 'approval-cancelled'
  | 'approval-unavailable'
  | 'activation-failed'
  | 'provider-unavailable'
  | 'request-cancelled'
  | 'lifecycle-context-missing'

/** Closed automatic-expiration causes used by V1 lifecycle reconciliation. */
export type CapabilityExpirationCause =
  | 'turn-ended'
  | 'goal-terminal'
  | 'idle-ttl'
  | 'revoke-after-success'
  | 'agent-disposed'
  | 'session-disposed'
  | 'provider-unloaded'
  | 'controller-unloaded'
  | 'registry-miss'
  | 'definition-changed'
  | 'process-restarted'
  | 'activation-lost'

/** Whether an execution reaching `tools/result` succeeded. */
export type CapabilityUseOutcome = 'succeeded' | 'failed'

/**
 * Required-on-read transition for one request or lease. Event envelope time is
 * authoritative for request, grant, use, reuse, and terminal timestamps.
 */
export type CapabilityChange =
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

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Required request and lease transition for controlled dynamic
     * capabilities. Unknown readers must refuse the log rather than omit it.
     */
    'capability/change': CapabilityChange
  }
}

const CHANGE_KINDS = new Set<CapabilityChange['kind']>([
  'requested',
  'denied',
  'granted',
  'reused',
  'used',
  'revoked',
  'expired',
])
const SCOPES = new Set<CapabilityLeaseScope>(['turn', 'task', 'session', 'persistent'])
const RISKS = new Set<CapabilityRisk>(['low', 'medium', 'high', 'critical'])
const DENIAL_CODES = new Set<CapabilityDenialCode>([
  'registry-miss',
  'policy-denied',
  'scope-not-allowed',
  'task-goal-required',
  'lease-scope-conflict',
  'approval-rejected',
  'approval-cancelled',
  'approval-unavailable',
  'activation-failed',
  'provider-unavailable',
  'request-cancelled',
  'lifecycle-context-missing',
])
const EXPIRATION_CAUSES = new Set<CapabilityExpirationCause>([
  'turn-ended',
  'goal-terminal',
  'idle-ttl',
  'revoke-after-success',
  'agent-disposed',
  'session-disposed',
  'provider-unloaded',
  'controller-unloaded',
  'registry-miss',
  'definition-changed',
  'process-restarted',
  'activation-lost',
])
const USE_OUTCOMES = new Set<CapabilityUseOutcome>(['succeeded', 'failed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactFields(
  value: Readonly<Record<string, unknown>>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value).sort()
  const allowed = new Set([...required, ...optional])
  const missing = required.some(key => !Object.hasOwn(value, key))
  const unknown = keys.some(key => !allowed.has(key))
  if (missing || unknown) {
    const suffix = optional.length === 0 ? '' : ` and optional ${[...optional].sort().join(',')}`
    throw new Error(`capability ${label} change must have exactly ${[...required].sort().join(',')}${suffix} fields`)
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`capability change ${field} must be a non-empty normalized string`)
  }
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`capability change ${field} must be a positive safe integer`)
  }
  return value
}

function decodeScope(value: unknown): CapabilityLeaseScope {
  if (typeof value !== 'string' || !SCOPES.has(value as CapabilityLeaseScope)) {
    throw new Error(`capability change scope is invalid: ${JSON.stringify(value)}`)
  }
  return value as CapabilityLeaseScope
}

function decodeBinding(value: unknown): CapabilityLeaseBinding {
  if (!isRecord(value) || typeof value['kind'] !== 'string') {
    throw new Error('capability change binding must be a tagged record')
  }
  switch (value['kind']) {
    case 'turn':
      exactFields(value, 'turn binding', ['kind', 'turn'])
      return { kind: 'turn', turn: positiveInteger(value['turn'], 'binding.turn') }
    case 'task':
      exactFields(value, 'task binding', ['goalId', 'kind'])
      if (typeof value['goalId'] !== 'string' || value['goalId'].length === 0) {
        throw new Error('capability change binding.goalId must be a non-empty string')
      }
      return { kind: 'task', goalId: value['goalId'] }
    case 'session':
      exactFields(value, 'session binding', ['kind'])
      return { kind: 'session' }
    case 'persistent':
      exactFields(value, 'persistent binding', ['kind'])
      return { kind: 'persistent' }
    default:
      throw new Error(`capability change binding kind is invalid: ${JSON.stringify(value['kind'])}`)
  }
}

function decodeToolNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('capability granted change must carry at least one tool name')
  }
  const names = value.map((name, index) => nonEmptyString(name, `toolNames[${index}]`))
  if (new Set(names).size !== names.length) {
    throw new Error('capability granted change must carry unique tool names')
  }
  return names
}

function requestId(value: unknown): CapabilityRequestId {
  return CapabilityRequestId(nonEmptyString(value, 'requestId'))
}

function leaseId(value: unknown): CapabilityLeaseId {
  return CapabilityLeaseId(nonEmptyString(value, 'leaseId'))
}

function approvalRequestId(value: unknown): ApprovalRequestId {
  return nonEmptyString(value, 'approvalRequestId') as ApprovalRequestId
}

/**
 * Decode one canonical capability change. Values from another domain return
 * `undefined`; malformed values claiming this vocabulary fail replay loudly.
 * @param value - candidate durable payload.
 * @returns a detached validated change, or `undefined` for another vocabulary.
 */
export function decodeCapabilityChange(value: unknown): CapabilityChange | undefined {
  if (!isRecord(value) || typeof value['kind'] !== 'string'
    || !CHANGE_KINDS.has(value['kind'] as CapabilityChange['kind'])) return undefined
  if (value['version'] !== CAPABILITY_CHANGE_VERSION) {
    throw new Error(`unsupported capability change version ${String(value['version'])}`)
  }
  const kind = value['kind'] as CapabilityChange['kind']
  switch (kind) {
    case 'requested': {
      exactFields(value, kind, [
        'agentId', 'capability', 'kind', 'reason', 'requestId', 'requestedScope', 'version',
      ])
      return {
        kind,
        version: CAPABILITY_CHANGE_VERSION,
        requestId: requestId(value['requestId']),
        agentId: nonEmptyString(value['agentId'], 'agentId'),
        capability: nonEmptyString(value['capability'], 'capability'),
        requestedScope: decodeScope(value['requestedScope']),
        reason: nonEmptyString(value['reason'], 'reason'),
      }
    }
    case 'denied': {
      exactFields(value, kind, ['code', 'kind', 'reason', 'requestId', 'version'], ['approvalRequestId'])
      if (typeof value['code'] !== 'string' || !DENIAL_CODES.has(value['code'] as CapabilityDenialCode)) {
        throw new Error(`capability denied change code is invalid: ${JSON.stringify(value['code'])}`)
      }
      return {
        kind,
        version: CAPABILITY_CHANGE_VERSION,
        requestId: requestId(value['requestId']),
        ...value['approvalRequestId'] === undefined
          ? {}
          : { approvalRequestId: approvalRequestId(value['approvalRequestId']) },
        code: value['code'] as CapabilityDenialCode,
        reason: nonEmptyString(value['reason'], 'reason'),
      }
    }
    case 'granted': {
      exactFields(value, kind, [
        'binding', 'kind', 'leaseId', 'provider', 'requestId', 'revokeAfterSuccess',
        'risk', 'scope', 'toolNames', 'version',
      ], ['approvalRequestId', 'idleTtlMs'])
      if (typeof value['risk'] !== 'string' || !RISKS.has(value['risk'] as CapabilityRisk)) {
        throw new Error(`capability granted change risk is invalid: ${JSON.stringify(value['risk'])}`)
      }
      if (typeof value['revokeAfterSuccess'] !== 'boolean') {
        throw new Error('capability granted change revokeAfterSuccess must be boolean')
      }
      return {
        kind,
        version: CAPABILITY_CHANGE_VERSION,
        requestId: requestId(value['requestId']),
        leaseId: leaseId(value['leaseId']),
        ...value['approvalRequestId'] === undefined
          ? {}
          : { approvalRequestId: approvalRequestId(value['approvalRequestId']) },
        provider: nonEmptyString(value['provider'], 'provider'),
        risk: value['risk'] as CapabilityRisk,
        scope: decodeScope(value['scope']),
        binding: decodeBinding(value['binding']),
        toolNames: decodeToolNames(value['toolNames']),
        ...value['idleTtlMs'] === undefined
          ? {}
          : { idleTtlMs: positiveInteger(value['idleTtlMs'], 'idleTtlMs') },
        revokeAfterSuccess: value['revokeAfterSuccess'],
      }
    }
    case 'reused':
      exactFields(value, kind, ['kind', 'leaseId', 'requestId', 'version'])
      return {
        kind, version: CAPABILITY_CHANGE_VERSION,
        requestId: requestId(value['requestId']), leaseId: leaseId(value['leaseId']),
      }
    case 'used': {
      exactFields(value, kind, ['callId', 'kind', 'leaseId', 'outcome', 'toolName', 'version'])
      if (typeof value['outcome'] !== 'string' || !USE_OUTCOMES.has(value['outcome'] as CapabilityUseOutcome)) {
        throw new Error(`capability used change outcome is invalid: ${JSON.stringify(value['outcome'])}`)
      }
      return {
        kind,
        version: CAPABILITY_CHANGE_VERSION,
        leaseId: leaseId(value['leaseId']),
        callId: nonEmptyString(value['callId'], 'callId'),
        toolName: nonEmptyString(value['toolName'], 'toolName'),
        outcome: value['outcome'] as CapabilityUseOutcome,
      }
    }
    case 'revoked':
      exactFields(value, kind, ['kind', 'leaseId', 'reason', 'version'])
      return {
        kind, version: CAPABILITY_CHANGE_VERSION,
        leaseId: leaseId(value['leaseId']), reason: nonEmptyString(value['reason'], 'reason'),
      }
    case 'expired': {
      exactFields(value, kind, ['cause', 'kind', 'leaseId', 'reason', 'version'])
      if (typeof value['cause'] !== 'string'
        || !EXPIRATION_CAUSES.has(value['cause'] as CapabilityExpirationCause)) {
        throw new Error(`capability expired change cause is invalid: ${JSON.stringify(value['cause'])}`)
      }
      return {
        kind,
        version: CAPABILITY_CHANGE_VERSION,
        leaseId: leaseId(value['leaseId']),
        cause: value['cause'] as CapabilityExpirationCause,
        reason: nonEmptyString(value['reason'], 'reason'),
      }
    }
    /* v8 ignore next 3 -- CHANGE_KINDS and the closed union keep this switch exhaustive. */
    default:
      kind satisfies never
      throw new Error('unknown capability change kind')
  }
}
