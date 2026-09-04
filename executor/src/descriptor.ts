import { createHash, createPrivateKey, sign } from 'node:crypto'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS,
  EXECUTOR_WORKSPACE_ONLY_PROFILES,
  ExecutorCapabilityDescriptorSchema,
  ImplementedExecutorOperationKeySchema,
  ExecutorSignedDescriptorSchema,
  type ExecutorSignedDescriptor,
} from '@nessie/schemas'

import { detectExecutorHost, sandboxRemedyForHost, type ExecutorHost } from './host-platform.js'

type LocalDescriptorConfig = {
  limits: { maxCommandRuntimeSeconds: number; maxResultBytes: number; maxSessions: number }
  operationKeys: string[]
  profiles: string[]
  revision: number
}

const isWorkspaceOnlyOperation = (operationKey: string): boolean =>
  (EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS as readonly string[]).includes(operationKey)

const isWorkspaceOnlyProfile = (profile: string): boolean =>
  (EXECUTOR_WORKSPACE_ONLY_PROFILES as readonly string[]).includes(profile)

/**
 * A host with no sandbox backend is still a usable executor, but only for the
 * copy-on-write workspace bundle the daemon serves from its own scratch
 * directory. Everything else needs a per-session guest, so it is refused here
 * — at the moment a person proposes the policy — with the remedy named, rather
 * than advertised to the control plane and failed at the first command.
 */
export const assertHostSupportsOperations = (
  host: ExecutorHost,
  operationKeys: readonly string[],
  profiles: readonly string[],
): void => {
  if (host.sandboxBackend !== 'none') return
  const unsupported = [
    ...operationKeys.filter((operationKey) => !isWorkspaceOnlyOperation(operationKey)),
    ...profiles.filter((profile) => !isWorkspaceOnlyProfile(profile)),
  ]
  if (unsupported.length === 0) return
  throw new Error(
    `This computer has no sandbox backend, so it can offer only ${
      EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS.join(', ')
    }. Refused: ${unsupported.join(', ')}. ${sandboxRemedyForHost(host)}`,
  )
}

const policyDigest = (config: LocalDescriptorConfig): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(config)).digest('hex')}`

export const buildSignedDescriptor = (
  privateKeyDer: string,
  config: LocalDescriptorConfig,
  host: ExecutorHost = detectExecutorHost(),
): ExecutorSignedDescriptor => {
  assertHostSupportsOperations(host, config.operationKeys, config.profiles)
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    limits: config.limits,
    localPolicyDigest: policyDigest(config),
    operationKeys: config.operationKeys.map((key) => ImplementedExecutorOperationKeySchema.parse(key)),
    platform: host.platform,
    profiles: config.profiles,
    protocolVersion: 1,
    revision: config.revision,
    sandboxBackend: host.sandboxBackend,
    supervisor: host.supervisor,
  })
  return ExecutorSignedDescriptorSchema.parse({
    descriptor,
    signature: sign(
      null,
      Buffer.from(canonicalExecutorPayload('nessie.executor.descriptor.v1', descriptor)),
      createPrivateKey({
        format: 'der',
        key: Buffer.from(privateKeyDer, 'base64url'),
        type: 'pkcs8',
      }),
    ).toString('base64url'),
  })
}
