import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  type ExecutorSignedDescriptor,
} from '@nessie/schemas'

import { executorApi } from './api-client.js'
import { buildSignedDescriptor } from './descriptor.js'
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

const initialLocalPolicy = {
  limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
  // File writes land in the daemon-owned COW scratch workspace. The paired
  // root stays read-only: there is still no shell, browser, or host promotion.
  operationKeys: [...COW_WORKSPACE_OPERATION_KEYS],
  profiles: ['workspace_sandbox'],
  revision: 1,
}

/**
 * Update only the companion's locally enforced COW policy. This deliberately
 * does not submit a descriptor: `connect` signs and proposes the new revision,
 * then an entitled human must confirm its review in Nessie before it is usable.
 */
export const configureExecutorLocalPolicy = async (
  stateDir: string,
  state: ExecutorLocalState,
  requestedOperationKeys: string[],
): Promise<ExecutorLocalState> => {
  const requested = new Set(requestedOperationKeys)
  if (requested.size === 0 || requested.size !== requestedOperationKeys.length) {
    throw new Error('Specify one or more distinct COW workspace operations.')
  }
  if ([...requested].some((operationKey) => !COW_WORKSPACE_OPERATION_KEYS.includes(
    operationKey as typeof COW_WORKSPACE_OPERATION_KEYS[number],
  ))) {
    throw new Error('Only implemented COW workspace operations may be configured.')
  }
  const next: ExecutorLocalState = {
    ...state,
    descriptor: {
      ...state.descriptor,
      operationKeys: COW_WORKSPACE_OPERATION_KEYS.filter((operationKey) => requested.has(operationKey)),
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
