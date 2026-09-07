import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { createFileService } from '@nessie/runtime'
import type { SignedDownloadRequest, Storage } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerUploadRoutes } from '../src/routes/uploads.js'

/**
 * Plan row 5.7 / audit 6.4: `GET /api/attachments/:id` proxied every byte, so a
 * multi-GiB download was pinned to one API process and died with it. Past a
 * threshold the API now answers a redirect and the client fetches the object
 * directly.
 *
 * The three things this file is here to hold:
 *
 *  1. A large download IS a redirect, and the API never opens the object.
 *  2. **The URL is minted only after the access check the proxy used to be.**
 *     A signed URL bypasses the API for the life of the signature, so a mint
 *     that happened before (or instead of) the ACL would hand a stranger a
 *     capability the 404 was supposed to withhold.
 *  3. Every way of not being able to sign ends in a proxied download, never a
 *     failed one.
 *
 * The FileService's own half — the threshold, the pinned signature fields and
 * the cross-tenant refusal — is in
 * packages/runtime/test/attachment-download.test.ts.
 */

const organizationId = '00000000-0000-4000-8000-0000000005a0'
const projectId = '00000000-0000-4000-8000-0000000005a1'
const memberId = '00000000-0000-4000-8000-0000000005aa'
const outsiderId = '00000000-0000-4000-8000-0000000005ab'
const channelId = '00000000-0000-4000-8000-0000000005b0'
const threadId = '00000000-0000-4000-8000-0000000005b1'
const messageId = '00000000-0000-4000-8000-0000000005b2'
const attachmentId = '00000000-0000-4000-8000-0000000005c0'
const storageKey = `${organizationId}/big-object`

const BODY = 'proxied bytes'

const actorContextFor = (userId: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: { organizationId, projectId },
  actionContext: { requestId: `req-signed-${userId}` },
})

type Recorder = { signed: SignedDownloadRequest[]; streamed: string[] }

const recordingStorage = (mode: 'signs' | 'throws' | 'cannot-sign'): Storage & Recorder => {
  const signed: SignedDownloadRequest[] = []
  const streamed: string[] = []
  const base: Storage & Recorder = {
    delete: async () => undefined,
    get: async () => null,
    getStream: async (key) => {
      streamed.push(key)
      return Readable.from(Buffer.from(BODY))
    },
    put: async () => undefined,
    putStream: async () => ({ bytesWritten: 0 }),
    signed,
    streamed,
  }
  if (mode === 'cannot-sign') return base
  return {
    ...base,
    signedDownloadUrl: async (key, request) => {
      signed.push(request)
      if (mode === 'throws') throw new Error('signer unavailable')
      return `https://objects.example/${key}?X-Amz-Signature=deadbeef`
    },
  }
}

const makeApp = (options: {
  userId: string
  mode: 'signs' | 'throws' | 'cannot-sign'
  sizeBytes: bigint
}) => {
  const usageEvents: unknown[] = []
  const attachment = {
    id: attachmentId,
    organizationId,
    uploaderId: memberId,
    messageId,
    knowledgePageId: null,
    emailMessageId: null,
    kind: 'file',
    mime: 'application/zip',
    filename: 'archive.zip',
    sizeBytes: options.sizeBytes,
    storageKey,
    width: null,
    height: null,
    thumbnailKey: null,
    thumbnailMime: null,
    thumbnailSizeBytes: null,
    thumbnailWidth: null,
    thumbnailHeight: null,
    thumbnailStatus: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }

  // The channel is private and `memberId` is its only member, so `outsiderId`
  // fails `canAccessMessageAttachment` exactly the way a stranger does in
  // production.
  const prisma = {
    attachment: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        (where.id === attachmentId ? attachment : null),
    },
    message: {
      findFirst: async ({
        where,
      }: {
        where: {
          id: string
          thread: { channel: { OR: Array<{ members?: { some: { userId: string } } }> } }
        }
      }) => {
        if (where.id !== messageId) return null
        const asks = where.thread.channel.OR.some(
          (clause) => clause.members?.some.userId === memberId,
        )
        return asks ? { id: messageId, threadId, channelId } : null
      },
    },
    connectorUsageEvent: {
      create: async ({ data }: { data: unknown }) => {
        usageEvents.push(data)
        return data
      },
    },
  } as unknown as PrismaClient

  const storage = recordingStorage(options.mode)
  const app = Fastify({ logger: false })
  registerUploadRoutes(app, {
    prisma,
    requireActorContext: () => actorContextFor(options.userId),
    fileService: createFileService({
      maxUploadBytes: 5_000_000_000,
      prisma,
      // A small threshold so the fixture does not have to carry a real 8 MiB.
      signedDownloadMinBytes: 1024,
      storage,
    }),
  } as unknown as Parameters<typeof registerUploadRoutes>[1])
  return { app, storage, usageEvents }
}

test('a download past the threshold redirects instead of streaming through the API', async () => {
  const { app, storage } = makeApp({ mode: 'signs', sizeBytes: 4096n, userId: memberId })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/attachments/${attachmentId}` })

    assert.equal(response.statusCode, 302)
    assert.equal(
      response.headers.location,
      `https://objects.example/${storageKey}?X-Amz-Signature=deadbeef`,
    )
    // The whole point: this process is not carrying the bytes.
    assert.deepEqual(storage.streamed, [])
    assert.equal(storage.signed.length, 1)
  } finally {
    await app.close()
  }
})

test('the redirect is never cached and never leaks through Referer', async () => {
  const { app } = makeApp({ mode: 'signs', sizeBytes: 4096n, userId: memberId })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/attachments/${attachmentId}` })

    // The attachment's own year-long `immutable` cache-control would outlive a
    // 60-second signature by a factor of half a million.
    assert.equal(response.headers['cache-control'], 'private, no-store')
    assert.equal(response.headers['referrer-policy'], 'no-referrer')
  } finally {
    await app.close()
  }
})

test('no signed URL is minted for an attachment the caller may not read', async () => {
  const { app, storage, usageEvents } = makeApp({
    mode: 'signs',
    sizeBytes: 4096n,
    userId: outsiderId,
  })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/attachments/${attachmentId}` })

    assert.equal(response.statusCode, 404)
    // A 404 that had already minted a URL would be a 404 in name only: the
    // caller is refused the bytes and handed the capability to fetch them.
    assert.deepEqual(storage.signed, [])
    assert.deepEqual(storage.streamed, [])
    assert.deepEqual(usageEvents, [])
  } finally {
    await app.close()
  }
})

test('a download under the threshold is still proxied, with its metering labelled', async () => {
  const { app, storage, usageEvents } = makeApp({
    mode: 'signs',
    sizeBytes: BigInt(BODY.length),
    userId: memberId,
  })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/attachments/${attachmentId}` })

    assert.equal(response.statusCode, 200)
    assert.equal(response.body, BODY)
    assert.deepEqual(storage.signed, [])
    const usage = usageEvents[0] as { metadata: Record<string, unknown> }
    assert.equal(usage.metadata.delivery, 'proxy')
  } finally {
    await app.close()
  }
})

test('a redirected download is still metered, and says which route carried it', async () => {
  const { app, usageEvents } = makeApp({ mode: 'signs', sizeBytes: 4096n, userId: memberId })
  try {
    await app.inject({ method: 'GET', url: `/api/attachments/${attachmentId}` })

    assert.equal(usageEvents.length, 1)
    const usage = usageEvents[0] as { units: number; metadata: Record<string, unknown> }
    assert.equal(usage.units, 4096)
    assert.equal(usage.metadata.delivery, 'signed-url')
  } finally {
    await app.close()
  }
})

test('a client that already holds the bytes gets a 304, not a capability', async () => {
  const { app, usageEvents } = makeApp({ mode: 'signs', sizeBytes: 4096n, userId: memberId })
  try {
    const response = await app.inject({
      headers: { 'if-none-match': `"${attachmentId}-4096"` },
      method: 'GET',
      url: `/api/attachments/${attachmentId}`,
    })

    assert.equal(response.statusCode, 304)
    // Signing is a local HMAC with no round trip, so a URL is computed and then
    // dropped on this path; what matters is that none of it reaches the client
    // and no transfer is billed for bytes that never moved.
    assert.equal(response.headers.location, undefined)
    assert.deepEqual(usageEvents, [])
  } finally {
    await app.close()
  }
})

test('a backend that cannot sign serves the download over the proxy', async () => {
  const { app, storage } = makeApp({
    mode: 'cannot-sign',
    sizeBytes: 4096n,
    userId: memberId,
  })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/attachments/${attachmentId}` })

    assert.equal(response.statusCode, 200)
    assert.equal(response.body, BODY)
    assert.deepEqual(storage.streamed, [storageKey])
  } finally {
    await app.close()
  }
})

test('a signer that fails serves the download over the proxy', async () => {
  const { app, storage } = makeApp({ mode: 'throws', sizeBytes: 4096n, userId: memberId })
  try {
    const response = await app.inject({ method: 'GET', url: `/api/attachments/${attachmentId}` })

    assert.equal(response.statusCode, 200)
    assert.equal(response.body, BODY)
    assert.equal(storage.signed.length, 1)
    assert.deepEqual(storage.streamed, [storageKey])
  } finally {
    await app.close()
  }
})
