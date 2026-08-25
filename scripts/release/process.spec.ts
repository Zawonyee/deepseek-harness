/** Windows command selection at the release process boundary. */

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn((..._args: unknown[]) => ({
    error: undefined,
    status: 0,
    stdout: '',
    stderr: '',
  })),
}))

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }))

import { afterEach, describe, expect, it, vi } from 'vitest'
import { attempt, run } from './process.ts'

const PNPM_ENTRYPOINT = String.raw`C:\tools\pnpm\pnpm.cjs`

function windowsLifecycleEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, npm_execpath: PNPM_ENTRYPOINT }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  spawnSyncMock.mockClear()
})

describe('release process commands', () => {
  it('runs pnpm through its lifecycle JavaScript entrypoint on Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const env = windowsLifecycleEnvironment()

    run('pnpm', ['--dir', 'packages/example', 'pack'], { cwd: String.raw`C:\repo`, env })

    expect(spawnSyncMock).toHaveBeenCalledOnce()
    expect(spawnSyncMock).toHaveBeenCalledWith(
      process.execPath,
      [PNPM_ENTRYPOINT, '--dir', 'packages/example', 'pack'],
      { cwd: String.raw`C:\repo`, env, stdio: 'inherit' },
    )
  })

  it('uses the same shell-free pnpm resolution for captured commands', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const env = windowsLifecycleEnvironment()

    attempt('pnpm', ['install', '--lockfile-only'], { env })

    expect(spawnSyncMock).toHaveBeenCalledOnce()
    expect(spawnSyncMock).toHaveBeenCalledWith(
      process.execPath,
      [PNPM_ENTRYPOINT, 'install', '--lockfile-only'],
      { cwd: undefined, env, encoding: 'utf8' },
    )
  })
})
