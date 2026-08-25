/** Trusted `web.search` provider descriptor over the existing ToolWeb Consumer. */

import type { Context } from '@deepseek-ai/cordis'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import type { AgentScopedCapabilityProvider } from './agent-scoped-adapter.ts'

/** Cordis Loader plugin name and trusted Registry-facing Provider name. */
export const name = 'provider-web'

/** The Host-owned Controller service this descriptor registers into. */
export const inject = ['capabilityController']

/** Agent-scoped provider that contributes only the `web_search` model tool. */
export const WEB_SEARCH_CAPABILITY_PROVIDER = {
  name,
  plugin: ToolWeb,
  config: { search: true, fetch: false },
  toolNames: ['web_search'],
  promptSectionNames: ['tool:web_search'],
} as const satisfies AgentScopedCapabilityProvider

/** Register the trusted descriptor; the Controller mounts ToolWeb only after a grant. */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.capabilityController.registerProvider(WEB_SEARCH_CAPABILITY_PROVIDER),
    'capability-controller.registerProvider(provider-web)',
  )
}
