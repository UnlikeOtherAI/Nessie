import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  MARKDOWN_IMPORT_MAX_BYTES,
  projectMarkdownAttachment,
  readCanonicalMarkdownAttachment,
} from '../src/index.js'

const organizationId = '00000000-0000-4000-8000-000000000001'

test('Markdown projection hashes and renders the exact FileService bytes', async () => {
  const source = Buffer.from('# Canonical\n\nA **verified** note.')
  const projection = await projectMarkdownAttachment(
    async (attachmentId, requestedOrganizationId) => {
      assert.equal(attachmentId, 'attachment-1')
      assert.equal(requestedOrganizationId, organizationId)
      return Readable.from([source])
    },
    'attachment-1',
    organizationId,
  )

  assert.equal(projection.sourceContentHash, createHash('sha256').update(source).digest('hex'))
  assert.match(projection.body, /<h1>Canonical<\/h1>/)
  assert.match(projection.body, /<strong>verified<\/strong>/)
})

test('canonical Markdown reader enforces the running byte cap while streaming', async () => {
  const source = Buffer.alloc(MARKDOWN_IMPORT_MAX_BYTES + 1, 'x')
  await assert.rejects(
    readCanonicalMarkdownAttachment(
      async () => Readable.from([source.subarray(0, 16), source.subarray(16)]),
      'attachment-1',
      organizationId,
    ),
    /exceeds the import limit/,
  )
})
