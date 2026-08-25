/** Public declaration contract for Host-owned capability Providers. */

import type { Plugin } from '@deepseek-ai/cordis'

const CONTROL_TOOL_NAMES = new Set([
  'request_capability',
  'release_capability',
])

/**
 * One trusted Provider that the Host may register with the Controller.
 *
 * Registration only declares an activatable Cordis plugin. The Controller
 * mounts that plugin below the requesting Agent's scope after policy and
 * approval succeed; declaring a Provider never grants its tools by itself.
 */
export interface AgentScopedCapabilityProvider {
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

/** Concise public name for an exact-Agent Provider descriptor. */
export type CapabilityProvider = AgentScopedCapabilityProvider

function validateNames(
  provider: string,
  kind: 'Tool' | 'Prompt section',
  names: readonly string[],
  requireOne: boolean,
): void {
  if (requireOne && names.length === 0) {
    throw new TypeError(`capability Provider "${provider}" must declare at least one ${kind} name`)
  }
  if (new Set(names).size !== names.length) {
    throw new TypeError(`capability Provider "${provider}" must declare unique ${kind} names`)
  }
  for (const name of names) {
    if (name.length === 0 || name !== name.trim()) {
      throw new TypeError(`capability Provider "${provider}" contains an invalid ${kind} name`)
    }
    if (kind === 'Tool' && (CONTROL_TOOL_NAMES.has(name) || name.startsWith('cordis_'))) {
      throw new Error(`capability Provider "${provider}" cannot contribute control tool "${name}"`)
    }
  }
}

/**
 * Validate and retain an external Provider descriptor while preserving its
 * literal types and object identity. Host registration remains the authority
 * for cross-Provider conflicts and active-Fiber ownership.
 * @param provider - immutable Provider descriptor to validate and retain.
 * @returns the same descriptor with its literal type and object identity preserved.
 */
export function defineCapabilityProvider<const Provider extends AgentScopedCapabilityProvider>(
  provider: Provider,
): Provider {
  if (provider.name.length === 0 || provider.name !== provider.name.trim()) {
    throw new TypeError('capability Provider name must be a non-empty trimmed string')
  }
  validateNames(provider.name, 'Tool', provider.toolNames, true)
  validateNames(provider.name, 'Prompt section', provider.promptSectionNames ?? [], false)
  return provider
}
