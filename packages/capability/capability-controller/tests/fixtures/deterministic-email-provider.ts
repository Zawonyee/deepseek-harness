import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as CapabilityControllerContract from '../../src/index.ts'
import type { CapabilityProvider } from '../../src/index.ts'

/** Canonical message persisted by the network-free email fixture. */
export interface DeterministicEmailMessage {
  readonly id: string
  readonly to: string
  readonly subject: string
  readonly body: string
}

/** Test-only, deterministic replacement for an external email delivery boundary. */
export class DeterministicEmailOutbox {
  private sequence = 0
  private readonly sent: DeterministicEmailMessage[] = []

  /** Store a message and return its stable, insertion-ordered receipt. */
  send(input: Omit<DeterministicEmailMessage, 'id'>): DeterministicEmailMessage {
    const message: DeterministicEmailMessage = {
      id: `email-${String(++this.sequence).padStart(4, '0')}`,
      ...input,
    }
    this.sent.push(message)
    return message
  }

  /** Return detached rows so assertions cannot mutate the outbox. */
  list(): readonly DeterministicEmailMessage[] {
    return this.sent.map(message => ({ ...message }))
  }
}

type ProviderDeclaration = <const Provider extends CapabilityProvider>(provider: Provider) => Provider

function providerDeclaration(): ProviderDeclaration {
  const define = (CapabilityControllerContract as typeof CapabilityControllerContract & {
    readonly defineCapabilityProvider?: ProviderDeclaration
  }).defineCapabilityProvider
  if (define === undefined) throw new Error('Capability Controller does not export defineCapabilityProvider()')
  return define
}

/** Build one external-style Provider descriptor backed only by the deterministic test outbox. */
export function createDeterministicEmailProvider(
  outbox: DeterministicEmailOutbox,
): CapabilityProvider {
  return providerDeclaration()({
    name: 'fixture-provider-email',
    toolNames: ['email_send'],
    promptSectionNames: ['tool:email_send'],
    plugin: Object.assign((ctx: Context) => {
      ctx.systemPrompt.section({
        name: 'tool:email_send',
        order: 110,
        text: 'Send email only to the explicitly requested recipient.',
      })
      ctx.tools.register(defineTool({
        name: 'email_send',
        description: 'Send one email through the configured external Provider.',
        parameters: {
          to: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          body: { type: 'string', required: true },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              to: { type: 'string', required: true },
              subject: { type: 'string', required: true },
              body: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `queued ${value.id}` }],
        },
        execute: args => Promise.resolve(outbox.send(args)),
      }))
    }, { inject: ['tools', 'systemPrompt'] }),
  })
}
