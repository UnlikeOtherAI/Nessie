import { createPrivateKey, sign } from 'node:crypto'

/** Matches the server's narrow consent statement byte-for-byte. */
const payload = (challengeId: string, bindingId: string, hostId: string): Buffer =>
  Buffer.from(`nessie-local-inference-consent-v1\n${challengeId}\n${bindingId}\n${hostId}`, 'utf8')

export const signExecutorLocalInferenceConsent = (input: {
  bindingId: string
  challengeId: string
  hostId: string
  machinePrivateKey: string
}): string => sign(
  null,
  payload(input.challengeId, input.bindingId, input.hostId),
  createPrivateKey({
    format: 'der',
    key: Buffer.from(input.machinePrivateKey, 'base64url'),
    type: 'pkcs8',
  }),
).toString('base64url')
