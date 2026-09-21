import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import test from 'node:test'
import { signLocalInferenceResourceAttachment, verifyLocalInferenceResourceAttachment } from '../src/resource-proof.js'

test('one coordinator key authenticates both transports but cannot be moved to another host or epoch', () => {
  const keys = generateKeyPairSync('ed25519')
  const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  const attachment = {
    hostId: randomUUID(), organizationId: randomUUID(), connectionEpoch: '1',
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
  const signed = { ...attachment, signature: signLocalInferenceResourceAttachment(attachment, privateKey) }
  const fingerprint = verifyLocalInferenceResourceAttachment(signed)
  assert.ok(fingerprint)
  assert.equal(verifyLocalInferenceResourceAttachment({ ...signed, connectionEpoch: '2' }), null)
  assert.equal(verifyLocalInferenceResourceAttachment({ ...signed, hostId: randomUUID() }), null)
  assert.equal(verifyLocalInferenceResourceAttachment({ ...signed, organizationId: randomUUID() }), null)
  const sibling = { ...attachment, hostId: randomUUID() }
  assert.equal(verifyLocalInferenceResourceAttachment({
    ...sibling, signature: signLocalInferenceResourceAttachment(sibling, privateKey),
  }), fingerprint)
})
