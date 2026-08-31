import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  appIconIsResolvable,
  resolveAppIcon,
  siteIconCandidates,
} from '../src/apps/app-icon-resolve.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

/**
 * The store rendered a monogram on all 5,548 rows because icon caching was
 * wired only into the owner-triggered sync, and the scheduled sweep — the only
 * sync that ever wrote rows in production — passes no cacher. These assert the
 * replacement: resolve when somebody looks, once, and share the result.
 */

// ─── The URL rules, no database needed ──────────────────────────────────────

test('candidates are origin-only, so a registry author cannot choose the path', () => {
  // The `websiteUrl` is somebody else's text. Taking its origin and appending
  // our own well-known paths means a crafted URL cannot point the fetch at an
  // arbitrary path, and a non-http scheme yields nothing at all.
  assert.deepEqual(siteIconCandidates('https://example.com/deep/page?x=1#frag'), [
    'https://example.com/apple-touch-icon.png',
    'https://example.com/apple-touch-icon-precomposed.png',
    'https://example.com/favicon.png',
    'https://example.com/favicon.ico',
  ])
  assert.deepEqual(siteIconCandidates('file:///etc/passwd'), [])
  assert.deepEqual(siteIconCandidates('javascript:alert(1)'), [])
  assert.deepEqual(siteIconCandidates('not a url'), [])
  // A port is part of the origin and must survive, or the fetch silently
  // retargets the default port on the same host.
  assert.equal(siteIconCandidates('http://example.com:8443/x')[0], 'http://example.com:8443/apple-touch-icon.png')
})

test('a row is only worth asking about while an icon is still possible', () => {
  const base = { iconAttachmentId: null, iconResolvedAt: null, websiteUrl: null }
  // Cached: always ask, that is the whole point.
  assert.equal(appIconIsResolvable({ ...base, iconAttachmentId: 'att-1' }), true)
  // Never tried and has somewhere to look: ask, and the route resolves.
  assert.equal(appIconIsResolvable({ ...base, websiteUrl: 'https://example.com' }), true)
  // Tried, found nothing: stop asking, or the grid re-fetches on every paint.
  assert.equal(appIconIsResolvable({ ...base, iconResolvedAt: new Date(), websiteUrl: 'https://example.com' }), false)
  // Nowhere to look.
  assert.equal(appIconIsResolvable(base), false)
})

// ─── The lazy resolution itself ─────────────────────────────────────────────

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

const okResponse = (bytes: Buffer): Response =>
  new Response(new Blob([bytes]).stream() as ReadableStream<Uint8Array>, {
    headers: { 'content-length': String(bytes.byteLength) },
    status: 200,
  })

const fakeFileService = (attachmentId: string) => ({
  store: async () => ({ attachment: { id: attachmentId } }),
})

const seed = async (prisma: PrismaClient, websiteUrl: string | null) => {
  const id = randomUUID()
  await prisma.mcpCatalogEntry.create({
    data: {
      authMethod: 'none',
      createdBy: randomUUID(),
      description: 'seed',
      id,
      label: 'Seed App',
      name: `seed-${id}`,
      protocol: 'http',
      websiteUrl,
    },
  })
  return id
}

dbTest('the first viewer fetches the icon and everyone after reads it', async () => {
  const prisma = new PrismaClient()
  const attachmentId = randomUUID()
  let fetches = 0
  try {
    const entryId = await seed(prisma, 'https://example.test/product')

    const first = await resolveAppIcon({
      actorId: randomUUID(),
      entryId,
      fetchIcon: async () => { fetches += 1; return okResponse(PNG) },
      fileService: fakeFileService(attachmentId) as never,
      organizationId: randomUUID(),
      prisma,
    })
    assert.deepEqual(first, { attachmentId })
    assert.equal(fetches, 1)

    // The second viewer — in any organisation — pays nothing. This is what
    // "the whole system shares them" means in practice.
    const second = await resolveAppIcon({
      actorId: randomUUID(),
      entryId,
      fetchIcon: async () => { fetches += 1; return okResponse(PNG) },
      fileService: fakeFileService(randomUUID()) as never,
      organizationId: randomUUID(),
      prisma,
    })
    assert.deepEqual(second, { attachmentId }, 'the shared icon, not a second copy')
    assert.equal(fetches, 1, 'no second fetch')

    const row = await prisma.mcpCatalogEntry.findUnique({
      where: { id: entryId },
      select: { iconAttachmentId: true, iconResolvedAt: true, iconSource: true },
    })
    assert.equal(row?.iconAttachmentId, attachmentId)
    assert.equal(row?.iconSource, 'site_favicon')
    assert.ok(row?.iconResolvedAt, 'the attempt is recorded')

    await prisma.mcpCatalogEntry.delete({ where: { id: entryId } })
  } finally {
    await prisma.$disconnect()
  }
})

dbTest('a site with no usable icon is attempted once, never on every paint', async () => {
  // The crawler-by-accident failure: without the `iconResolvedAt` stamp, a row
  // whose site serves no favicon would be re-fetched by every viewer forever.
  const prisma = new PrismaClient()
  let fetches = 0
  try {
    const entryId = await seed(prisma, 'https://nothing.test/')
    const missing = async () => { fetches += 1; return new Response(null, { status: 404 }) }

    assert.equal(await resolveAppIcon({
      actorId: randomUUID(), entryId, fetchIcon: missing,
      fileService: fakeFileService(randomUUID()) as never,
      organizationId: randomUUID(), prisma,
    }), null)
    const afterFirst = fetches
    assert.ok(afterFirst > 0, 'it really tried')

    assert.equal(await resolveAppIcon({
      actorId: randomUUID(), entryId, fetchIcon: missing,
      fileService: fakeFileService(randomUUID()) as never,
      organizationId: randomUUID(), prisma,
    }), null)
    assert.equal(fetches, afterFirst, 'the second view fetches nothing')

    await prisma.mcpCatalogEntry.delete({ where: { id: entryId } })
  } finally {
    await prisma.$disconnect()
  }
})

dbTest('a row with no website is settled without any outbound request', async () => {
  const prisma = new PrismaClient()
  try {
    const entryId = await seed(prisma, null)
    const resolved = await resolveAppIcon({
      actorId: randomUUID(),
      entryId,
      fetchIcon: async () => { throw new Error('must not fetch') },
      fileService: fakeFileService(randomUUID()) as never,
      organizationId: randomUUID(),
      prisma,
    })
    assert.equal(resolved, null)
    const row = await prisma.mcpCatalogEntry.findUnique({
      where: { id: entryId },
      select: { iconResolvedAt: true },
    })
    assert.ok(row?.iconResolvedAt)
    await prisma.mcpCatalogEntry.delete({ where: { id: entryId } })
  } finally {
    await prisma.$disconnect()
  }
})

dbTest('non-raster bytes are refused, whatever the server called them', async () => {
  // An SVG is a script container. It is dropped on sniffed bytes, never on the
  // remote host's `content-type`, so mislabelling it as a PNG changes nothing.
  const prisma = new PrismaClient()
  try {
    const entryId = await seed(prisma, 'https://svg.test/')
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
    const resolved = await resolveAppIcon({
      actorId: randomUUID(),
      entryId,
      fetchIcon: async () =>
        new Response(new Blob([svg]).stream() as ReadableStream<Uint8Array>, {
          headers: { 'content-type': 'image/png' },
          status: 200,
        }),
      fileService: { store: async () => { throw new Error('must not store an SVG') } } as never,
      organizationId: randomUUID(),
      prisma,
    })
    assert.equal(resolved, null)
    await prisma.mcpCatalogEntry.delete({ where: { id: entryId } })
  } finally {
    await prisma.$disconnect()
  }
})
