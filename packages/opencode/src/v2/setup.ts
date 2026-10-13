import {
  acquireNativeAccountRuntime,
  authorize,
  createNativeUi,
  disconnectNativeVaultForHost,
  exchange,
  logger,
  type NativeAccountRuntime,
  type NativeAccountRuntimeOptions,
  type NativePoolPaths,
  type NativeUiOptions,
  readNativeEnrollmentMode,
  resolveNativePoolPaths,
} from '@cortexkit/anthropic-auth-core'
import {
  type PoolLoginMethod,
  type RegisterOpenCode2AuthMethodsOptions,
  registerOpenCode2AuthMethods,
} from '@cortexkit/common-auth/opencode2'
import type { Plugin } from '@opencode/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'
import {
  CLAUDE_POOL_LOGIN_METHOD_ID,
  CLAUDE_VAULT_ACTIVATION_METHOD_ID,
} from './activation'
import { installNativeAnthropic } from './install'
import { startNativeAnthropicLifecycle } from './lifecycle'
import { createNativeMenuCapabilities } from './menu'
import { createNativeClaudeModelRules } from './models'
import { preparedAnthropicCredential } from './ownership'
import { createNativePrime } from './prime'
import { registerNativeMenu } from './rpc'
import { createNativeAnthropicSource, type NativeSource } from './source'
import { createNativeWirePolicy } from './wire'

export const ANTHROPIC_AUTH_PLUGIN_ID = 'cortexkit-anthropic-auth'

/**
 * The account source vault enrollment selects: 'local' serves accounts stored
 * in this machine's account pool, 'claustrum' serves accounts from the
 * Claustrum vault this OpenCode is enrolled in.
 */
export type NativeEnrollmentMode = 'local' | 'claustrum'

export interface AnthropicAuthV2Options {
  readonly paths?: NativePoolPaths
  readonly local?: NativeAccountRuntimeOptions['local']
  readonly vault?: NativeAccountRuntimeOptions['vault']
  readonly fetch?: typeof fetch
}

/** The OAuth result a completed Claude Pro / Max sign-in hands to the pool. */
export interface ClaudeOAuthLogin {
  readonly access: string
  readonly refresh: string
  readonly expires: number
}

export const LOCAL_LOGIN_REFUSED_IN_VAULT =
  'This OpenCode is enrolled in the Claude vault and uses only vault accounts. Choose "Claude vault accounts" instead; no local account was changed.'
export const VAULT_ACTIVATION_REFUSED_LOCALLY =
  'This OpenCode is not enrolled in the Claude vault. Enroll it first, or sign in with Claude Pro / Max.'
export const ENROLLMENT_UNREADABLE =
  'The Claude vault enrollment could not be read; repair it and retry. Nothing was changed.'

export interface ClaudeLoginMethodsInput {
  /** False once setup is disposed; every step refuses after that. */
  readonly isActive: () => boolean
  readonly readMode: () => Promise<NativeEnrollmentMode>
  /** Verifies a completed sign-in's account and writes it to the local pool. */
  readonly runtime: Pick<NativeAccountRuntime, 'loginOAuth'>
  readonly authorize?: typeof authorize
  readonly exchange?: typeof exchange
}

/**
 * Builds the two login methods OpenCode 2 offers for the anthropic provider:
 * the Claude Pro / Max browser sign-in, which writes to the local account
 * pool, and vault activation, which writes nothing locally. Vault enrollment
 * alone decides which one works. When OpenCode is enrolled in the vault, the
 * browser sign-in refuses before it opens a browser and again before it
 * writes, and only vault activation succeeds. When it is not enrolled, vault
 * activation refuses. An enrollment that cannot be read refuses both, since
 * neither account source can then be shown to be the right one.
 */
export function claudeLoginMethods(
  input: ClaudeLoginMethodsInput,
): RegisterOpenCode2AuthMethodsOptions<ClaudeOAuthLogin> {
  const start = input.authorize ?? authorize
  const finish = input.exchange ?? exchange
  const ensureActive = () => {
    if (!input.isActive())
      throw new Error('Claude authentication setup is closed')
  }
  const mode = async () => {
    let current: NativeEnrollmentMode
    try {
      current = await input.readMode()
    } catch {
      throw new Error(ENROLLMENT_UNREADABLE)
    }
    ensureActive()
    return current
  }
  const requireLocal = async () => {
    if ((await mode()) !== 'local')
      throw new Error(LOCAL_LOGIN_REFUSED_IN_VAULT)
  }
  const loginMethods: PoolLoginMethod<ClaudeOAuthLogin>[] = [
    {
      method: {
        id: CLAUDE_POOL_LOGIN_METHOD_ID,
        type: 'oauth',
        label: 'Claude Pro / Max (native account pool)',
      },
      async authorize() {
        ensureActive()
        await requireLocal()
        const auth = await start('max')
        ensureActive()
        return {
          mode: 'code',
          url: auth.url,
          instructions: 'Paste the authorization code returned by Claude.',
          callback: async (code) => {
            ensureActive()
            const result = await finish(
              code,
              auth.verifier,
              auth.redirectUri,
              auth.state,
            )
            if (!input.isActive() || result.type !== 'success')
              throw new Error('Claude sign-in did not complete')
            // Hand on only the token fields. The exchange result's own `type`
            // field ('success') would replace the stored credential's
            // `type: 'oauth'` when the pool copies these fields into it.
            return {
              access: result.access,
              refresh: result.refresh,
              expires: result.expires,
            }
          },
        }
      },
    },
  ]
  return {
    integrationID: 'anthropic',
    methods: loginMethods,
    vault: {
      method: {
        id: CLAUDE_VAULT_ACTIVATION_METHOD_ID,
        type: 'oauth',
        label: 'Claude vault accounts',
      },
      async activate() {
        ensureActive()
        if ((await mode()) !== 'claustrum')
          throw new Error(VAULT_ACTIVATION_REFUSED_LOCALLY)
      },
    },
    async onLogin(credential) {
      ensureActive()
      // Enrollment can change while the user is in the browser. Check it
      // again immediately before writing anything to the local pool.
      await requireLocal()
      await input.runtime.loginOAuth({
        routeId: 'main',
        credential,
        replace: true,
      })
      ensureActive()
    },
    label: 'Claude native account pool',
  }
}

/**
 * OpenCode's vault enrollment callbacks for the login methods and the
 * `claude` menu. Both use only the enrollment files that `env` names.
 * Disconnecting ends this OpenCode's vault enrollment and never reads or
 * changes OpenCode's own stored sign-ins.
 */
export function nativeEnrollmentCallbacks(env: NodeJS.ProcessEnv) {
  return {
    readMode: (): Promise<NativeEnrollmentMode> =>
      readNativeEnrollmentMode('opencode', env),
    disconnectVault: () =>
      disconnectNativeVaultForHost({ host: 'opencode', env }),
  }
}

export function createAnthropicAuthPlugin(
  options: AnthropicAuthV2Options = {},
): Plugin.Plugin {
  return {
    id: ANTHROPIC_AUTH_PLUGIN_ID,
    setup: (ctx) => setupAnthropicAuth(ctx, options),
  }
}

/** Install request hooks before credential transfer to the shared pool finishes; requests must refuse until that transfer commits, never reuse old host tokens. */
export async function setupAnthropicAuth(
  ctx: Plugin.Context,
  options: AnthropicAuthV2Options = {},
): Promise<Plugin.Cleanup> {
  const paths = options.paths ?? (await resolveNativePoolPaths())
  const runtime = acquireNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: options.local,
    vault: options.vault,
  })
  // Use the same enrollment files the account runtime reads, so the login
  // methods, the menu and request serving always agree on the mode.
  const enrollment = nativeEnrollmentCallbacks(
    options.vault?.env ?? process.env,
  )
  let active = true
  const wire = createNativeWirePolicy()
  const models = createNativeClaudeModelRules()
  let lifecycle: ReturnType<typeof startNativeAnthropicLifecycle> | undefined
  let prime: ReturnType<typeof createNativePrime> | undefined
  const source: NativeSource = createNativeAnthropicSource({
    runtime,
    paths,
    fetch: options.fetch,
    requestOptions: wire.requestOptions,
    responseOptions: wire.responseOptions,
    onRequestId: wire.onRequestId,
    onForgetSession: wire.forgetSession,
    resolveModelId: async (scope) => models.modelId(scope.modelID),
    onOwnedRequest: () => {
      lifecycle ??= startNativeAnthropicLifecycle(runtime, options.fetch)
      prime ??= createNativePrime({
        runtime,
        paths,
        source,
        fetch: options.fetch,
      })
    },
  })
  const capabilities = createNativeMenuCapabilities({
    runtime,
    source,
    start: async (sessionID, text) => {
      await ctx.session.synthetic({
        sessionID,
        text,
        description: 'Claude lane start',
        resume: true,
      })
    },
  })
  const registrations: Registration[] = []
  const installation = await installNativeAnthropic(
    ctx,
    {
      source,
      log: { warn: (message, data) => logger.warn('opencode2', message, data) },
    },
    { credential: preparedAnthropicCredential },
  ).catch((error: unknown) => {
    capabilities.close()
    source.close()
    runtime.close()
    throw error
  })
  let cleanup: Promise<void> | undefined
  const dispose = () => {
    if (cleanup) return cleanup
    active = false
    capabilities.close()
    source.close()
    cleanup = (async () => {
      await Promise.allSettled([
        installation.dispose(),
        lifecycle?.dispose(),
        prime?.dispose(),
        ...registrations.map((registration) => registration.dispose()),
      ])
      // Prime and transport teardown can finish attempts after source shutdown
      // begins. Join their advisory usage writes before closing the runtime.
      await source.close()
      runtime.close()
    })()
    return cleanup
  }
  try {
    registrations.push(await wire.install(ctx))
    registrations.push(await models.install(ctx))
    registrations.push(
      await registerOpenCode2AuthMethods(
        ctx,
        claudeLoginMethods({
          isActive: () => active,
          readMode: enrollment.readMode,
          runtime,
        }),
      ),
    )
    const ui: NativeUiOptions = {
      host: 'opencode',
      dispatch: capabilities.dispatch,
      readStatus: (command) => capabilities.readStatus(command),
      readAccounts: () => runtime.read(),
      readMode: enrollment.readMode,
      disconnectVault: enrollment.disconnectVault,
      interactive: true,
    }
    const command = createNativeUi(ui)
    registrations.push(await registerNativeMenu(ctx, command, capabilities))
    // Only a completed, explicit Claude-pool login selects the plugin's inert
    // OAuth connection. Startup never creates or replaces a host connection.
    return dispose
  } catch (error) {
    await dispose()
    throw error
  }
}
