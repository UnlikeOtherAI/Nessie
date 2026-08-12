import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  type ExecutorSignedDescriptor,
} from '@nessie/schemas'

import { executorApi } from './api-client.js'
import { buildSignedDescriptor } from './descriptor.js'
import { saveExecutorState, type ExecutorLocalState } from './state-store.js'

const rawEd25519PublicKey = (publicKey: KeyObject): string =>
  publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')

export type PairExecutorInput = {
  apiBaseUrl: string
  challenge: string
  enrollmentId: string
  stateDir: string
}

const initialLocalPolicy = {
  limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
  // The first companion release owns pairing/presence only. It advertises a
  // harmless stop capability but refuses every data or terminal operation
  // until the separately hardened backend is installed.
  operationKeys: ['sandbox.stop'],
  profiles: ['workspace_sandbox'],
  revision: 1,
}

export const pairExecutor = async (input: PairExecutorInput): Promise<{ fingerprint: string }> => {
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
  }
  await saveExecutorState(input.stateDir, state)
  return { fingerprint: pending.fingerprint }
}

export const signedDescriptorForState = (state: ExecutorLocalState): ExecutorSignedDescriptor =>
  buildSignedDescriptor(state.machinePrivateKey, state.descriptor)
