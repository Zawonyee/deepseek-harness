/** Package-owned invariant companion for durable capability transitions. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyCapabilityEvent,
  emptyCapabilityFoldState,
} from './fold.ts'
import type { CapabilityFoldState } from './fold.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-capability-controller'

export const name = 'capability-controller-invariant'
export const inject = ['invariants']

function cloneState(state: CapabilityFoldState): CapabilityFoldState {
  return {
    requests: new Map(state.requests),
    leases: new Map(state.leases),
    uses: new Set(state.uses),
  }
}

function applyChecked(state: CapabilityFoldState, event: SessionEvent, fail: InvariantFailure): void {
  try {
    applyCapabilityEvent(state, event)
  } catch (error: unknown) {
    /* v8 ignore next -- strict decoders and transition checks throw Error instances */
    const message = error instanceof Error ? error.message : String(error)
    fail(`session event ${event.seq} violates the durable capability stream: ${message}`)
  }
}

/** Install an independent incremental fold over every attached Session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, CapabilityFoldState>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: CapabilityFoldState }>()

  const seed = (session: Session): CapabilityFoldState => {
    const state = emptyCapabilityFoldState()
    for (const event of session.events) applyChecked(state, event, fail)
    states.set(session, state)
    return state
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const stateFor = (session: Session): CapabilityFoldState => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'capability/change') return
    const state = cloneState(stateFor(session))
    applyChecked(state, event, fail)
    staged.set(event, { session, state })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'capability/change') return
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching capability-fold validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register ownership of this package's invariant surface.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
