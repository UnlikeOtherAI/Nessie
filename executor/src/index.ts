#!/usr/bin/env node
import { dirname } from 'node:path'

import { approveExecutorPairingOrigin } from '@nessie/schemas'

import { claimExecutor, heartbeatExecutor } from './daemon.js'
import { serveExecutor } from './daemon-server.js'
import { describeExecutor } from './describe.js'
import { serveDeepTestSourceAdapter } from './deeptest-source-adapter.js'
import { serveDeepTestExecutionAdapter } from './deeptest-execution-adapter.js'
import { serveBrowserCookieImportNativeHost } from './browser-cookie-import-native-host.js'
import { executorApi } from './api-client.js'
import { signExecutorLocalInferenceConsent } from './local-inference-consent.js'
import { connectExecutorLocalInference } from './local-inference-runtime.js'
import {
  fetchDirectLocalInferenceConsentDisplay,
  readDirectLocalInferenceConsentRequest,
  serveDirectLocalInference,
} from './direct-local-inference-runtime.js'
import {
  configureExecutorBrowserSandbox,
  configureExecutorCodexSandbox,
  configureExecutorLocalPolicy,
  pairExecutor,
} from './pair.js'
import {
  assertPackagedExecutorRuntime,
  EXECUTOR_PACKAGED_BUNDLE_FILE,
} from './runtime-integrity.js'
import {
  disableExecutorService,
  enableExecutorService,
  executorServiceStatus,
} from './service-linux.js'
import {
  parseExecutorWorkspaceFolderArguments,
  workspaceFoldersFromInput,
  type ExecutorWorkspaceFolder,
} from './workspace-folder-arguments.js'
import { parseExecutorMcpServerArguments } from './mcp-server-arguments.js'
import type { ExecutorLocalMcpServer } from './mcp-servers.js'
import {
  loadExecutorDeepTestSourceGrant,
  loadExecutorDeepTestExecutionGrant,
  loadExecutorState,
  loadExecutorStatesFromRoot,
  publishExecutorDeepTestSourceGrant,
  publishExecutorDeepTestExecutionGrant,
  revokeExecutorDeepTestExecutionGrant,
} from './state-store.js'

type ParsedCommand =
  | {
    kind: 'pair'
    apiBaseUrl: string
    challenge?: string
    challengeFromStandardInput?: true
    enrollmentId: string
    pairingInputFromStandardInput?: true
    stateDir: string
    workspaceFolders?: ExecutorWorkspaceFolder[]
  }
  | {
    configurationInputFromStandardInput?: true
    /** Absent keeps the permitted programs; `[]` clears them. */
    commandAllowlist?: string[]
    kind: 'configure'
    /** Absent keeps the named MCP servers; `[]` removes them all. */
    mcpServers?: ExecutorLocalMcpServer[]
    nativeHelperPath?: string
    operationKeys?: string[]
    stateDir: string
    workspaceFolders?: ExecutorWorkspaceFolder[]
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
  | { kind: 'serve-direct-local-inference' }
  | { kind: 'local-inference-consent-display' }
  | { bindingId: string; challengeId: string; kind: 'local-inference-confirm'; stateDir: string }
  | { kind: 'describe'; stateDir: string }
  | { kind: 'deeptest-source'; sourceGrantFile: string }
  | { executionGrantFile: string; kind: 'deeptest-execution' }
  | { kind: 'heartbeat'; stateDir: string }
  | {
    callerOrigin: string
    expectedExtensionOrigin: string
    kind: 'native-browser-cookie-import'
    requireDevelopmentLocalApi: boolean
    stateRoot: string
  }
  | { kind: 'serve'; parentLivenessFromStandardInput?: true; stateDir: string }
  | { kind: 'publish-deeptest-source-grant'; stateDir: string }
  | { kind: 'publish-deeptest-execution-grant'; stateDir: string }
  | { kind: 'revoke-deeptest-execution-grant'; stateDir: string }
  | { assumeYes: boolean; executorId: string; kind: 'enable'; stateDir?: string }
  | { executorId: string; kind: 'disable' }
  | { executorId?: string; kind: 'status'; stateRoot?: string }

/**
 * What a person sees when they run the packaged bundle by hand. It names the
 * marker and the supported way in, because the two callers who hit this are a
 * hand-written autostart script and somebody debugging one.
 */
export const UNMARKED_BUNDLE_MESSAGE =
  `${EXECUTOR_PACKAGED_BUNDLE_FILE} ran no command: it is the packaged executor CLI and `
  + 'must be started by its package, which sets NESSIE_EXECUTOR_PACKAGED_CLI=1. '
  + 'Start the executor through its installed service, menu bar app or tray; to run this '
  + 'bundle directly, set that variable first.'

const usage = (): never => {
  throw new Error(
    'Usage: nessie-executor pair --api <nessie|deeptest|https://your-nessie.example> --enrollment <uuid> '
    + '(--challenge <token>|--challenge-stdin) --state-dir <owner-only-path> '
    + '(--workspace <absolute-read-only-root>'
    + '|--folder <name>=<absolute-read-only-root> [--folder ...])\n'
    + '       nessie-executor pair --api <nessie|deeptest|https://your-nessie.example> --enrollment <uuid> '
    + '--pair-input-stdin --state-dir <owner-only-path>\n'
    + '       nessie-executor configure --state-dir <owner-only-path> '
    + '--operations <file.list,file.read,file.write,command.run,browser.open,browser.observe,'
    + 'browser.act,coding.launch,coding.observe,workspace.review,workspace.promote,sandbox.stop,'
    + 'mcp.tools,mcp.call> '
    + '[--native-helper </absolute/owner-only/nessie-executor-native>] '
    + '[--workspace <absolute-read-only-root>'
    + '|--folder <name>=<absolute-read-only-root> [--folder ...]] '
    + '[--tools <program,program,...>|--clear-tools] '
    + '[--mcp-server <name>=<command and arguments> [--mcp-server ...]|--clear-mcp-servers]\n'
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
    + '       nessie-executor serve-direct-local-inference --config-stdin\n'
    + '       nessie-executor local-inference-consent-display --config-stdin\n'
    + '       nessie-executor local-inference-confirm --state-dir <owner-only-path> --challenge <uuid> --binding <uuid>\n'
    + '       nessie-executor describe --state-dir <owner-only-path>\n'
    + '       nessie-executor deeptest-source --source-grant-file <absolute-owner-only-file>\n'
    + '       nessie-executor deeptest-execution --execution-grant-file <absolute-owner-only-file>\n'
    + '       nessie-executor publish-deeptest-source-grant --state-dir <owner-only-path>\n'
    + '       nessie-executor publish-deeptest-execution-grant --state-dir <owner-only-path> --confirm-active-testing\n'
    + '       nessie-executor revoke-deeptest-execution-grant --state-dir <owner-only-path>\n'
    + '       nessie-executor native-browser-cookie-import --state-root <owner-only-path> '
    + '--extension-origin <chrome-extension://release-id/> --caller-origin <chrome-extension://release-id/>\n'
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

const readPairingInput = async (): Promise<{
  challenge: string
  workspaceFolders: ExecutorWorkspaceFolder[]
}> => {
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
    || !(parsed as { challenge: string }).challenge
  ) {
    throw new Error('Pairing input on standard input is malformed.')
  }
  return {
    challenge: (parsed as { challenge: string }).challenge,
    workspaceFolders: workspaceFoldersFromInput(parsed, 'Pairing input on standard input'),
  }
}

const readConfigurationInput = async (): Promise<{
  commandAllowlist?: string[]
  mcpServers?: ExecutorLocalMcpServer[]
  operationKeys: string[]
  workspaceFolders: ExecutorWorkspaceFolder[]
}> => {
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
  const allowlist = (parsed as { commandAllowlist?: unknown }).commandAllowlist
  const servers = (parsed as { mcpServers?: unknown }).mcpServers
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !Array.isArray((parsed as { operationKeys?: unknown }).operationKeys)
    || !(parsed as { operationKeys: unknown[] }).operationKeys.every((key) => typeof key === 'string')
    // Absent keeps the permitted programs the policy already names; present it
    // must be a list of names, and `[]` is the instruction to clear them.
    || (allowlist !== undefined && (
      !Array.isArray(allowlist) || !allowlist.every((program) => typeof program === 'string')
    ))
    // Same reading as the allowlist: absent keeps the named servers, `[]`
    // removes them all. The shape is checked only far enough to hand it to
    // `assertExecutorLocalMcpServers`, which owns every real rule.
    || (servers !== undefined && (
      !Array.isArray(servers) || !servers.every((server) => (
        Boolean(server)
        && typeof server === 'object'
        && !Array.isArray(server)
        && typeof (server as { name?: unknown }).name === 'string'
        && Array.isArray((server as { command?: unknown }).command)
      ))
    ))
  ) {
    throw new Error('Local policy input on standard input is malformed.')
  }
  return {
    ...(allowlist === undefined ? {} : { commandAllowlist: allowlist as string[] }),
    ...(servers === undefined ? {} : { mcpServers: servers as ExecutorLocalMcpServer[] }),
    operationKeys: (parsed as { operationKeys: string[] }).operationKeys,
    workspaceFolders: workspaceFoldersFromInput(parsed, 'Local policy input on standard input'),
  }
}

/**
 * Which Nessie this executor is being paired with. `nessie` and `deeptest`
 * resolve to their pinned origins so the common cases cannot be typo-squatted;
 * anything else is somebody's own server, which Nessie being open source makes
 * an ordinary case rather than an exception. The rule itself lives in
 * `@nessie/schemas` so the CLI, the Mac app and the Windows tray cannot drift
 * into three readings of it.
 */
const secureApiUrl = (value: string): string => {
  const configuredPort = process.env.NESSIE_API_PORT?.trim()
  const localDevelopmentOrigin = configuredPort === undefined || configuredPort === ''
    ? 'http://127.0.0.1:5454'
    : (() => {
      const port = Number(configuredPort)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(
          `NESSIE_API_PORT must be a port number between 1 and 65535, got "${configuredPort}"`,
        )
      }
      return `http://127.0.0.1:${port}`
    })()
  const verdict = approveExecutorPairingOrigin(value, {
    allowLocalDevelopment: process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API === '1',
    localDevelopmentOrigin,
  })
  if (!verdict.ok) throw new Error(verdict.reason)
  return verdict.origin
}

export const parseCommand = (args: string[]): ParsedCommand => {
  const [command] = args
  if (command === 'pair') {
    const pairingInputFromStandardInput = args.includes('--pair-input-stdin')
    if (pairingInputFromStandardInput && (
      args.includes('--challenge')
      || args.includes('--challenge-stdin')
      || args.includes('--workspace')
      || args.includes('--folder')
    )) return usage()
    return {
      apiBaseUrl: secureApiUrl(option(args, '--api')),
      enrollmentId: option(args, '--enrollment'),
      kind: 'pair',
      stateDir: option(args, '--state-dir'),
      ...(pairingInputFromStandardInput
        ? { pairingInputFromStandardInput: true }
        : { workspaceFolders: parseExecutorWorkspaceFolderArguments(args, true), ...pairingChallenge(args) }),
    }
  }
  if (command === 'configure') {
    const configurationInputFromStandardInput = args.includes('--configuration-input-stdin')
    if (configurationInputFromStandardInput && (
      args.includes('--operations')
      || args.includes('--workspace')
      || args.includes('--folder')
      || args.includes('--native-helper')
      || args.includes('--tools')
      || args.includes('--clear-tools')
      || args.includes('--mcp-server')
      || args.includes('--clear-mcp-servers')
    )) return usage()
    // Naming programs and clearing them are opposite instructions; a call that
    // carries both says nothing this command may act on.
    if (args.includes('--tools') && args.includes('--clear-tools')) return usage()
    return {
      ...(configurationInputFromStandardInput ? { configurationInputFromStandardInput: true } : {}),
      ...(!configurationInputFromStandardInput && args.includes('--tools')
        ? { commandAllowlist: option(args, '--tools').split(',').map((value) => value.trim()) }
        : {}),
      ...(!configurationInputFromStandardInput && args.includes('--clear-tools')
        ? { commandAllowlist: [] }
        : {}),
      kind: 'configure',
      ...(!configurationInputFromStandardInput && args.includes('--native-helper')
        ? { nativeHelperPath: option(args, '--native-helper') }
        : {}),
      ...(!configurationInputFromStandardInput
        ? { operationKeys: option(args, '--operations').split(',').map((value) => value.trim()) }
        : {}),
      stateDir: option(args, '--state-dir'),
      ...(!configurationInputFromStandardInput
        ? (() => {
          const folders = parseExecutorWorkspaceFolderArguments(args, false)
          return folders ? { workspaceFolders: folders } : {}
        })()
        : {}),
      ...(!configurationInputFromStandardInput
        ? (() => {
          const servers = parseExecutorMcpServerArguments(args)
          return servers ? { mcpServers: servers } : {}
        })()
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
  if (command === 'describe') {
    return { kind: 'describe', stateDir: option(args, '--state-dir') }
  }
  if (command === 'connect' || command === 'heartbeat') {
    return { kind: command, stateDir: option(args, '--state-dir') }
  }
  if (command === 'serve-direct-local-inference') {
    if (!args.includes('--config-stdin') || args.length !== 2) return usage()
    return { kind: command }
  }
  if (command === 'local-inference-consent-display') {
    if (!args.includes('--config-stdin') || args.length !== 2) return usage()
    return { kind: command }
  }
  if (command === 'local-inference-confirm') {
    return {
      bindingId: option(args, '--binding'),
      challengeId: option(args, '--challenge'),
      kind: command,
      stateDir: option(args, '--state-dir'),
    }
  }
  if (command === 'deeptest-source') {
    return { kind: command, sourceGrantFile: option(args, '--source-grant-file') }
  }
  if (command === 'deeptest-execution') {
    return { executionGrantFile: option(args, '--execution-grant-file'), kind: command }
  }
  if (command === 'publish-deeptest-source-grant') {
    return { kind: command, stateDir: option(args, '--state-dir') }
  }
  if (command === 'publish-deeptest-execution-grant') {
    if (!args.includes('--confirm-active-testing')) return usage()
    return { kind: command, stateDir: option(args, '--state-dir') }
  }
  if (command === 'revoke-deeptest-execution-grant') {
    return { kind: command, stateDir: option(args, '--state-dir') }
  }
  if (command === 'native-browser-cookie-import') {
    return {
      callerOrigin: option(args, '--caller-origin'),
      expectedExtensionOrigin: option(args, '--extension-origin'),
      kind: command,
      requireDevelopmentLocalApi: args.includes('--development-local-api'),
      stateRoot: option(args, '--state-root'),
    }
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
        workspaceFolders: command.workspaceFolders!,
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
  if (command.kind === 'native-browser-cookie-import') {
    await serveBrowserCookieImportNativeHost({
      callerOrigin: command.callerOrigin,
      expectedExtensionOrigin: command.expectedExtensionOrigin,
      requireDevelopmentLocalApi: command.requireDevelopmentLocalApi,
      states: await loadExecutorStatesFromRoot(command.stateRoot),
    })
    return
  }
  if (command.kind === 'publish-deeptest-source-grant') {
    const grantPath = await publishExecutorDeepTestSourceGrant(command.stateDir)
    process.stdout.write(`${grantPath}\n`)
    return
  }
  if (command.kind === 'publish-deeptest-execution-grant') {
    process.stdout.write(`${await publishExecutorDeepTestExecutionGrant(command.stateDir, { activeTesting: true })}\n`)
    return
  }
  if (command.kind === 'revoke-deeptest-execution-grant') {
    await revokeExecutorDeepTestExecutionGrant(command.stateDir)
    return
  }
  if (command.kind === 'deeptest-source') {
    await assertPackagedExecutorRuntime()
    const grant = await loadExecutorDeepTestSourceGrant(command.sourceGrantFile)
    await serveDeepTestSourceAdapter(
      grant,
      process.stdin,
      process.stdout,
      () => loadExecutorDeepTestSourceGrant(command.sourceGrantFile),
    )
    return
  }
  if (command.kind === 'deeptest-execution') {
    await assertPackagedExecutorRuntime()
    const grant = await loadExecutorDeepTestExecutionGrant(command.executionGrantFile)
    await serveDeepTestExecutionAdapter(
      dirname(command.executionGrantFile),
      grant,
      process.stdin,
      process.stdout,
      () => loadExecutorDeepTestExecutionGrant(command.executionGrantFile),
    )
    return
  }
  if (command.kind === 'serve-direct-local-inference') {
    await assertPackagedExecutorRuntime()
    await serveDirectLocalInference()
    return
  }
  if (command.kind === 'local-inference-consent-display') {
    await assertPackagedExecutorRuntime()
    process.stdout.write(`${JSON.stringify(await fetchDirectLocalInferenceConsentDisplay(
      await readDirectLocalInferenceConsentRequest(),
    ))}\n`)
    return
  }
  const state = await loadExecutorState(command.stateDir)
  if (command.kind === 'configure') {
    const input = command.configurationInputFromStandardInput
      ? await readConfigurationInput()
      : {
        commandAllowlist: command.commandAllowlist,
        mcpServers: command.mcpServers,
        operationKeys: command.operationKeys!,
        workspaceFolders: command.workspaceFolders,
      }
    const updated = await configureExecutorLocalPolicy(
      command.stateDir,
      state,
      input.operationKeys,
      command.nativeHelperPath,
      undefined,
      input.workspaceFolders,
      input.commandAllowlist,
      input.mcpServers,
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
  if (command.kind === 'describe') {
    process.stdout.write(`${JSON.stringify(describeExecutor(state), undefined, 2)}\n`)
    return
  }
  if (command.kind === 'connect') {
    const live = await claimExecutor(command.stateDir, state)
    await connectExecutorLocalInference(command.stateDir, live)
    process.stdout.write('Executor and local inference daemon connections established.\n')
    return
  }
  if (command.kind === 'local-inference-confirm') {
    if (!state.localInference) {
      throw new Error('Connect the executor before confirming local inference consent.')
    }
    const signature = signExecutorLocalInferenceConsent({
      bindingId: command.bindingId,
      challengeId: command.challengeId,
      hostId: state.localInference.hostId,
      machinePrivateKey: state.machinePrivateKey,
    })
    await executorApi.confirmLocalInference(state.apiBaseUrl, state.localInference.hostId, {
      challengeId: command.challengeId,
      signature,
    })
    process.stdout.write('Local inference consent confirmed. Save the Agent Designer change to activate it.\n')
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

/**
 * Whether this process was started to *be* the CLI, as opposed to importing it.
 *
 * The source entry is `index.js`/`index.ts`. The packaged bundle is
 * `nessie-executor.cjs`, which neither name matches, so the package marks
 * itself with `NESSIE_EXECUTOR_PACKAGED_CLI` — the same marker
 * `spawnPackagedStateSecurityHelper` requires before it will run the native
 * helper, because it asserts "this process is the installed package", not
 * merely "this process is an entry point". It is therefore never something
 * this file may set on its own behalf.
 */
export const executorCliEntry = (
  invokedPath: string | undefined,
  packagedMarker: string | undefined,
): 'run' | 'unmarked-bundle' | 'imported' => {
  if (invokedPath?.endsWith('index.js') || invokedPath?.endsWith('index.ts')) return 'run'
  if (packagedMarker === '1') return 'run'
  // Being named as argv[1] means a person or a script asked this file to do
  // something. Without the marker it cannot, and exiting 0 in silence — the
  // old behaviour — is indistinguishable from a daemon that started and
  // detached. An autostart script built that way leaves a machine with no
  // executor and no evidence of why.
  if (invokedPath?.endsWith(EXECUTOR_PACKAGED_BUNDLE_FILE)) return 'unmarked-bundle'
  return 'imported'
}

const entry = executorCliEntry(process.argv[1], process.env.NESSIE_EXECUTOR_PACKAGED_CLI)
if (entry === 'run') {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
} else if (entry === 'unmarked-bundle') {
  process.stderr.write(`${UNMARKED_BUNDLE_MESSAGE}\n`)
  process.exitCode = 1
}
