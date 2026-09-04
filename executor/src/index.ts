#!/usr/bin/env node
import { claimExecutor, heartbeatExecutor, serveExecutor } from './daemon.js'
import {
  configureExecutorBrowserSandbox,
  configureExecutorCodexSandbox,
  configureExecutorLocalPolicy,
  pairExecutor,
} from './pair.js'
import { assertPackagedExecutorRuntime } from './runtime-integrity.js'
import {
  disableExecutorService,
  enableExecutorService,
  executorServiceStatus,
} from './service-linux.js'
import { loadExecutorState } from './state-store.js'

type ParsedCommand =
  | {
    kind: 'pair'
    apiBaseUrl: string
    challenge?: string
    challengeFromStandardInput?: true
    enrollmentId: string
    pairingInputFromStandardInput?: true
    stateDir: string
    workspaceRoot?: string
  }
  | {
    configurationInputFromStandardInput?: true
    kind: 'configure'
    nativeHelperPath?: string
    operationKeys?: string[]
    stateDir: string
    workspaceRoot?: string
  }
  | {
    allowedOrigins: string[]
    guestInitrdBuilderPath: string
    guestRuntimeBundlePath: string
    kernelPath: string
    kind: 'configure-browser'
    stateDir: string
    vmHelperPath: string
  }
  | {
    codexAuthProfilePath: string
    guestInitrdBuilderPath: string
    guestRuntimeBundlePath: string
    kernelPath: string
    kind: 'configure-codex'
    stateDir: string
    vmHelperPath: string
  }
  | { kind: 'connect'; stateDir: string }
  | { kind: 'heartbeat'; stateDir: string }
  | { kind: 'serve'; parentLivenessFromStandardInput?: true; stateDir: string }
  | { assumeYes: boolean; executorId: string; kind: 'enable'; stateDir?: string }
  | { executorId: string; kind: 'disable' }
  | { executorId?: string; kind: 'status'; stateRoot?: string }

const usage = (): never => {
  throw new Error(
    'Usage: nessie-executor pair --api <https://api.example> --enrollment <uuid> '
    + '(--challenge <token>|--challenge-stdin) --state-dir <owner-only-path> '
    + '--workspace <absolute-read-only-root>\n'
    + '       nessie-executor pair --api <https://api.example> --enrollment <uuid> '
    + '--pair-input-stdin --state-dir <owner-only-path>\n'
    + '       nessie-executor configure --state-dir <owner-only-path> '
    + '--operations <file.list,file.read,file.write,command.run,browser.open,browser.observe,'
    + 'browser.act,coding.launch,coding.observe,workspace.review,workspace.promote,sandbox.stop> '
    + '[--native-helper </absolute/owner-only/nessie-executor-native>] '
    + '[--workspace <absolute-read-only-root>]\n'
    + '       nessie-executor configure --configuration-input-stdin '
    + '--state-dir <owner-only-path>\n'
    + '       nessie-executor configure-browser --state-dir <owner-only-path> '
    + '--allowed-origins <https://origin.example,...> --guest-initrd-builder <absolute-owner-only-file> '
    + '--kernel <absolute-owner-only-file> --vm-helper <absolute-owner-only-file> '
    + '--runtime-bundle <absolute-owner-only-directory>\n'
    + '       nessie-executor configure-codex --state-dir <owner-only-path> '
    + '--auth-profile <absolute-owner-only-auth.json> --guest-initrd-builder <absolute-owner-only-file> '
    + '--kernel <absolute-owner-only-file> --vm-helper <absolute-owner-only-file> '
    + '--runtime-bundle <absolute-owner-only-directory>\n'
    + '       nessie-executor connect|heartbeat|serve --state-dir <owner-only-path>\n'
    + '       nessie-executor enable <executorId> [--state-dir <owner-only-path>] [--yes]\n'
    + '       nessie-executor disable <executorId>\n'
    + '       nessie-executor status [<executorId>] [--state-root <owner-only-path>]',
  )
}

const positional = (args: string[]): string => {
  const value = args[1]
  if (!value || value.startsWith('--')) return usage()
  return value
}

const option = (args: string[], name: string): string => {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) return usage()
  return value
}

const pairingChallenge = (args: string[]): Pick<Extract<ParsedCommand, { kind: 'pair' }>, 'challenge' | 'challengeFromStandardInput'> => {
  const standardInput = args.includes('--challenge-stdin')
  const commandLine = args.includes('--challenge')
  if (standardInput === commandLine) return usage()
  return standardInput ? { challengeFromStandardInput: true } : { challenge: option(args, '--challenge') }
}

const readPairingChallenge = async (): Promise<string> => {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > 8_192) throw new Error('Pairing challenge is too large.')
    chunks.push(bytes)
  }
  const challenge = Buffer.concat(chunks).toString('utf8').trim()
  if (!challenge) throw new Error('Pairing challenge is required on standard input.')
  return challenge
}

const readPairingInput = async (): Promise<{ challenge: string; workspaceRoot: string }> => {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > 12_288) throw new Error('Pairing input is too large.')
    chunks.push(bytes)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Pairing input on standard input is malformed.')
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || typeof (parsed as { challenge?: unknown }).challenge !== 'string'
    || typeof (parsed as { workspaceRoot?: unknown }).workspaceRoot !== 'string'
    || !(parsed as { challenge: string }).challenge
    || !(parsed as { workspaceRoot: string }).workspaceRoot
  ) {
    throw new Error('Pairing input on standard input is malformed.')
  }
  return parsed as { challenge: string; workspaceRoot: string }
}

const readConfigurationInput = async (): Promise<{ operationKeys: string[]; workspaceRoot: string }> => {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > 12_288) throw new Error('Local policy input is too large.')
    chunks.push(bytes)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Local policy input on standard input is malformed.')
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !Array.isArray((parsed as { operationKeys?: unknown }).operationKeys)
    || !(parsed as { operationKeys: unknown[] }).operationKeys.every((key) => typeof key === 'string')
    || typeof (parsed as { workspaceRoot?: unknown }).workspaceRoot !== 'string'
    || !(parsed as { workspaceRoot: string }).workspaceRoot
  ) {
    throw new Error('Local policy input on standard input is malformed.')
  }
  return parsed as { operationKeys: string[]; workspaceRoot: string }
}

const secureApiUrl = (value: string): string => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('--api must be an HTTPS URL.')
  }
  const localDesktopDevelopmentApi = process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API === '1'
    && parsed.protocol === 'http:'
    && parsed.hostname === '127.0.0.1'
    && parsed.port === '5454'
  if (parsed.protocol !== 'https:' && !localDesktopDevelopmentApi) {
    throw new Error('--api must be an HTTPS URL.')
  }
  return parsed.toString().replace(/\/$/, '')
}

export const parseCommand = (args: string[]): ParsedCommand => {
  const [command] = args
  if (command === 'pair') {
    const pairingInputFromStandardInput = args.includes('--pair-input-stdin')
    if (pairingInputFromStandardInput && (args.includes('--challenge') || args.includes('--challenge-stdin') || args.includes('--workspace'))) {
      return usage()
    }
    return {
      apiBaseUrl: secureApiUrl(option(args, '--api')),
      enrollmentId: option(args, '--enrollment'),
      kind: 'pair',
      stateDir: option(args, '--state-dir'),
      ...(pairingInputFromStandardInput
        ? { pairingInputFromStandardInput: true }
        : { workspaceRoot: option(args, '--workspace'), ...pairingChallenge(args) }),
    }
  }
  if (command === 'configure') {
    const configurationInputFromStandardInput = args.includes('--configuration-input-stdin')
    if (configurationInputFromStandardInput && (
      args.includes('--operations')
      || args.includes('--workspace')
      || args.includes('--native-helper')
    )) return usage()
    return {
      ...(configurationInputFromStandardInput ? { configurationInputFromStandardInput: true } : {}),
      kind: 'configure',
      ...(!configurationInputFromStandardInput && args.includes('--native-helper')
        ? { nativeHelperPath: option(args, '--native-helper') }
        : {}),
      ...(!configurationInputFromStandardInput
        ? { operationKeys: option(args, '--operations').split(',').map((value) => value.trim()) }
        : {}),
      stateDir: option(args, '--state-dir'),
      ...(!configurationInputFromStandardInput && args.includes('--workspace')
        ? { workspaceRoot: option(args, '--workspace') }
        : {}),
    }
  }
  if (command === 'configure-browser') {
    return {
      allowedOrigins: option(args, '--allowed-origins').split(',').map((value) => value.trim()),
      guestInitrdBuilderPath: option(args, '--guest-initrd-builder'),
      guestRuntimeBundlePath: option(args, '--runtime-bundle'),
      kernelPath: option(args, '--kernel'),
      kind: 'configure-browser',
      stateDir: option(args, '--state-dir'),
      vmHelperPath: option(args, '--vm-helper'),
    }
  }
  if (command === 'configure-codex') {
    return {
      codexAuthProfilePath: option(args, '--auth-profile'),
      guestInitrdBuilderPath: option(args, '--guest-initrd-builder'),
      guestRuntimeBundlePath: option(args, '--runtime-bundle'),
      kernelPath: option(args, '--kernel'),
      kind: 'configure-codex',
      stateDir: option(args, '--state-dir'),
      vmHelperPath: option(args, '--vm-helper'),
    }
  }
  if (command === 'connect' || command === 'heartbeat') {
    return { kind: command, stateDir: option(args, '--state-dir') }
  }
  if (command === 'enable') {
    return {
      assumeYes: args.includes('--yes'),
      executorId: positional(args),
      kind: 'enable',
      ...(args.includes('--state-dir') ? { stateDir: option(args, '--state-dir') } : {}),
    }
  }
  if (command === 'disable') {
    return { executorId: positional(args), kind: 'disable' }
  }
  if (command === 'status') {
    const named = args[1] !== undefined && !args[1].startsWith('--')
    return {
      ...(named ? { executorId: positional(args) } : {}),
      kind: 'status',
      ...(args.includes('--state-root') ? { stateRoot: option(args, '--state-root') } : {}),
    }
  }
  if (command === 'serve') {
    return {
      kind: 'serve',
      ...(args.includes('--parent-liveness-stdin') ? { parentLivenessFromStandardInput: true } : {}),
      stateDir: option(args, '--state-dir'),
    }
  }
  return usage()
}

export const run = async (args: string[]): Promise<void> => {
  const command = parseCommand(args)
  if (command.kind === 'pair') {
    const input = command.pairingInputFromStandardInput
      ? await readPairingInput()
      : {
        challenge: command.challenge ?? await readPairingChallenge(),
        workspaceRoot: command.workspaceRoot!,
      }
    const paired = await pairExecutor({
      ...command,
      ...input,
    })
    process.stdout.write(
      `Pairing request submitted. Confirm fingerprint ${paired.fingerprint} in Nessie, then run connect.\n`,
    )
    return
  }
  if (command.kind === 'enable') {
    await enableExecutorService(command)
    return
  }
  if (command.kind === 'disable') {
    await disableExecutorService(command)
    return
  }
  if (command.kind === 'status') {
    await executorServiceStatus(command)
    return
  }
  const state = await loadExecutorState(command.stateDir)
  if (command.kind === 'configure') {
    const input = command.configurationInputFromStandardInput
      ? await readConfigurationInput()
      : { operationKeys: command.operationKeys!, workspaceRoot: command.workspaceRoot }
    const updated = await configureExecutorLocalPolicy(
      command.stateDir,
      state,
      input.operationKeys,
      command.nativeHelperPath,
      undefined,
      input.workspaceRoot,
    )
    process.stdout.write(
      `Local policy proposal saved as revision ${updated.descriptor.revision}. `
      + 'Run connect (or restart serve), then have a person review it in Nessie.\n',
    )
    return
  }
  if (command.kind === 'configure-browser') {
    const updated = await configureExecutorBrowserSandbox(command.stateDir, state, command)
    process.stdout.write(
      `Browser sandbox proposal saved as revision ${updated.descriptor.revision}. `
      + 'Run connect (or restart serve), then have a person review it in Nessie.\n',
    )
    return
  }
  if (command.kind === 'configure-codex') {
    const updated = await configureExecutorCodexSandbox(command.stateDir, state, command)
    process.stdout.write(
      `Codex session policy saved as revision ${updated.descriptor.revision}. Run connect (or restart serve), then have a person review it in Nessie.\n`,
    )
    return
  }
  if (command.kind === 'connect') {
    await claimExecutor(command.stateDir, state)
    process.stdout.write('Executor daemon connection established.\n')
    return
  }
  if (command.kind === 'heartbeat') {
    await heartbeatExecutor(state)
    process.stdout.write('Executor heartbeat accepted.\n')
    return
  }
  // A packaged daemon proves its release integrity before it serves anything;
  // outside a package this is a no-op (see runtime-integrity.ts).
  await assertPackagedExecutorRuntime()
  await serveExecutor(command.stateDir, state, {
    ...(command.parentLivenessFromStandardInput ? { parentLiveness: process.stdin } : {}),
  })
}

if (
  process.argv[1]?.endsWith('index.js')
  || process.argv[1]?.endsWith('index.ts')
  || process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'
) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
