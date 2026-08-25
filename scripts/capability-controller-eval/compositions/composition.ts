/** Assembled Full, Raw Cordis, and Controller Loader compositions for the benchmark. */

import type { AgentScopedCapabilityProvider } from '../../../packages/capability/capability-controller/src/index.ts'
import type { ApprovalOutcome } from '../../../packages/interaction/user-approval/src/index.ts'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '../../../packages/shell/shell/src/index.ts'
import type { WebSearchProvider } from '../../../packages/web/web/src/index.ts'

import type { EvalMode } from '../types.ts'
import {
  AgentSpine,
  ApprovalService,
  CapabilityController,
  ControllerShellProvider,
  ControllerWebProvider,
  defineTool,
  DynamicCordisRunner,
  LlmDeepSeek,
  LlmReplay,
  SandboxPolicyService,
  Service,
  ShellEnv,
  ShellExecutor,
  ToolCordis,
  ToolWeb,
  WebRuntime,
  z,
  type Context,
  type ToolExecution,
} from './runtime.mjs'

/** Loader plugin name used by all three mode-pinned YAML leaves. */
export const name = 'capability-controller-eval-composition'

/** Platform-native shell schema used by the trusted Controller provider. */
const SHELL_TOOL_NAME = process.platform === 'win32' ? 'pwsh' : 'bash'

/** Values supplied by the runner through a Loader patch over the mode-pinned leaf. */
export interface Config {
  readonly mode: EvalMode
  readonly engine?: 'replay' | 'real'
  readonly replayFile?: string
  readonly replayOverrideFile?: string
  readonly provider?: string
  readonly model?: string
  readonly seed?: number
  readonly workspace?: string
  readonly approvalAnswers?: ApprovalOutcome[]
}

/** Runtime validation for the Loader-facing benchmark configuration. */
export const Config: z<Config> = z.object({
  mode: z.union(['full', 'raw-cordis', 'controller'] as const).required(),
  engine: z.union(['replay', 'real'] as const).default('replay'),
  replayFile: z.string(),
  replayOverrideFile: z.string(),
  provider: z.string(),
  model: z.string(),
  seed: z.number().step(1).min(0).default(0),
  workspace: z.string(),
  approvalAnswers: z.array(z.union(['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const)).default([]),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilityEvalFixture: CapabilityEvalFixture
  }
}

/** Exact deterministic provider observations used by task oracles. */
export interface FixtureProviderCalls {
  readonly [provider: string]: number
  readonly 'document-fixture': number
  readonly 'web-search-fixture': number
  readonly 'email-outbox-fixture': number
  readonly 'shell-workspace-fixture': number
}

/** Host-owned deterministic document, web, email, and shell fixture state. */
class CapabilityEvalFixture extends Service {
  private documentCalls = 0
  private webCalls = 0
  private emailCalls = 0
  private shellCalls = 0

  constructor(ctx: Context) {
    super(ctx, 'capabilityEvalFixture')
  }

  /** Read the immutable in-memory document used by the doc-only task. */
  readDocument(path: string): string {
    this.documentCalls += 1
    if (path !== 'fixture-document.txt') throw new Error(`unknown capability-eval document ${JSON.stringify(path)}`)
    return 'DOCUMENT_OK'
  }

  /** Return one citeable deterministic search result and count the Provider call. */
  webSearch(query: string): { content: string; sources: { url: string; title: string; snippet: string }[]; truncated: false } {
    this.webCalls += 1
    return {
      content: `Fixture release result for ${query}`,
      sources: [{
        url: 'https://example.invalid/dsh-capability-eval/release',
        title: 'Capability eval fixture release',
        snippet: 'The deterministic fixture release is 2026.08.',
      }],
      truncated: false,
    }
  }

  /** Append one deterministic message to the in-memory outbox. */
  sendEmail(to: string, subject: string, body: string): { status: 'sent'; to: string; subject: string; body: string } {
    this.emailCalls += 1
    return { status: 'sent', to, subject, body }
  }

  /** Execute the harmless benchmark marker without invoking an operating-system shell. */
  runShell(command: string): string {
    this.shellCalls += 1
    return `SHELL_FIXTURE_OK: ${command}`
  }

  /** Snapshot exact provider invocation counts for oracle evaluation. */
  providerCalls(): FixtureProviderCalls {
    return {
      'document-fixture': this.documentCalls,
      'web-search-fixture': this.webCalls,
      'email-outbox-fixture': this.emailCalls,
      'shell-workspace-fixture': this.shellCalls,
    }
  }
}

const DocumentTools = {
  name: 'capability-eval-document-tools',
  inject: ['tools', 'capabilityEvalFixture'],
  apply(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: 'read',
      description: 'Read the deterministic capability-eval document.',
      parameters: { path: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: args => Promise.resolve(ctx.capabilityEvalFixture.readDocument(args.path)),
    }))
    ctx.tools.register(defineTool({
      name: 'write',
      description: 'Write a deterministic capability-eval document without touching the host filesystem.',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: args => Promise.resolve({ status: 'written', path: args.path, bytes: args.content.length }),
    }))
  },
}

const FixtureWebProvider = {
  name: 'capability-eval-web-provider',
  inject: ['web', 'capabilityEvalFixture'],
  apply(ctx: Context): void {
    const provider: WebSearchProvider = {
      id: 'web-search-fixture',
      available: () => true,
      search: request => Promise.resolve(ctx.capabilityEvalFixture.webSearch(request.query)),
    }
    ctx.effect(
      () => ctx.web.registerSearchProvider(provider),
      'capability-eval: register deterministic web provider',
    )
  },
}

/** Shell seam provider that returns only the deterministic benchmark marker. */
class FixtureShellExecutor extends ShellExecutor {
  static inject = ['capabilityEvalFixture']

  override get sandboxMode() {
    return 'read-only' as const
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 30_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal === undefined ? {} : { signal: request.signal },
      ...request.stdin === undefined ? {} : { stdin: request.stdin },
      ...request.env === undefined ? {} : { env: request.env },
      ...request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv },
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: `${this.ctx.capabilityEvalFixture.runShell(spec.command)}\n`, truncated: false },
      stderr: { text: '', truncated: false },
    })
  }

  start(_spec: ShellExecSpec): ShellProcess {
    throw new Error('capability eval disables background shell execution')
  }
}

interface OptionalApprovalConfig {
  readonly requireApproval?: boolean
}

async function approvalOutcome(ctx: Context, exec: ToolExecution, toolName: string): Promise<ApprovalOutcome> {
  const agent = exec.agent
  if (agent === undefined) return 'unavailable'
  return await ctx.approval.request({
    agent,
    toolName,
    callId: exec.callId,
    reason: `Capability eval ${toolName} fixture requires approval`,
    signal: exec.signal,
  })
}

const EmailTool = {
  name: 'capability-eval-email-tool',
  inject: ['tools', 'approval', 'capabilityEvalFixture'],
  apply(ctx: Context, config: OptionalApprovalConfig = {}): void {
    ctx.tools.register(defineTool({
      name: 'send_email',
      description: 'Send one deterministic message to the capability-eval outbox.',
      parameters: {
        to: { type: 'string', required: true },
        subject: { type: 'string', required: true },
        body: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (config.requireApproval === true) {
          const outcome = await approvalOutcome(ctx, exec, 'send_email')
          if (outcome !== 'allowed-once') return { status: 'not-sent', outcome }
        }
        return ctx.capabilityEvalFixture.sendEmail(args.to, args.subject, args.body)
      },
    }))
  },
}

const FullShellTool = {
  name: 'capability-eval-full-shell-tool',
  inject: ['tools', 'approval', 'capabilityEvalFixture'],
  apply(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: SHELL_TOOL_NAME,
      description: 'Run the deterministic workspace-confined capability-eval shell marker.',
      parameters: {
        command: { type: 'string', required: true },
        description: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const outcome = await approvalOutcome(ctx, exec, SHELL_TOOL_NAME)
        return outcome === 'allowed-once'
          ? ctx.capabilityEvalFixture.runShell(args.command)
          : `SHELL_FIXTURE_NOT_RUN: ${outcome}`
      },
    }))
  },
}

const EMAIL_CAPABILITY_PROVIDER = {
  name: 'email-outbox-fixture',
  plugin: EmailTool,
  config: { requireApproval: false },
  toolNames: ['send_email'],
} as const satisfies AgentScopedCapabilityProvider

const ControllerEmailProvider = {
  name: 'capability-eval-controller-email-provider',
  inject: ['capabilityController'],
  apply(ctx: Context): void {
    ctx.effect(
      () => ctx.capabilityController.registerProvider(EMAIL_CAPABILITY_PROVIDER),
      'capability-eval: register Controller email provider',
    )
  },
}

async function installModel(
  ctx: Context,
  config: Config,
  engine: 'replay' | 'real',
  provider: string,
  model: string,
): Promise<void> {
  if (engine === 'replay') {
    if (config.replayFile === undefined || config.replayOverrideFile === undefined) {
      throw new Error('capability eval replay requires replayFile and replayOverrideFile')
    }
    await ctx.plugin(LlmReplay, {
      file: config.replayFile,
      overrideFile: config.replayOverrideFile,
      providers: [{
        id: provider,
        models: [{ id: model, contextWindow: 128_000 }],
      }],
    })
    return
  }
  if (provider !== 'deepseek-official') {
    throw new Error(`capability eval real engine does not have an adapter for provider ${JSON.stringify(provider)}`)
  }
  await ctx.plugin(LlmDeepSeek, { models: [{ id: model, contextWindow: 128_000 }] })
}

async function installFull(ctx: Context): Promise<void> {
  await ctx.plugin(ToolWeb, { search: true, fetch: false })
  await ctx.plugin(EmailTool, { requireApproval: true })
  await ctx.plugin(FullShellTool)
}

async function installRawCordis(ctx: Context): Promise<void> {
  await ctx.plugin(DynamicCordisRunner, { vmTimeoutMs: 5_000 })
  await ctx.plugin(ToolCordis)
}

async function installController(ctx: Context): Promise<void> {
  await ctx.plugin(CapabilityController, {
    capabilities: [
      {
        capability: 'web.search',
        provider: ControllerWebProvider.name,
        risk: 'low',
        approvalRequired: false,
        defaultScope: 'session',
        allowedScopes: ['session'],
      },
      {
        capability: 'email.send',
        provider: EMAIL_CAPABILITY_PROVIDER.name,
        risk: 'high',
        approvalRequired: true,
        defaultScope: 'session',
        allowedScopes: ['session'],
      },
      {
        capability: 'shell.execute',
        provider: ControllerShellProvider.name,
        risk: 'critical',
        approvalRequired: true,
        defaultScope: 'session',
        allowedScopes: ['session'],
      },
    ],
  })
  await ctx.plugin(ControllerWebProvider)
  await ctx.plugin(ControllerShellProvider)
  await ctx.plugin(ControllerEmailProvider)
}

/** Assemble one isolated benchmark Agent behind the selected capability mode. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const engine = config.engine ?? 'replay'
  const provider = config.provider ?? (engine === 'replay' ? 'capability-eval-replay' : '')
  const model = config.model ?? (engine === 'replay' ? 'deterministic' : '')
  if (provider.length === 0 || model.length === 0) {
    throw new Error(`capability eval ${engine} engine requires provider and model`)
  }
  const workspace = config.workspace ?? process.cwd()
  const answers = [...(config.approvalAnswers ?? [])]

  await installModel(ctx, config, engine, provider, model)
  await ctx.plugin(AgentSpine, {
    agents: [{ id: 'main', provider, model, cwd: workspace }],
    workspaceContext: false,
    skills: { enabled: false },
    toolBash: false,
    toolJobs: false,
    goals: false,
    invariants: { enabled: false },
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    persona: `Capability Controller benchmark mode: ${config.mode}. Deterministic run seed: ${config.seed ?? 0}.`,
    maxParallelToolCalls: 1,
  })
  await ctx.plugin(CapabilityEvalFixture)
  await ctx.plugin(DocumentTools)
  await ctx.plugin(WebRuntime, { searchProvider: 'web-search-fixture' })
  await ctx.plugin(FixtureWebProvider)
  await ctx.plugin(SandboxPolicyService, {})
  await ctx.plugin(FixtureShellExecutor)
  await ctx.plugin(ShellEnv, { dshHome: workspace })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  ctx.on('approval/request', (_request, next) => {
    const answer = answers.shift()
    return answer === undefined ? next() : Promise.resolve(answer)
  })

  switch (config.mode) {
    case 'full':
      await installFull(ctx)
      return
    case 'raw-cordis':
      await installRawCordis(ctx)
      return
    case 'controller':
      await installController(ctx)
      return
  }
}
