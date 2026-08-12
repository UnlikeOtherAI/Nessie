#!/usr/bin/env node
import { claimExecutor, heartbeatExecutor, serveExecutor } from './daemon.js'
import {
  configureExecutorBrowserSandbox,
  configureExecutorCodexSandbox,
  configureExecutorLocalPolicy,
  pairExecutor,
} from './pair.js'
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
  | { kind: 'configure'; nativeHelperPath?: string; operationKeys: string[]; stateDir: string }
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

const usage = (): never => {
  throw new Error(
    'Usage: nessie-executor pair --api <https://api.example> --enrollment <uuid> '
    + '(--challenge <token>|--challenge-stdin) --state-dir <owner-only-path> '
    + '--workspace <absolute-read-only-root>\n'
    + '       nessie-executor pair --api <https://api.example> --enrollment <uuid> '
    + '--pair-input-stdin --state-dir <owner-only-path>\n'
    + '       nessie-executor configure --state-dir <owner-only-path> '
    + '--operations <file.list,file.read,file.write,browser.open,browser.observe,coding.launch,coding.observe,workspace.review,workspace.promote,sandbox.stop> '
    + '[--native-helper </absolute/owner-only/nessie-executor-native>]\n'
    + '       nessie-executor configure-browser --state-dir <owner-only-path> '
    + '--allowed-origins <https://origin.example,...> --guest-initrd-builder <absolute-owner-only-file> '
    + '--kernel <absolute-owner-only-file> --vm-helper <absolute-owner-only-file> '
    + '--runtime-bundle <absolute-owner-only-directory>\n'
    + '       nessie-executor configure-codex --state-dir <owner-only-path> '
    + '--auth-profile <absolute-owner-only-auth.json> --guest-initrd-builder <absolute-owner-only-file> '
    + '--kernel <absolute-owner-only-file> --vm-helper <absolute-owner-only-file> '
    + '--runtime-bundle <absolute-owner-only-directory>\n'
    + '       nessie-executor connect|heartbeat|serve --state-dir <owner-only-path>',
  )
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
    return {
      kind: 'configure',
      ...(args.includes('--native-helper') ? { nativeHelperPath: option(args, '--native-helper') } : {}),
      operationKeys: option(args, '--operations').split(',').map((value) => value.trim()),
      stateDir: option(args, '--state-dir'),
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
  const state = await loadExecutorState(command.stateDir)
  if (command.kind === 'configure') {
    const updated = await configureExecutorLocalPolicy(
      command.stateDir,
      state,
      command.operationKeys,
      command.nativeHelperPath,
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
