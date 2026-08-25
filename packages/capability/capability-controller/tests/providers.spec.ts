import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WEB_SEARCH_CAPABILITY_PROVIDER,
  apply as applyWebProvider,
  inject as webInject,
  name as webPluginName,
} from '../src/provider-web.ts'

const CONTROL_TOOL_NAMES = [
  'request_capability',
  'release_capability',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
] as const

async function shellProviderFor(platform: NodeJS.Platform) {
  vi.resetModules()
  const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  try {
    const module = await import('../src/provider-shell.ts')
    return module
  } finally {
    platformSpy.mockRestore()
  }
}

function expectLoaderRegistration(
  apply: (ctx: never) => void,
  provider: unknown,
  expectedLabel: string,
): void {
  const dispose = vi.fn()
  const registerProvider = vi.fn(() => dispose)
  let cleanup: (() => void) | undefined
  const effect = vi.fn((setup: () => () => void, _label: string) => {
    cleanup = setup()
  })

  apply({ capabilityController: { registerProvider }, effect } as never)

  expect(effect).toHaveBeenCalledOnce()
  expect(effect).toHaveBeenCalledWith(expect.any(Function), expectedLabel)
  expect(registerProvider).toHaveBeenCalledOnce()
  expect(registerProvider).toHaveBeenCalledWith(provider)
  expect(cleanup).toBe(dispose)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('trusted capability provider descriptors', () => {
  it('maps provider-web to ToolWeb with only web_search and its guidance declared', () => {
    expect(WEB_SEARCH_CAPABILITY_PROVIDER).toMatchObject({
      name: 'provider-web',
      plugin: ToolWeb,
      config: { search: true, fetch: false },
      toolNames: ['web_search'],
      promptSectionNames: ['tool:web_search'],
    })
  })

  it('maps provider-shell to pwsh on Windows without installing an executor', async () => {
    const module = await shellProviderFor('win32')
    const provider = module.SHELL_EXECUTE_CAPABILITY_PROVIDER

    expect(provider).toMatchObject({
      name: 'provider-shell',
      plugin: { name: 'tool-pwsh' },
      config: { enableRunInBackground: false },
      toolNames: ['pwsh'],
      promptSectionNames: ['tool:pwsh'],
    })
    expect(Object.keys(provider).sort()).toEqual([
      'config',
      'name',
      'plugin',
      'promptSectionNames',
      'toolNames',
    ])
  })

  it('maps provider-shell to bash off Windows without installing an executor', async () => {
    const module = await shellProviderFor('linux')
    const provider = module.SHELL_EXECUTE_CAPABILITY_PROVIDER

    expect(provider).toMatchObject({
      name: 'provider-shell',
      plugin: { name: 'tool-bash' },
      config: { enableRunInBackground: false },
      toolNames: ['bash'],
      promptSectionNames: ['tool:bash'],
    })
    expect(Object.keys(provider).sort()).toEqual([
      'config',
      'name',
      'plugin',
      'promptSectionNames',
      'toolNames',
    ])
  })

  it('exposes provider-web as a Loader plugin with effect-scoped registration', () => {
    expect(webPluginName).toBe('provider-web')
    expect(webInject).toEqual(['capabilityController'])
    expectLoaderRegistration(
      applyWebProvider,
      WEB_SEARCH_CAPABILITY_PROVIDER,
      'capability-controller.registerProvider(provider-web)',
    )
  })

  it.each<NodeJS.Platform>(['win32', 'linux'])(
    'exposes provider-shell as a Loader plugin on %s with effect-scoped registration',
    async (platform) => {
      const module = await shellProviderFor(platform)
      expect(module.name).toBe('provider-shell')
      expect(module.inject).toEqual(['capabilityController'])
      expectLoaderRegistration(
        module.apply,
        module.SHELL_EXECUTE_CAPABILITY_PROVIDER,
        'capability-controller.registerProvider(provider-shell)',
      )
    },
  )

  it('keeps shell execution delegated to the existing sandbox-aware Consumer', async () => {
    const windows = (await shellProviderFor('win32')).SHELL_EXECUTE_CAPABILITY_PROVIDER
    const posix = (await shellProviderFor('linux')).SHELL_EXECUTE_CAPABILITY_PROVIDER

    expect(windows.plugin).toMatchObject({ name: 'tool-pwsh' })
    expect(windows.plugin.inject).toContain('shell')
    expect(posix.plugin).toMatchObject({ name: 'tool-bash' })
    expect(posix.plugin.inject).toContain('shell')
    expect(windows.config).toEqual({ enableRunInBackground: false })
    expect(posix.config).toEqual({ enableRunInBackground: false })
  })

  it('never declares Controller or raw Cordis control tools', async () => {
    const providers = [
      WEB_SEARCH_CAPABILITY_PROVIDER,
      (await shellProviderFor('win32')).SHELL_EXECUTE_CAPABILITY_PROVIDER,
      (await shellProviderFor('linux')).SHELL_EXECUTE_CAPABILITY_PROVIDER,
    ]

    for (const provider of providers) {
      expect(provider.toolNames).not.toEqual(expect.arrayContaining([...CONTROL_TOOL_NAMES]))
    }
  })
})
