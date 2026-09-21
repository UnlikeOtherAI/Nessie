import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

/** A resource key proves shared local custody; it grants no model or source access. */
export type LocalInferenceResourceAttachment = {
  connectionEpoch: string
  hostId: string
  organizationId: string
  publicKey: string
}

const attachmentBytes = (input: LocalInferenceResourceAttachment): Buffer => Buffer.from(JSON.stringify([
  'nessie.local-inference.resource.v1', input.connectionEpoch, input.hostId, input.organizationId, input.publicKey,
]))

export const signLocalInferenceResourceAttachment = (
  input: LocalInferenceResourceAttachment,
  privateKey: string,
): string => sign(null, attachmentBytes(input), createPrivateKey({
  key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8',
})).toString('base64url')

export const verifyLocalInferenceResourceAttachment = (
  input: LocalInferenceResourceAttachment & { signature: string },
): string | null => {
  try {
    const key = createPublicKey({ key: Buffer.from(input.publicKey, 'base64url'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') return null
    if (!verify(null, attachmentBytes(input), key, Buffer.from(input.signature, 'base64url'))) return null
    return createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex')
  } catch {
    return null
  }
}
