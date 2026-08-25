/** Trusted Cordis-plugin adapter that binds every activation to one Agent scope. */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type {
  CapabilityActivation,
  CapabilityRuntimeAdapter,
} from './index.ts'
import type { AgentScopedCapabilityProvider } from './provider.ts'

export type { AgentScopedCapabilityProvider } from './provider.ts'

const CONTROL_TOOL_NAMES = new Set([
  'request_capability',
  'release_capability',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
])

interface ActivePlugin {
  readonly provider: AgentScopedCapabilityProvider
  readonly fiber: Fiber
  readonly before: ReadonlyMap<string, ToolDefinition | undefined>
  readonly beforeSections: ReadonlyMap<string, PromptSection>
}

/**
 * Runtime adapter for trusted Host-side plugins.
 *
 * The adapter never invokes DynamicCordisRunner. It mounts the provider below
 * `agent.ctx`, verifies that only the declared Agent-scoped tools changed, and
 * retains the exact Fiber as the awaited revoke capability.
 */
export class AgentScopedCapabilityRuntimeAdapter implements CapabilityRuntimeAdapter {
  private readonly providers = new Map<string, AgentScopedCapabilityProvider>()
  private readonly active = new WeakMap<Agent, Map<string, ActivePlugin>>()

  constructor(
    private readonly rootCtx: Context,
    providers: readonly AgentScopedCapabilityProvider[] = [],
  ) {
    for (const provider of providers) this.addProvider(provider)
  }

  /**
   * Register one trusted provider; duplicate names fail loudly.
   * @param provider - immutable provider name, plugin, config, and declared tool set.
   * @returns an idempotent disposer that removes future activation authority while existing Fibers remain deactivatable.
   */
  registerProvider(provider: AgentScopedCapabilityProvider): () => void {
    this.addProvider(provider)
    let active = true
    return () => {
      if (!active) return
      if (this.providers.get(provider.name) !== provider) return
      active = false
      this.providers.delete(provider.name)
    }
  }

  /**
   * Resolve the exact trusted provider selected by a Registry definition.
   * @param name - provider name from the trusted Registry row.
   * @returns the registered provider, or undefined when unavailable.
   */
  resolveProvider(name: string): AgentScopedCapabilityProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * Observe whether one exact Agent currently owns this activation.
   * @param agent - exact Agent identity selecting the scoped activation map.
   * @param capability - capability id within that Agent map.
   * @returns true only while the provider Fiber remains live.
   */
  isActive(agent: Agent, capability: string): boolean {
    const map = this.active.get(agent)
    const entry = map?.get(capability)
    if (entry === undefined) return false
    if (entry.fiber.uid !== null) return true
    map?.delete(capability)
    return false
  }

  /** Mount and validate one trusted provider plugin for any V1 lease scope. */
  async activate(
    input: Parameters<CapabilityRuntimeAdapter['activate']>[0],
  ): Promise<CapabilityActivation> {
    const provider = this.providers.get(input.definition.provider)
    if (provider === undefined) {
      throw new Error(`trusted capability provider "${input.definition.provider}" is not registered`)
    }
    this.assertLiveWhenRegistryIsPresent(input.agent)
    const map = this.activationMap(input.agent)
    if (this.isActive(input.agent, input.definition.capability)) {
      throw new Error(`capability "${input.definition.capability}" is already active for this Agent`)
    }

    const beforeAgent = this.snapshot(input.agent)
    const beforeGlobal = this.snapshot()
    const beforeAgentSections = this.snapshotSections(input.agent)
    const beforeGlobalSections = this.snapshotSections()
    for (const name of provider.toolNames) {
      if (beforeAgent.has(name)) {
        throw new Error(`trusted capability provider cannot shadow existing Agent tool "${name}"`)
      }
    }
    for (const name of provider.promptSectionNames ?? []) {
      if (beforeAgentSections.has(name)) {
        throw new Error(`trusted capability provider cannot shadow existing Prompt section "${name}"`)
      }
    }
    const fiber = input.agent.ctx.plugin(provider.plugin, provider.config)
    try {
      await fiber.await()
      this.assertLiveWhenRegistryIsPresent(input.agent)
      this.assertGlobalUnchanged(beforeGlobal)
      this.assertExpectedAgentChanges(input.agent, beforeAgent, provider.toolNames)
      this.assertSectionsUnchanged(beforeGlobalSections, this.snapshotSections(), 'global')
      this.assertExpectedSectionChanges(
        input.agent,
        beforeAgentSections,
        provider.promptSectionNames ?? [],
      )
    } catch (error: unknown) {
      await fiber.dispose()
      throw error
    }

    const before = new Map<string, ToolDefinition | undefined>()
    for (const name of provider.toolNames) before.set(name, beforeAgent.get(name))
    map.set(input.definition.capability, {
      provider,
      fiber,
      before,
      beforeSections: beforeAgentSections,
    })
    return { toolNames: [...provider.toolNames] }
  }

  /** Await the exact provider Fiber teardown, then verify the prior view returned. */
  async deactivate(
    input: Parameters<CapabilityRuntimeAdapter['deactivate']>[0],
  ): Promise<void> {
    const map = this.active.get(input.agent)
    const entry = map?.get(input.lease.capability)
    if (entry === undefined) {
      throw new Error(`capability "${input.lease.capability}" is not active for this Agent`)
    }
    if (entry.provider.name !== input.lease.provider) {
      throw new Error(`active provider "${entry.provider.name}" does not match lease provider "${input.lease.provider}"`)
    }

    try {
      await entry.fiber.dispose()
    } finally {
      if (entry.fiber.uid === null && map?.get(input.lease.capability) === entry) {
        map.delete(input.lease.capability)
      }
    }
    for (const [name, prior] of entry.before) {
      if (this.rootCtx.tools.get(name, input.agent) !== prior) {
        throw new Error(`provider teardown did not restore Agent tool "${name}"`)
      }
    }
    this.assertSectionsUnchanged(
      entry.beforeSections,
      this.snapshotSections(input.agent),
      `Agent "${input.agent.id}"`,
    )
  }

  private addProvider(provider: AgentScopedCapabilityProvider): void {
    if (provider.name.length === 0 || provider.name !== provider.name.trim()) {
      throw new TypeError('capability provider name must be a non-empty trimmed string')
    }
    if (this.providers.has(provider.name)) {
      throw new Error(`capability provider "${provider.name}" is already registered`)
    }
    const names = new Set(provider.toolNames)
    if (names.size === 0 || names.size !== provider.toolNames.length) {
      throw new TypeError(`capability provider "${provider.name}" must declare unique tool names`)
    }
    for (const name of names) {
      if (name.length === 0 || name !== name.trim()) {
        throw new TypeError(`capability provider "${provider.name}" contains an invalid tool name`)
      }
      if (CONTROL_TOOL_NAMES.has(name) || name.startsWith('cordis_')) {
        throw new Error(`capability provider "${provider.name}" cannot contribute control tool "${name}"`)
      }
    }
    this.providers.set(provider.name, provider)
  }

  private activationMap(agent: Agent): Map<string, ActivePlugin> {
    let map = this.active.get(agent)
    if (map === undefined) {
      map = new Map()
      this.active.set(agent, map)
    }
    return map
  }

  private assertLiveWhenRegistryIsPresent(agent: Agent): void {
    const agents = this.rootCtx.get('agents')
    if (agents !== undefined && agents.get(agent.id) !== agent) {
      throw new Error(`agent "${agent.id}" is not the exact live registry entry`)
    }
  }

  private snapshot(agent?: Agent): Map<string, ToolDefinition | undefined> {
    return new Map(this.rootCtx.tools.schemas(agent)
      .map(schema => [schema.name, this.rootCtx.tools.get(schema.name, agent)] as const))
  }

  private snapshotSections(agent?: Agent): Map<string, PromptSection> {
    return new Map(this.rootCtx.systemPrompt.registeredSections(agent)
      .map(section => [section.name, section] as const))
  }

  private assertGlobalUnchanged(before: ReadonlyMap<string, ToolDefinition | undefined>): void {
    const after = this.snapshot()
    const names = new Set([...before.keys(), ...after.keys()])
    for (const name of names) {
      if (before.get(name) !== after.get(name)) {
        throw new Error(`trusted capability provider changed global tool "${name}"`)
      }
    }
  }

  private assertExpectedAgentChanges(
    agent: Agent,
    before: ReadonlyMap<string, ToolDefinition | undefined>,
    expectedNames: readonly string[],
  ): void {
    const expected = new Set(expectedNames)
    const after = this.snapshot(agent)
    const names = new Set([...before.keys(), ...after.keys(), ...expected])
    for (const name of names) {
      const changed = before.get(name) !== after.get(name)
      if (changed !== expected.has(name)) {
        throw new Error(changed
          ? `trusted capability provider changed undeclared Agent tool "${name}"`
          : `trusted capability provider did not contribute declared Agent tool "${name}"`)
      }
    }
  }

  private assertExpectedSectionChanges(
    agent: Agent,
    before: ReadonlyMap<string, PromptSection>,
    expectedNames: readonly string[],
  ): void {
    const expected = new Set(expectedNames)
    const after = this.snapshotSections(agent)
    const names = new Set([...before.keys(), ...after.keys(), ...expected])
    for (const name of names) {
      const changed = before.get(name) !== after.get(name)
      if (changed !== expected.has(name)) {
        throw new Error(changed
          ? `trusted capability provider changed undeclared Prompt section "${name}"`
          : `trusted capability provider did not contribute declared Prompt section "${name}"`)
      }
    }
  }

  private assertSectionsUnchanged(
    before: ReadonlyMap<string, PromptSection>,
    after: ReadonlyMap<string, PromptSection>,
    owner: string,
  ): void {
    const names = new Set([...before.keys(), ...after.keys()])
    for (const name of names) {
      if (before.get(name) !== after.get(name)) {
        throw new Error(`trusted capability provider changed ${owner} Prompt section "${name}"`)
      }
    }
  }

}
