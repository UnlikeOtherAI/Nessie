import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  type ExecutorSignedDescriptor,
} from '@nessie/schemas'

import { executorApi } from './api-client.js'
import { buildSignedDescriptor } from './descriptor.js'
import { compileExecutorEgressPolicy } from './egress-policy.js'
import { verifyPrivateCodexAuthProfile, verifyPrivateGuestVmFile } from './guest-vm-artifacts.js'
import { verifyGuestRuntimeBundle } from './guest-runtime-bundle.js'
import { verifyNativeHelperPath } from './native-helper.js'
import {
  saveExecutorState,
  type ExecutorBrowserSandboxConfig,
  type ExecutorCodexSandboxConfig,
  type ExecutorLocalState,
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

export const COW_WORKSPACE_OPERATION_KEYS = [
  'file.list',
  'file.read',
  'file.write',
  'workspace.review',
  'sandbox.stop',
] as const

const PROMOTION_OPERATION_KEY = 'workspace.promote' as const
export const BROWSER_OPERATION_KEYS = ['browser.open', 'browser.observe'] as const
export const CODING_OPERATION_KEYS = ['coding.launch', 'coding.observe'] as const

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
): string[] => {
  const requested = new Set(requestedOperationKeys)
  if (requested.size === 0 || requested.size !== requestedOperationKeys.length) {
    throw new Error('Specify one or more distinct implemented executor operations.')
  }
  if ([...requested].some((operationKey) => (
    !COW_WORKSPACE_OPERATION_KEYS.includes(operationKey as typeof COW_WORKSPACE_OPERATION_KEYS[number])
    && operationKey !== PROMOTION_OPERATION_KEY
    && !BROWSER_OPERATION_KEYS.includes(operationKey as typeof BROWSER_OPERATION_KEYS[number])
    && !CODING_OPERATION_KEYS.includes(operationKey as typeof CODING_OPERATION_KEYS[number])
  ))) {
    throw new Error('Only implemented workspace, browser, and coding operations may be configured.')
  }
  const requestedBrowserOperations = BROWSER_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey))
  if (requestedBrowserOperations.length > 0 && requestedBrowserOperations.length !== BROWSER_OPERATION_KEYS.length) {
    throw new Error('browser.open and browser.observe must be enabled together.')
  }
  if (requestedBrowserOperations.length > 0 && !browserConfigured) {
    throw new Error('Configure the owner-only browser VM and allowed origins before enabling browser operations.')
  }
  if (requestedBrowserOperations.length > 0 && !requested.has('sandbox.stop')) {
    throw new Error('browser.open and browser.observe require sandbox.stop.')
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
  return [
    ...COW_WORKSPACE_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
    ...BROWSER_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
    ...CODING_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
    ...(requested.has(PROMOTION_OPERATION_KEY) ? [PROMOTION_OPERATION_KEY] : []),
  ]
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
): Promise<ExecutorLocalState> => {
  const operationKeys = configuredOperationKeys(
    requestedOperationKeys,
    Boolean(state.browserSandbox),
    Boolean(state.codexSandbox),
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
  ])], true, Boolean(state.codexSandbox))
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
  ])], Boolean(state.browserSandbox), true)
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

export const pairExecutor = async (input: PairExecutorInput): Promise<{ fingerprint: string }> => {
  const workspaceRoot = await configureWorkspaceRoot(input.workspaceRoot)
  const keys = generateKeyPairSync('ed25519')
  const machinePublicKey = rawEd25519PublicKey(keys.publicKey)
  const descriptor = buildSignedDescriptor(
    keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    initialLocalPolicy,
  )
  const digest = `sha256:${createHash('sha256')
    .update(canonicalExecutorJson(descriptor.descriptor))
    .digest('hex')}`
  const proof = sign(
    null,
    Buffer.from(canonicalExecutorPayload('nessie.executor.enrollment.v1', {
      challenge: input.challenge,
      descriptorDigest: digest,
      enrollmentId: input.enrollmentId,
      machinePublicKey,
    })),
    keys.privateKey,
  ).toString('base64url')
  const pending = await executorApi.submitEnrollment(input.apiBaseUrl, {
    challenge: input.challenge,
    descriptor,
    enrollmentId: input.enrollmentId,
    machinePublicKey,
    proof,
  })
  const state: ExecutorLocalState = {
    apiBaseUrl: input.apiBaseUrl,
    descriptor: initialLocalPolicy,
    executorId: pending.executorId,
    machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    machinePublicKey,
    workspaceRoot,
  }
  await saveExecutorState(input.stateDir, state)
  return { fingerprint: pending.fingerprint }
}

export const signedDescriptorForState = (state: ExecutorLocalState): ExecutorSignedDescriptor =>
  buildSignedDescriptor(state.machinePrivateKey, state.descriptor)
