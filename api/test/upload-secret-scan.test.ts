import assert from 'node:assert/strict'
import test from 'node:test'

import { uploadContainsDetectedSecret } from '../src/routes/upload-secret-scan.js'

const secretText = `OPENAI_API_KEY=sk-proj-${'aB3_'.repeat(8)}`

test('upload secret scanning covers UTF-8 and UTF-16LE text', () => {
  assert.equal(uploadContainsDetectedSecret(Buffer.from(secretText, 'utf8')), true)
  assert.equal(uploadContainsDetectedSecret(Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(secretText, 'utf16le'),
  ])), true)
  assert.equal(uploadContainsDetectedSecret(Buffer.from(secretText, 'utf16le')), true)
})

test('upload secret scanning covers UTF-16BE text', () => {
  const littleEndian = Buffer.from(secretText, 'utf16le')
  const bigEndian = Buffer.allocUnsafe(littleEndian.length + 2)
  bigEndian[0] = 0xfe
  bigEndian[1] = 0xff
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index + 2] = littleEndian[index + 1]!
    bigEndian[index + 3] = littleEndian[index]!
  }
  assert.equal(uploadContainsDetectedSecret(bigEndian), true)
  assert.equal(uploadContainsDetectedSecret(Buffer.from('ordinary notes')), false)
})
