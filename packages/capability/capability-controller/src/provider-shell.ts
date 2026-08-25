/** Trusted `shell.execute` provider descriptor over the platform shell Tool Consumer. */

import type { Context } from '@deepseek-ai/cordis'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import type { AgentScopedCapabilityProvider } from './agent-scoped-adapter.ts'

/** Cordis Loader plugin name and trusted Registry-facing Provider name. */
export const name = 'provider-shell'

/** The Host-owned Controller service this descriptor registers into. */
export const inject = ['capabilityController']

/**
 * Agent-scoped shell Tool Consumer for the current platform. The selected
 * plugin requires an existing `ctx.shell` executor and never installs one.
 */
export const SHELL_EXECUTE_CAPABILITY_PROVIDER: AgentScopedCapabilityProvider = process.platform === 'win32'
  ? {
    name,
    plugin: ToolPwsh,
    config: { enableRunInBackground: false },
    toolNames: ['pwsh'],
    promptSectionNames: ['tool:pwsh'],
  }
  : {
    name,
    plugin: ToolBash,
    config: { enableRunInBackground: false },
    toolNames: ['bash'],
    promptSectionNames: ['tool:bash'],
  }

/** Register the trusted descriptor; the Controller mounts the shell Consumer only after a grant. */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.capabilityController.registerProvider(SHELL_EXECUTE_CAPABILITY_PROVIDER),
    'capability-controller.registerProvider(provider-shell)',
  )
}
