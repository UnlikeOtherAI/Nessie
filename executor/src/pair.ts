import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'node:crypto'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS,
  ExecutorEnrollmentRequestSchema,
  ImplementedExecutorOperationKeySchema,
  type ExecutorEnrollmentRequest,
  type ExecutorSignedDescriptor,
} from '@nessie/schemas'

import { executorApi } from './api-client.js'
import { assertHostSupportsOperations, buildSignedDescriptor } from './descriptor.js'
import { compileExecutorEgressPolicy } from './egress-policy.js'
import { verifyPrivateCodexAuthProfile, verifyPrivateGuestVmFile } from './guest-vm-artifacts.js'
import { verifyGuestRuntimeBundle } from './guest-runtime-bundle.js'
import { detectExecutorHost, type ExecutorHost } from './host-platform.js'
import { verifyNativeHelperPath } from './native-helper.js'
import {
  clearExecutorPreparedPairing,
  loadExecutorPreparedPairing,
  saveExecutorPreparedPairing,
  saveExecutorState,
  type ExecutorBrowserSandboxConfig,
  type ExecutorCodexSandboxConfig,
  type ExecutorLocalState,
  type ExecutorPreparedPairing,
} from './state-store.js'
import { configureWorkspaceRoot } from './workspace.js'

const rawEd25519PublicKey = (publicKey: KeyObject): string =>
  publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')

export type PairExecutorInput = {
  apiBaseUrl: string
  challenge: string
  enrollmentId: string
  stateDir: string
  workspaceRoot: string
}

/** The daemon-owned copy-on-write bundle, named once in `@nessie/schemas`. */
export const COW_WORKSPACE_OPERATION_KEYS = EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS

const PROMOTION_OPERATION_KEY = 'workspace.promote' as const
export const BROWSER_OPERATION_KEYS = ['browser.open', 'browser.observe', 'browser.act'] as const
// Do not advertise the connected-Chrome daemon backend until the API/worker
// proves an interactive owner-private run and records observation provenance.
// Keeping this deny here makes an incomplete control-plane integration inert.
const CONNECTED_BROWSER_OPERATION_KEYS = [
  'browser.connected.open',
  'browser.connected.observe',
  'browser.connected.act',
] as const
export const CODING_OPERATION_KEYS = ['coding.launch', 'coding.observe'] as const
export const COMMAND_OPERATION_KEY = 'command.run' as const

type GuestVmArtifactInput = {
  guestInitrdBuilderPath: string
  guestRuntimeBundlePath: string
  kernelPath: string
  vmHelperPath: string
}

type VerifiedGuestVmArtifacts = GuestVmArtifactInput & {
  runtime: Awaited<ReturnType<typeof verifyGuestRuntimeBundle>>
}

const verifyGuestVmArtifacts = async (
  input: GuestVmArtifactInput,
): Promise<VerifiedGuestVmArtifacts> => {
  const [guestInitrdBuilderPath, kernelPath, vmHelperPath, runtime] = await Promise.all([
    verifyPrivateGuestVmFile(input.guestInitrdBuilderPath, true),
    verifyPrivateGuestVmFile(input.kernelPath, false),
    verifyPrivateGuestVmFile(input.vmHelperPath, true),
    verifyGuestRuntimeBundle(input.guestRuntimeBundlePath),
  ])
  return {
    guestInitrdBuilderPath,
    guestRuntimeBundlePath: runtime.root,
    kernelPath,
    runtime,
    vmHelperPath,
  }
}

const initialLocalPolicy = {
  limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
  // File writes land in daemon-owned COW scratch. No host promotion is present
  // until a person explicitly enables its separately verified helper policy.
  operationKeys: [...COW_WORKSPACE_OPERATION_KEYS],
  profiles: ['workspace_sandbox'],
  revision: 1,
}

const configuredOperationKeys = (
  requestedOperationKeys: string[],
  browserConfigured: boolean,
  codexConfigured: boolean,
  host: ExecutorHost,
): string[] => {
  const requested = new Set(requestedOperationKeys)
  if (requested.size === 0 || requested.size !== requestedOperationKeys.length) {
    throw new Error('Specify one or more distinct implemented executor operations.')
  }
  if ([...requested].some((operationKey) => (
    !ImplementedExecutorOperationKeySchema.safeParse(operationKey).success
  ))) {
    throw new Error('Only implemented workspace, command, browser, and coding operations may be configured.')
  }
  if (CONNECTED_BROWSER_OPERATION_KEYS.some((operationKey) => requested.has(operationKey))) {
    throw new Error('Connected Chrome is not yet available until the private-run disclosure gate is installed.')
  }
  const requestedBrowserOperations = BROWSER_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey))
  if (requestedBrowserOperations.length > 0 && requestedBrowserOperations.length !== BROWSER_OPERATION_KEYS.length) {
    throw new Error('browser.open, browser.observe, and browser.act must be enabled together.')
  }
  if (requestedBrowserOperations.length > 0 && !browserConfigured) {
    throw new Error('Configure the owner-only browser VM and allowed origins before enabling browser operations.')
  }
  if (requestedBrowserOperations.length > 0 && !requested.has('sandbox.stop')) {
    throw new Error('Browser operations require sandbox.stop.')
  }
  const requestedCodingOperations = CODING_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey))
  if (requestedCodingOperations.length > 0 && requestedCodingOperations.length !== CODING_OPERATION_KEYS.length) {
    throw new Error('coding.launch and coding.observe must be enabled together.')
  }
  if (requestedCodingOperations.length > 0 && !codexConfigured) {
    throw new Error('Configure the owner-only Codex VM and auth profile before enabling coding operations.')
  }
  if (requestedCodingOperations.length > 0 && (
    !requested.has('sandbox.stop') || !requested.has('workspace.review')
  )) {
    throw new Error('coding.launch and coding.observe require workspace.review and sandbox.stop.')
  }
  if (requested.has(COMMAND_OPERATION_KEY) && !browserConfigured) {
    throw new Error('Configure the owner-only guest VM before enabling command.run.')
  }
  if (requested.has(COMMAND_OPERATION_KEY) && (
    !requested.has('workspace.review') || !requested.has('sandbox.stop')
  )) {
    throw new Error('command.run requires workspace.review and sandbox.stop.')
  }
  const operationKeys = [
    ...COW_WORKSPACE_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
    ...(requested.has(COMMAND_OPERATION_KEY) ? [COMMAND_OPERATION_KEY] : []),
    ...BROWSER_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
    ...CODING_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
    ...(requested.has(PROMOTION_OPERATION_KEY) ? [PROMOTION_OPERATION_KEY] : []),
  ]
  // The same refusal the descriptor build makes, raised here so a person
  // proposing a policy hears it now instead of at the next connect.
  assertHostSupportsOperations(host, operationKeys, profilesForOperationKeys(operationKeys))
  return operationKeys
}

const profilesForOperationKeys = (operationKeys: string[]): string[] =>
  operationKeys.some((operationKey) => CODING_OPERATION_KEYS.includes(
    operationKey as typeof CODING_OPERATION_KEYS[number],
  ))
    ? ['workspace_sandbox', 'coding_session']
    : ['workspace_sandbox']

/**
 * Update the companion's locally enforced policy. Promotion additionally needs
 * an owner-verified native helper. This deliberately does not submit a
 * descriptor: `connect` signs and proposes the new revision, then an entitled
 * human must confirm its review in Nessie before it is usable.
 */
export const configureExecutorLocalPolicy = async (
  stateDir: string,
  state: ExecutorLocalState,
  requestedOperationKeys: string[],
  nativeHelperPath?: string,
  host: ExecutorHost = detectExecutorHost(),
): Promise<ExecutorLocalState> => {
  const operationKeys = configuredOperationKeys(
    requestedOperationKeys,
    Boolean(state.browserSandbox),
    Boolean(state.codexSandbox),
    host,
  )
  const helper = nativeHelperPath
    ? await verifyNativeHelperPath(nativeHelperPath)
    : state.nativeHelperPath
  if (operationKeys.includes(PROMOTION_OPERATION_KEY) && !helper) {
    throw new Error('workspace.promote requires an owner-only native helper path.')
  }
  const next: ExecutorLocalState = {
    ...state,
    descriptor: {
      ...state.descriptor,
      operationKeys,
      profiles: profilesForOperationKeys(operationKeys),
      revision: state.descriptor.revision + 1,
    },
    ...(helper ? { nativeHelperPath: helper } : {}),
  }
  await saveExecutorState(stateDir, next)
  return next
}

export const configureExecutorBrowserSandbox = async (
  stateDir: string,
  state: ExecutorLocalState,
  input: {
    allowedOrigins: string[]
    guestInitrdBuilderPath: string
    guestRuntimeBundlePath: string
    kernelPath: string
    vmHelperPath: string
  },
  host: ExecutorHost = detectExecutorHost(),
): Promise<ExecutorLocalState> => {
  const egress = compileExecutorEgressPolicy({ allowedOrigins: input.allowedOrigins })
  const artifacts = await verifyGuestVmArtifacts(input)
  const { guestInitrdBuilderPath, kernelPath, vmHelperPath, runtime } = artifacts
  if (!runtime.entrypoints.browser) {
    throw new Error('The guest runtime bundle does not declare a browser entrypoint.')
  }
  const browserSandbox: ExecutorBrowserSandboxConfig = {
    allowedOrigins: [...egress.allowedOrigins].sort(),
    guestInitrdBuilderPath,
    guestRuntimeBundlePath: artifacts.guestRuntimeBundlePath,
    kernelPath,
    vmHelperPath,
  }
  const currentNonBrowserOperations = state.descriptor.operationKeys.filter(
    (operationKey) => !BROWSER_OPERATION_KEYS.includes(
      operationKey as typeof BROWSER_OPERATION_KEYS[number],
    ),
  )
  const operationKeys = configuredOperationKeys([...new Set([
    ...currentNonBrowserOperations,
    'sandbox.stop',
    ...BROWSER_OPERATION_KEYS,
  ])], true, Boolean(state.codexSandbox), host)
  const next: ExecutorLocalState = {
    ...state,
    browserSandbox,
    descriptor: {
      ...state.descriptor,
      operationKeys,
      profiles: profilesForOperationKeys(operationKeys),
      revision: state.descriptor.revision + 1,
    },
  }
  await saveExecutorState(stateDir, next)
  return next
}

/**
 * Stores one local Codex login source after verifying its file and the whole
 * guest runtime. A connect then submits the exact descriptor for normal human
 * review; this configuration alone never bypasses that review.
 */
export const configureExecutorCodexSandbox = async (
  stateDir: string,
  state: ExecutorLocalState,
  input: GuestVmArtifactInput & { codexAuthProfilePath: string },
  host: ExecutorHost = detectExecutorHost(),
): Promise<ExecutorLocalState> => {
  const [artifacts, codexAuthProfilePath] = await Promise.all([
    verifyGuestVmArtifacts(input),
    verifyPrivateCodexAuthProfile(input.codexAuthProfilePath),
  ])
  if (!artifacts.runtime.entrypoints.codex || !artifacts.runtime.entrypoints.tmux) {
    throw new Error('The guest runtime bundle must declare owner-pinned Codex and tmux entrypoints.')
  }
  const codexSandbox: ExecutorCodexSandboxConfig = {
    codexAuthProfilePath,
    guestInitrdBuilderPath: artifacts.guestInitrdBuilderPath,
    guestRuntimeBundlePath: artifacts.guestRuntimeBundlePath,
    kernelPath: artifacts.kernelPath,
    vmHelperPath: artifacts.vmHelperPath,
  }
  const currentNonCodingOperations = state.descriptor.operationKeys.filter(
    (operationKey) => !CODING_OPERATION_KEYS.includes(
      operationKey as typeof CODING_OPERATION_KEYS[number],
    ),
  )
  const operationKeys = configuredOperationKeys([...new Set([
    ...currentNonCodingOperations,
    'workspace.review',
    'sandbox.stop',
    ...CODING_OPERATION_KEYS,
  ])], Boolean(state.browserSandbox), true, host)
  const next: ExecutorLocalState = {
    ...state,
    codexSandbox,
    descriptor: {
      ...state.descriptor,
      operationKeys,
      profiles: profilesForOperationKeys(operationKeys),
      revision: state.descriptor.revision + 1,
    },
  }
  await saveExecutorState(stateDir, next)
  return next
}

type PairExecutorDependencies = {
  clearPrepared: (stateDir: string) => Promise<void>
  loadPrepared: (stateDir: string) => Promise<ExecutorPreparedPairing | null>
  savePrepared: (stateDir: string, prepared: ExecutorPreparedPairing) => Promise<void>
  saveState: (stateDir: string, state: ExecutorLocalState) => Promise<void>
  submitEnrollment: (
    baseUrl: string,
    request: ExecutorEnrollmentRequest,
  ) => Promise<{ executorId: string; fingerprint: string }>
}

const pairExecutorDependencies: PairExecutorDependencies = {
  clearPrepared: clearExecutorPreparedPairing,
  loadPrepared: loadExecutorPreparedPairing,
  savePrepared: saveExecutorPreparedPairing,
  saveState: saveExecutorState,
  submitEnrollment: executorApi.submitEnrollment,
}

const preparePairing = (
  input: PairExecutorInput,
  workspaceRoot: string,
): ExecutorPreparedPairing => {
  const keys = generateKeyPairSync('ed25519')
  const machinePublicKey = rawEd25519PublicKey(keys.publicKey)
  const descriptor = buildSignedDescriptor(
    keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    initialLocalPolicy,
  )
  const digest = `sha256:${createHash('sha256')
    .update(canonicalExecutorJson(descriptor.descriptor))
    .digest('hex')}`
  const request = ExecutorEnrollmentRequestSchema.parse({
    challenge: input.challenge,
    descriptor,
    enrollmentId: input.enrollmentId,
    machinePublicKey,
    proof: sign(
      null,
      Buffer.from(canonicalExecutorPayload('nessie.executor.enrollment.v1', {
        challenge: input.challenge,
        descriptorDigest: digest,
        enrollmentId: input.enrollmentId,
        machinePublicKey,
      })),
      keys.privateKey,
    ).toString('base64url'),
  })
  return {
    apiBaseUrl: input.apiBaseUrl,
    enrollmentId: input.enrollmentId,
    machinePrivateKey: keys.privateKey.export({
      format: 'der',
      type: 'pkcs8',
    }).toString('base64url'),
    request,
    workspaceRoot,
  }
}

const assertPreparedPairingMatches = (
  input: PairExecutorInput,
  workspaceRoot: string,
  prepared: ExecutorPreparedPairing,
): void => {
  let storedPublicKey: string
  try {
    const privateKey = createPrivateKey({
      format: 'der',
      key: Buffer.from(prepared.machinePrivateKey, 'base64url'),
      type: 'pkcs8',
    })
    storedPublicKey = rawEd25519PublicKey(createPublicKey(privateKey))
  } catch {
    throw new Error('Executor pairing state contains an invalid private key.')
  }
  if (
    prepared.apiBaseUrl !== input.apiBaseUrl
    || prepared.enrollmentId !== input.enrollmentId
    || prepared.request.enrollmentId !== prepared.enrollmentId
    || prepared.request.challenge !== input.challenge
    || prepared.request.machinePublicKey !== storedPublicKey
    || prepared.workspaceRoot !== workspaceRoot
  ) {
    throw new Error(
      'This executor state directory contains a different unfinished pairing. '
      + 'Complete that pairing before starting another.',
    )
  }
}

export const pairExecutor = async (
  input: PairExecutorInput,
  dependencies: PairExecutorDependencies = pairExecutorDependencies,
): Promise<{ fingerprint: string }> => {
  const workspaceRoot = await configureWorkspaceRoot(input.workspaceRoot)
  let prepared = await dependencies.loadPrepared(input.stateDir)
  if (prepared) {
    assertPreparedPairingMatches(input, workspaceRoot, prepared)
  } else {
    prepared = preparePairing(input, workspaceRoot)
    // No enrollment request may leave the host until its exact key and proof
    // can survive a lost response or process restart.
    await dependencies.savePrepared(input.stateDir, prepared)
  }
  const pending = await dependencies.submitEnrollment(prepared.apiBaseUrl, prepared.request)
  const state: ExecutorLocalState = {
    apiBaseUrl: prepared.apiBaseUrl,
    descriptor: initialLocalPolicy,
    executorId: pending.executorId,
    machinePrivateKey: prepared.machinePrivateKey,
    machinePublicKey: prepared.request.machinePublicKey,
    workspaceRoot: prepared.workspaceRoot,
  }
  await dependencies.saveState(input.stateDir, state)
  await dependencies.clearPrepared(input.stateDir)
  return { fingerprint: pending.fingerprint }
}

export const signedDescriptorForState = (state: ExecutorLocalState): ExecutorSignedDescriptor =>
  buildSignedDescriptor(state.machinePrivateKey, state.descriptor)
