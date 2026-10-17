import {
  createProcessFence,
  NativePiAuthSlotError,
  openNativePiAuthSlot,
  publishNativeEmptyInit,
  readNativeEnrollmentMode,
  releaseNativeMigrationPreflight,
  requireNoSupervisedAuthContentSnapshot,
  runSetup,
  type SetupCallbackContext,
  type SetupIO,
  type SetupPlugin,
} from '@cortexkit/anthropic-auth-core'
import { confirm } from '@cortexkit/common-auth/auth-menu'
import {
  knownFailureMessage,
  reportThrownFailure,
  setupEnrollmentOutcomes,
} from '../cli-failure.ts'
import { CLAUDE_POOL_LOGIN_STEP } from '../v2/activation.ts'
import { defaultCommandRunner } from './command-runner.ts'
import {
  completeNativeVaultActivation,
  fingerprintNativeVaultInputs,
  type NativeVaultPreflight,
  preflightNativeVaultForHost,
} from './native-activation.ts'
import {
  NATIVE_VAULT_HOST_NAMES,
  nativeVaultConnectionFile,
  nativeVaultHostPaths,
} from './native-enrollment.ts'
import {
  fingerprintNativeLocalPlan,
  inspectSetupHostAuth,
  installAbsentNativePlaceholder,
  migrateNativeLocalForHost,
  type NativeLocalPlan,
  nativeLocalProcessFence,
  planNativeLocalSetup,
  requireNativeLocalEnrollment,
  revalidateNativeLocalPlan,
  SEPARATE_HOST_LOGIN_NOTICE,
} from './native-local.ts'
import { loginNativeOffline } from './native-login.ts'
import {
  requireDisjointNativeSetupPaths,
  resolveNativeSetupPaths,
} from './native-paths.ts'
import {
  getSetupPackageVersion,
  OPENCODE_PACKAGE_NAME,
  PI_PACKAGE_NAME,
} from './paths.ts'
import { type HarnessKind, SetupRefusal, setupRefusalMessage } from './types.ts'

export interface SetupCommandOptions extends SetupIO {
  migrateLocal?: typeof migrateNativeLocalForHost
  localLogin?: typeof loginNativeOffline
  vaultPreflight?: typeof preflightNativeVaultForHost
  vaultActivate?: typeof completeNativeVaultActivation
}

const OPENCODE_VAULT_LOGIN_WARNING =
  'Warning: OpenCode holds a separate Anthropic OAuth login. Remove the separate OpenCode Anthropic login, then choose "Claude via credential vault". Setup has left that login unchanged.'

function hostPlan<Value>(
  plans: ReadonlyMap<HarnessKind, Value>,
  host: HarnessKind,
): Value {
  const plan = plans.get(host)
  if (!plan) throw new Error('Missing setup plan')
  return plan
}

export async function runSetupCommand(
  argv: string[] = [],
  options: SetupCommandOptions = {},
): Promise<number> {
  const env = { ...(options.env ?? process.env) }
  const terminal = options.terminal ?? {
    input: process.stdin,
    output: process.stdout,
    signals: process,
  }
  const print = (text: string) => terminal.output.write(`${text}\n`)
  const args = argv
    .filter((arg) => arg !== '--remove-pi-auth')
    .map((arg) => (arg === '-y' ? '--yes' : arg))
  const login = args.includes('--login')
  if (login && args.includes('--claustrum')) {
    print(
      'Local sign-in and vault setup are two separate choices. Use --login or --claustrum, not both.',
    )
    return 1
  }
  if (login && args.includes('--opencode=2')) {
    print(CLAUDE_POOL_LOGIN_STEP)
    return 1
  }
  const runner = options.runner ?? defaultCommandRunner
  const fence =
    options.fence ?? createProcessFence(runner, { platform: options.platform })
  const migrateLocal = options.migrateLocal ?? migrateNativeLocalForHost
  const local = new Map<HarnessKind, NativeLocalPlan>()
  const vault = new Map<HarnessKind, NativeVaultPreflight>()
  const paths = new Map<
    HarnessKind,
    Awaited<ReturnType<typeof resolveNativeSetupPaths>>
  >()
  const consent = new Map<HarnessKind, boolean>()
  let classified = false
  let phase: Parameters<typeof reportThrownFailure>[0] = 'setup-process-check'
  const localOptions = (host: HarnessKind) => ({
    env,
    fence,
    paths: paths.get(host),
    removePiAnthropicAuth: consent.get(host) ?? false,
  })
  const vaultOptions = (host: HarnessKind) => ({
    ...localOptions(host),
    runner,
  })

  async function piConsent(context: SetupCallbackContext) {
    if (!context.hosts.includes('pi')) return
    const plan = hostPlan(paths, 'pi')
    const entry = await inspectSetupHostAuth('pi', plan.hostAuthPath)
    if (entry.kind === 'absent') return
    {
      const slot = await openNativePiAuthSlot({
        env,
        authPath: plan.hostAuthPath,
      }).inspect()
      if (slot.slot === 'placeholder' && slot.stash === 'missing')
        throw new NativePiAuthSlotError('missing-stash')
      if (context.mode === 'claustrum') {
        if (slot.slot === 'placeholder') return
      }
    }
    if (argv.includes('--remove-pi-auth')) {
      consent.set('pi', true)
      return
    }
    const message =
      context.mode === 'claustrum'
        ? 'Pi has stored Anthropic authentication. Rerun with --remove-pi-auth to preserve it privately during vault use and restore it on disconnect.'
        : 'Pi has a stored Anthropic login. Rerun with --remove-pi-auth to move it into the native account pool.'
    if (args.includes('--yes') || !terminal.input.isTTY)
      throw new SetupRefusal(message)
    const answer = await confirm(
      terminal,
      context.mode === 'claustrum'
        ? 'Move Pi authentication aside privately for vault use, then restore it on disconnect?'
        : 'Move the Pi Anthropic OAuth login into the native account pool and remove its stored copy?',
    )
    if (!answer)
      throw new SetupRefusal(
        'Native account-pool setup cannot finish while the stored Pi OAuth token takes precedence.',
      )
    consent.set('pi', true)
  }

  async function revalidateVault(host: HarnessKind, enrolled: boolean) {
    const expected = hostPlan(vault, host)
    const mode = await readNativeEnrollmentMode(host, env)
    if (
      mode !== (enrolled ? 'claustrum' : expected.priorMode) ||
      (await fingerprintNativeVaultInputs(host, vaultOptions(host))) !==
        expected.fingerprint
    )
      throw new SetupRefusal(
        'Setup inputs changed. Rerun setup with all hosts stopped.',
      )
  }

  const plugin: SetupPlugin = {
    packages: { opencode: OPENCODE_PACKAGE_NAME, pi: PI_PACKAGE_NAME },
    version: await getSetupPackageVersion(),
    displayName: 'CortexKit Anthropic Auth',
    slashCommand: '/claude',
    vault: {
      connectionFile: nativeVaultConnectionFile(
        env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE &&
          !env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE
          ? 'pi'
          : 'opencode',
        env,
      ),
      hosts: {
        opencode: {
          name: NATIVE_VAULT_HOST_NAMES.opencode,
          paths: nativeVaultHostPaths('opencode', env),
        },
        pi: {
          name: NATIVE_VAULT_HOST_NAMES.pi,
          paths: nativeVaultHostPaths('pi', env),
        },
      },
    },
    async beforeSignIn(host, context) {
      phase = context.mode === 'claustrum' ? 'setup-activation' : 'cli-setup'
      if (!classified) {
        requireNoSupervisedAuthContentSnapshot(env)
        for (const selected of context.hosts)
          paths.set(selected, await resolveNativeSetupPaths(selected, env))
        await requireDisjointNativeSetupPaths([...paths.values()])
        if (context.mode === 'claustrum') {
          const files = context.hosts.map((selected) =>
            nativeVaultConnectionFile(selected, env),
          )
          const connectionFile = files[0]
          if (new Set(files).size !== 1 || !connectionFile)
            throw new SetupRefusal(
              'Selected hosts use different vault connection files.',
            )
          plugin.vault.connectionFile = connectionFile
        }
        if (
          context.mode === 'local' &&
          login &&
          context.hosts.includes('opencode') &&
          context.opencodeGeneration === '2'
        )
          throw new SetupRefusal(CLAUDE_POOL_LOGIN_STEP)
        if (context.mode === 'local') {
          await requireNativeLocalEnrollment(context.hosts, env)
          for (const selected of context.hosts)
            await nativeLocalProcessFence(selected, localOptions(selected))()
        }
        await piConsent(context)
        for (const selected of context.hosts) {
          if (context.mode === 'claustrum') {
            vault.set(
              selected,
              await (options.vaultPreflight ?? preflightNativeVaultForHost)(
                selected,
                {
                  ...vaultOptions(selected),
                  inspectOpenCodeAuth: context.opencodeGeneration !== '2',
                },
              ),
            )
            if (hostPlan(vault, selected).separateOpenCodeLogin)
              print(OPENCODE_VAULT_LOGIN_WARNING)
          } else {
            local.set(
              selected,
              await planNativeLocalSetup(
                selected,
                localOptions(selected),
                selected === 'opencode' && context.opencodeGeneration === '2',
              ),
            )
          }
        }
        classified = true
      } else if (context.mode === 'claustrum')
        await revalidateVault(host, false)
      else
        await revalidateNativeLocalPlan(
          hostPlan(local, host),
          localOptions(host),
        )
    },
    async signInLocal(host) {
      const plan = hostPlan(local, host)
      if (!login) {
        if (plan.generation2) print(CLAUDE_POOL_LOGIN_STEP)
        return
      }
      await revalidateNativeLocalPlan(plan, localOptions(host))
      await migrateLocal(host, {
        ...localOptions(host),
        login: options.localLogin ?? loginNativeOffline,
        preflight: plan.preflight,
        skipMigration: plan.action === 'skip',
        beforeCommit: () => revalidateNativeLocalPlan(plan, localOptions(host)),
      })
      plan.fingerprint = await fingerprintNativeLocalPlan(plan, env)
      if (plan.notice) print(SEPARATE_HOST_LOGIN_NOTICE)
    },
    async beforeRegister(host, mode) {
      if (mode === 'local')
        await revalidateNativeLocalPlan(
          hostPlan(local, host),
          localOptions(host),
        )
      else {
        await revalidateVault(host, true)
        await (options.vaultActivate ?? completeNativeVaultActivation)(
          host,
          vaultOptions(host),
          hostPlan(vault, host),
        )
        hostPlan(vault, host).fingerprint = await fingerprintNativeVaultInputs(
          host,
          vaultOptions(host),
        )
      }
    },
    async migrate(host, context) {
      if (context.mode === 'claustrum') {
        await revalidateVault(host, true)
        // runSetup prints fixed completion instructions with no plugin-supplied lines.
        // Repeat the login warning in its last callback to keep it near those instructions.
        if (
          host === context.hosts.at(-1) &&
          vault.get('opencode')?.separateOpenCodeLogin
        )
          print(OPENCODE_VAULT_LOGIN_WARNING)
        return
      }
      const plan = hostPlan(local, host)
      await revalidateNativeLocalPlan(plan, localOptions(host))
      if (login) return
      if (plan.action === 'migration')
        await migrateLocal(host, {
          ...localOptions(host),
          preflight: plan.preflight,
        })
      else if (plan.action === 'empty-init')
        await publishNativeEmptyInit({
          paths: plan.paths.paths,
          routingDestinationPath: plan.paths.routingDestinationPath,
          env,
          processFence: nativeLocalProcessFence(host, localOptions(host)),
        })
      else if (plan.action === 'skip') {
        await installAbsentNativePlaceholder(plan, localOptions(host))
        if (plan.notice) print(SEPARATE_HOST_LOGIN_NOTICE)
      }
      plan.fingerprint = await fingerprintNativeLocalPlan(plan, env)
    },
  }
  try {
    await runSetup(plugin, args, { ...options, env, terminal, runner, fence })
    return 0
  } catch (error) {
    const message = setupRefusalMessage(error) ?? knownFailureMessage(error)
    const text = message ?? (await reportThrownFailure(phase, error, env))
    if (text) print(text)
    // When it fails after vault enrollment began, runSetup has already printed
    // one status line per host (connected, not connected, or unknown) and
    // records the same outcomes for setupEnrollment. Only the undo and retry
    // steps for a host left connected are added here.
    for (const { host, outcome } of setupEnrollmentOutcomes(error) ?? []) {
      if (outcome !== 'enrolled') continue
      const name = host === 'opencode' ? 'OpenCode' : 'Pi'
      print(
        `${name} stays connected to the vault. In ${name}, run /claude → Accounts → Disconnect from the vault to undo it. Or run setup again to finish connecting.`,
      )
    }
    return 1
  } finally {
    for (const plan of local.values())
      if (plan.preflight) releaseNativeMigrationPreflight(plan.preflight)
  }
}
