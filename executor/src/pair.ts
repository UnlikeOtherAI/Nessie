import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  type ExecutorSignedDescriptor,
} from '@nessie/schemas'

import { executorApi } from './api-client.js'
import { buildSignedDescriptor } from './descriptor.js'
import { verifyNativeHelperPath } from './native-helper.js'
import { saveExecutorState, type ExecutorLocalState } from './state-store.js'
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

const initialLocalPolicy = {
  limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
  // File writes land in daemon-owned COW scratch. No host promotion is present
  // until a person explicitly enables its separately verified helper policy.
  operationKeys: [...COW_WORKSPACE_OPERATION_KEYS],
  profiles: ['workspace_sandbox'],
  revision: 1,
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
  const requested = new Set(requestedOperationKeys)
  if (requested.size === 0 || requested.size !== requestedOperationKeys.length) {
    throw new Error('Specify one or more distinct implemented workspace operations.')
  }
  if ([...requested].some((operationKey) => (
    !COW_WORKSPACE_OPERATION_KEYS.includes(operationKey as typeof COW_WORKSPACE_OPERATION_KEYS[number])
    && operationKey !== PROMOTION_OPERATION_KEY
  ))) {
    throw new Error('Only implemented COW workspace operations may be configured.')
  }
  const helper = nativeHelperPath
    ? await verifyNativeHelperPath(nativeHelperPath)
    : state.nativeHelperPath
  if (requested.has(PROMOTION_OPERATION_KEY) && !helper) {
    throw new Error('workspace.promote requires an owner-only native helper path.')
  }
  const next: ExecutorLocalState = {
    ...state,
    descriptor: {
      ...state.descriptor,
      operationKeys: [
        ...COW_WORKSPACE_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
        ...(requested.has(PROMOTION_OPERATION_KEY) ? [PROMOTION_OPERATION_KEY] : []),
      ],
      profiles: ['workspace_sandbox'],
      revision: state.descriptor.revision + 1,
    },
    ...(helper ? { nativeHelperPath: helper } : {}),
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
