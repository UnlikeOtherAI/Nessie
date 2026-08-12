import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  type ExecutorSignedDescriptor,
} from '@nessie/schemas'

import { executorApi } from './api-client.js'
import { buildSignedDescriptor } from './descriptor.js'
import { compileExecutorEgressPolicy } from './egress-policy.js'
import { verifyPrivateGuestVmFile } from './guest-vm-artifacts.js'
import { verifyGuestRuntimeBundle } from './guest-runtime-bundle.js'
import { verifyNativeHelperPath } from './native-helper.js'
import {
  saveExecutorState,
  type ExecutorBrowserSandboxConfig,
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
): string[] => {
  const requested = new Set(requestedOperationKeys)
  if (requested.size === 0 || requested.size !== requestedOperationKeys.length) {
    throw new Error('Specify one or more distinct implemented executor operations.')
  }
  if ([...requested].some((operationKey) => (
    !COW_WORKSPACE_OPERATION_KEYS.includes(operationKey as typeof COW_WORKSPACE_OPERATION_KEYS[number])
    && operationKey !== PROMOTION_OPERATION_KEY
    && !BROWSER_OPERATION_KEYS.includes(operationKey as typeof BROWSER_OPERATION_KEYS[number])
  ))) {
    throw new Error('Only implemented workspace and browser operations may be configured.')
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
  return [
    ...COW_WORKSPACE_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
    ...BROWSER_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
    ...(requested.has(PROMOTION_OPERATION_KEY) ? [PROMOTION_OPERATION_KEY] : []),
  ]
}

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
  const operationKeys = configuredOperationKeys(requestedOperationKeys, Boolean(state.browserSandbox))
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
      profiles: ['workspace_sandbox'],
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
  const [guestInitrdBuilderPath, kernelPath, vmHelperPath, runtime] = await Promise.all([
    verifyPrivateGuestVmFile(input.guestInitrdBuilderPath, true),
    verifyPrivateGuestVmFile(input.kernelPath, false),
    verifyPrivateGuestVmFile(input.vmHelperPath, true),
    verifyGuestRuntimeBundle(input.guestRuntimeBundlePath),
  ])
  if (!runtime.entrypoints.browser) {
    throw new Error('The guest runtime bundle does not declare a browser entrypoint.')
  }
  const browserSandbox: ExecutorBrowserSandboxConfig = {
    allowedOrigins: [...egress.allowedOrigins].sort(),
    guestInitrdBuilderPath,
    guestRuntimeBundlePath: runtime.root,
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
  ])], true)
  const next: ExecutorLocalState = {
    ...state,
    browserSandbox,
    descriptor: {
      ...state.descriptor,
      operationKeys,
      profiles: ['workspace_sandbox'],
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
