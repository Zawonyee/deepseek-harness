/** Static contract for the shipped controlled-document Agent preset. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { scanRoot } from '@deepseek-ai/dsh-agent-presets'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Entry {
  readonly id?: string
  readonly name?: string
  readonly group?: boolean
  readonly isolate?: Record<string, unknown>
  readonly config?: unknown
}

interface CapabilityDefinition {
  readonly capability: string
  readonly provider: string
  readonly risk: string
  readonly approvalRequired: boolean
  readonly defaultScope: string
  readonly allowedScopes: readonly string[]
  readonly idleTtlSec?: number
  readonly expireAfterSuccessfulUse?: boolean
}

const PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))
const PRESET_DIR = join(PRESET_ROOT, 'controlled-doc')

function rows(value: unknown, label: string): Entry[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an entry list`)
  return value as Entry[]
}

function rowById(entries: readonly Entry[], id: string): Entry {
  const row = entries.find(entry => entry.id === id)
  if (row === undefined) throw new TypeError(`controlled-doc must contain row ${id}`)
  return row
}

async function composition(): Promise<Entry[]> {
  const source = await readFile(join(PRESET_DIR, 'agent.cordis.yml'), 'utf8')
  return rows(yaml.load(source, { schema: entryListSchema }), 'controlled-doc')
}

describe('controlled-doc shipped preset', () => {
  it('is discovered as a healthy ordered system preset', async () => {
    const presets = await scanRoot({ path: PRESET_ROOT, trust: 'system' })
    const controlled = presets.find(preset => preset.id === 'controlled-doc')

    expect(controlled).toMatchObject({
      id: 'controlled-doc',
      trust: 'system',
      name: '受控文档模式',
      description:
        '面向文档工作的最小 Agent；文件读写是基础能力，网页检索与 Shell 只能通过受控申请临时获得。',
      order: 5,
    })
    expect(controlled?.broken).toBeUndefined()
  })

  it('starts with only filesystem and capability-control tools', async () => {
    const entries = await composition()
    const group = rowById(entries, 'capability-control')
    const controlledRows = rows(group.config, 'capability-control')

    expect(entries.map(row => row.id)).toEqual(['persona', 'tool-fs', 'capability-control'])
    expect(rowById(entries, 'tool-fs')).toMatchObject({ name: '@deepseek-ai/dsh-tool-fs' })
    expect(group).toMatchObject({
      name: 'cordis:group',
      group: true,
      isolate: { capabilityController: true },
    })
    expect(controlledRows.map(row => [row.id, row.name])).toEqual([
      ['capability-controller', '@deepseek-ai/dsh-capability-controller'],
      ['provider-web', '@deepseek-ai/dsh-capability-controller/provider-web'],
      ['provider-shell', '@deepseek-ai/dsh-capability-controller/provider-shell'],
    ])

    const pluginNames = [...entries, ...controlledRows].map(row => row.name)
    expect(pluginNames).not.toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-tool-goal',
      '@deepseek-ai/dsh-tool-cordis',
      '@deepseek-ai/dsh-tool-web',
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-pwsh',
      '@deepseek-ai/dsh-tool-fs-search',
    ]))
  })

  it('teaches the model to use default scopes and close Web authority after its final use', async () => {
    const entries = await composition()
    const persona = rowById(entries, 'persona')
    const text = (persona.config as { readonly text?: string }).text

    expect(text).toContain(
      'When calling request_capability, omit requested_scope so the Controller uses the configured Registry default; never guess or probe alternative scopes.',
    )
    expect(text).toContain('Save lease_id from every granted result.')
    expect(text).toContain(
      'After the last web_search needed for the current user task, call release_capability with that lease_id before giving the final answer.',
    )
    expect(text).toContain(
      'A successful shell call consumes the shell.execute lease; request shell.execute again before any later shell call.',
    )
  })

  it('registers only the approved web and shell capability policies', async () => {
    const entries = await composition()
    const controlledRows = rows(rowById(entries, 'capability-control').config, 'capability-control')
    const controller = rowById(controlledRows, 'capability-controller')
    const config = controller.config as { capabilities?: CapabilityDefinition[] }

    expect(config.capabilities).toEqual([
      {
        capability: 'web.search',
        provider: 'provider-web',
        risk: 'low',
        approvalRequired: true,
        defaultScope: 'session',
        allowedScopes: ['session'],
        idleTtlSec: 600,
      },
      {
        capability: 'shell.execute',
        provider: 'provider-shell',
        risk: 'critical',
        approvalRequired: true,
        defaultScope: 'turn',
        allowedScopes: ['turn'],
        expireAfterSuccessfulUse: true,
      },
    ])
    expect(config.capabilities?.some(definition => definition.capability === 'email.send')).toBe(false)
  })
})
