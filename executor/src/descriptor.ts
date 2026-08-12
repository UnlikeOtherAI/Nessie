import { createHash, createPrivateKey, sign } from 'node:crypto'
import { release } from 'node:os'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  ExecutorCapabilityDescriptorSchema,
  ExecutorOperationKeySchema,
  ExecutorSignedDescriptorSchema,
  type ExecutorSignedDescriptor,
} from '@nessie/schemas'

type LocalDescriptorConfig = {
  limits: { maxCommandRuntimeSeconds: number; maxResultBytes: number; maxSessions: number }
  operationKeys: string[]
  profiles: string[]
  revision: number
}

const initialPlatform = (): { architecture: 'arm64'; os: 'macos'; osMajorVersion: number } => {
  const kernelMajor = Number.parseInt(release().split('.')[0] ?? '', 10)
  const macOsMajor = kernelMajor - 9
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || macOsMajor < 15) {
    throw new Error(
      'This executor release supports only macOS 15+ on Apple Silicon. Set no execution capability on other platforms.',
    )
  }
  return { architecture: 'arm64', os: 'macos', osMajorVersion: macOsMajor }
}

const policyDigest = (config: LocalDescriptorConfig): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(config)).digest('hex')}`

export const buildSignedDescriptor = (
  privateKeyDer: string,
  config: LocalDescriptorConfig,
): ExecutorSignedDescriptor => {
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    limits: config.limits,
    localPolicyDigest: policyDigest(config),
    operationKeys: config.operationKeys.map((key) => ExecutorOperationKeySchema.parse(key)),
    platform: initialPlatform(),
    profiles: config.profiles,
    protocolVersion: 1,
    revision: config.revision,
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
