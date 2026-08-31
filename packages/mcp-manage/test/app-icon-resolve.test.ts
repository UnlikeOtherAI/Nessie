import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  appIconIsResolvable,
  declaredAppIconCandidate,
  resolveAppIcon,
} from '../src/apps/app-icon-resolve.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

/**
 * The store rendered a monogram on all 5,548 rows because icon caching was
 * wired only into the owner-triggered sync, and the scheduled sweep — the only
 * sync that ever wrote rows in production — passes no cacher. These assert the
 * replacement: resolve when somebody looks, once, and share the result.
 */

// ─── What is worth asking about ───────────────────────────────────────────

test('a row is only worth asking about while an icon is still possible', () => {
  const base = {
    iconAttachmentId: null,
    iconResolvedAt: null,
    iconUrl: null,
    repositoryUrl: null,
    websiteUrl: null,
  }
  // Cached: always ask, that is the whole point.
  assert.equal(appIconIsResolvable({ ...base, iconAttachmentId: 'att-1' }), true)
  // Never tried and has somewhere to look: ask, and the route resolves.
  assert.equal(appIconIsResolvable({ ...base, websiteUrl: 'https://example.com' }), true)
  // Tried, found nothing: stop asking, or the grid re-fetches on every paint.
  assert.equal(appIconIsResolvable({ ...base, iconResolvedAt: new Date(), websiteUrl: 'https://example.com' }), false)
  // A publisher-declared Registry icon has no reason to require a website.
  assert.equal(appIconIsResolvable({ ...base, iconUrl: 'https://cdn.example.test/icon.png' }), true)
  // Nor does a GitHub publisher avatar derived from a repository URL.
  assert.equal(appIconIsResolvable({ ...base, repositoryUrl: 'https://github.com/acme/app' }), true)
  // A repository host with no supported icon derivation does not create a dead route.
  assert.equal(appIconIsResolvable({ ...base, repositoryUrl: 'https://gitlab.com/acme/app' }), false)
  // Nowhere to look.
  assert.equal(appIconIsResolvable(base), false)
})

test('lazy resolution reselects from preserved Registry icon metadata', () => {
  const upstream = {
    name: 'io.example/icon-app',
    declaredIcons: [
      { src: 'https://cdn.example.test/dark.png', mimeType: 'image/png', sizes: '128x128', theme: 'dark' },
      { src: 'https://cdn.example.test/shared.png', mimeType: 'image/png', sizes: '128x128', theme: null },
    ],
  }
  assert.deepEqual(
    declaredAppIconCandidate(upstream, 'https://cdn.example.test/legacy.png'),
    { source: 'mcp_registry', url: 'https://cdn.example.test/shared.png' },
  )
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
    // Not an exact count: the chain asks several sources (a homepage scan
    // precedes the icon fetch), and pinning a number here would encode today's
    // internal order rather than the behaviour anybody depends on.
    const afterFirst = fetches
    assert.ok(afterFirst > 0, 'the first viewer really fetched')

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
    assert.equal(fetches, afterFirst, 'the second viewer fetched nothing')

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
