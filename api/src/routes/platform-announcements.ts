import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { readStreamCapped } from '../lib/markdown.js'
import type { RouteDeps } from './types.js'

const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024

const validatedImageMime = (mime: string, bytes: Buffer): string | null => {
  if (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return mime
  }
  if (mime === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) {
    return mime
  }
  if (mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP') return mime
  if (mime === 'image/gif' && /^(GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6))) return mime
  return null
}

const safeLink = (value: string): boolean => {
  if (value.startsWith('/')) {
    if (value.includes('\\')) return false
    return new URL(value, 'https://nessie.invalid').origin === 'https://nessie.invalid'
  }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const optionalLink = z.string().trim().max(2048).nullable()
  .refine((value) => value === null || safeLink(value), 'Enter an internal path or an HTTP(S) URL')
const optionalImage = z.string().trim().max(2048).nullable()
  .refine((value) => value === null || /^https?:\/\//i.test(value) && safeLink(value)
    || /^\/api\/news\/[0-9a-f-]{36}\/image$/.test(value),
  'Enter an HTTP(S) image URL or upload an image')

const youtubeId = (value: string): string | null => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase()
    let id: string | undefined
    if (host === 'youtu.be') id = url.pathname.slice(1)
    else if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
      id = url.pathname === '/watch' ? url.searchParams.get('v') ?? undefined
        : url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)$/)?.[1]
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null
  } catch {
    return null
  }
}

const optionalYoutube = z.string().trim().max(2048).nullable()
  .refine((value) => value === null || youtubeId(value) !== null, 'Enter a YouTube video link')

const BannerInput = z.object({
  text: z.string().trim().max(240),
  linkUrl: optionalLink,
  active: z.boolean(),
}).strict().refine((value) => !value.active || value.text.length > 0, {
  message: 'An active strip needs text',
})

const ArticleInput = z.object({
  title: z.string().trim().min(1).max(180),
  body: z.string().trim().max(20000),
  imageUrl: optionalImage,
  youtubeUrl: optionalYoutube,
  published: z.boolean(),
}).strict().refine((value) => !value.published || Boolean(value.body || value.imageUrl || value.youtubeUrl), {
  message: 'Add text, an image or a YouTube video before publishing',
})

const PreferencesInput = z.object({ notificationsMuted: z.boolean() }).strict()
const ReadInput = z.object({ throughVersion: z.number().int().nonnegative() }).strict()
const ArticleParams = z.object({ id: z.string().uuid() })

const articleForWire = (article: {
  id: string
  title: string
  body: string
  imageUrl: string | null
  youtubeUrl: string | null
  publishedAt: Date | null
  publicationVersion: number | null
  createdAt: Date
  updatedAt: Date
}) => ({ ...article, youtubeId: article.youtubeUrl ? youtubeId(article.youtubeUrl) : null })

/** Instance-wide publications; UOA identity and org membership remain outside this store. */
export const registerPlatformAnnouncementRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireSuperAdmin, requireUserActor } = deps

  const reader = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const actor = requireActorContext(request, reply)
    if (!actor || !requireUserActor(actor, reply)) return null
    return actor.actor.actorId
  }

  const operator = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const actor = requireActorContext(request, reply)
    return Boolean(actor && await requireSuperAdmin(actor, reply))
  }

  const nextPublicationVersion = async (): Promise<number> => {
    const rows = await prisma.$queryRaw<{ version: number }[]>`
      SELECT nextval('platform_news_publication_version_seq')::integer AS version
    `
    const version = rows[0]?.version
    if (version === undefined) throw new Error('Publication sequence returned no value')
    return version
  }

  app.get('/api/announcements/banner', async (request, reply) => {
    if (!reader(request, reply)) return reply
    const banner = await prisma.platformBanner.findUnique({ where: { id: 'current' } })
    return createApiResponse(banner?.active ? banner : null)
  })

  app.get('/api/news', async (request, reply) => {
    const userId = reader(request, reply)
    if (!userId) return reply
    const [articles, state] = await Promise.all([
      prisma.platformNewsArticle.findMany({
        where: { publicationVersion: { not: null } },
        orderBy: { publicationVersion: 'desc' },
      }),
      prisma.platformNewsReadState.findUnique({ where: { userId } }),
    ])
    const unreadCount = articles.filter((article) =>
      (article.publicationVersion ?? 0) > (state?.lastSeenPublicationVersion ?? 0)).length
    return createApiResponse({
      articles: articles.map(articleForWire),
      unreadCount,
      notificationsMuted: state?.notificationsMuted ?? false,
    })
  })

  app.get('/api/news/:id/image', async (request, reply) => {
    if (!reader(request, reply)) return reply
    const params = parseInput(ArticleParams, request.params, reply, 'params')
    if (!params) return reply
    const article = await prisma.platformNewsArticle.findUnique({
      where: { id: params.id },
      select: { publishedAt: true, image: { select: { mime: true, bytes: true } } },
    })
    if (!article?.publishedAt || !article.image) {
      return sendApiError(reply, 404, 'NOT_FOUND', 'News image not found')
    }
    reply.header('content-type', article.image.mime)
    reply.header('content-length', article.image.bytes.length)
    reply.header('cache-control', 'private, max-age=60')
    reply.header('x-content-type-options', 'nosniff')
    return reply.send(Buffer.from(article.image.bytes))
  })

  app.post('/api/news/read', async (request, reply) => {
    const userId = reader(request, reply)
    if (!userId) return reply
    const body = parseInput(ReadInput, request.body, reply)
    if (!body) return reply
    const latest = await prisma.platformNewsArticle.findFirst({
      where: { publicationVersion: { not: null } },
      orderBy: { publicationVersion: 'desc' },
      select: { publicationVersion: true },
    })
    const readThrough = Math.min(body.throughVersion, latest?.publicationVersion ?? 0)
    await prisma.$executeRaw`
      INSERT INTO platform_news_read_states (user_id, last_seen_publication_version)
      VALUES (${userId}::uuid, ${readThrough})
      ON CONFLICT (user_id) DO UPDATE
      SET last_seen_publication_version = GREATEST(
        platform_news_read_states.last_seen_publication_version,
        EXCLUDED.last_seen_publication_version
      )
    `
    return createApiResponse({ readThrough })
  })

  app.patch('/api/news/preferences', async (request, reply) => {
    const userId = reader(request, reply)
    if (!userId) return reply
    const body = parseInput(PreferencesInput, request.body, reply)
    if (!body) return reply
    const state = await prisma.platformNewsReadState.upsert({
      where: { userId },
      create: { userId, notificationsMuted: body.notificationsMuted },
      update: { notificationsMuted: body.notificationsMuted },
    })
    return createApiResponse({ notificationsMuted: state.notificationsMuted })
  })

  app.get('/api/platform/announcements', async (request, reply) => {
    if (!(await operator(request, reply))) return reply
    const [banner, articles] = await Promise.all([
      prisma.platformBanner.findUnique({ where: { id: 'current' } }),
      prisma.platformNewsArticle.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ])
    return createApiResponse({ banner, articles: articles.map(articleForWire) })
  })

  app.put('/api/platform/announcements/banner', async (request, reply) => {
    if (!(await operator(request, reply))) return reply
    const body = parseInput(BannerInput, request.body, reply)
    if (!body) return reply
    const banner = await prisma.platformBanner.upsert({
      where: { id: 'current' },
      create: { id: 'current', ...body, revision: randomUUID() },
      update: { ...body, revision: randomUUID() },
    })
    return createApiResponse(banner)
  })

  app.post('/api/platform/announcements/news', async (request, reply) => {
    if (!(await operator(request, reply))) return reply
    const body = parseInput(ArticleInput, request.body, reply)
    if (!body) return reply
    const article = await prisma.platformNewsArticle.create({
      data: {
        title: body.title,
        body: body.body,
        imageUrl: body.imageUrl,
        youtubeUrl: body.youtubeUrl,
        publishedAt: body.published ? new Date() : null,
        publicationVersion: body.published ? await nextPublicationVersion() : null,
      },
    })
    return reply.code(201).send(createApiResponse(articleForWire(article)))
  })

  app.post('/api/platform/announcements/news/:id/image', async (request, reply) => {
    if (!(await operator(request, reply))) return reply
    const params = parseInput(ArticleParams, request.params, reply, 'params')
    if (!params) return reply
    const article = await prisma.platformNewsArticle.findUnique({ where: { id: params.id } })
    if (!article) return sendApiError(reply, 404, 'NOT_FOUND', 'Article not found')
    const file = await request.file({ limits: { fileSize: IMAGE_LIMIT_BYTES } })
    if (!file) return sendApiError(reply, 400, 'NO_FILE', 'Choose an image to upload')
    const bytes = await readStreamCapped(file.file, IMAGE_LIMIT_BYTES)
    if (!bytes || file.file.truncated) {
      return sendApiError(reply, 413, 'FILE_TOO_LARGE', 'Image exceeds the 5 MB limit')
    }
    const mime = validatedImageMime(file.mimetype, bytes)
    if (!mime) {
      return sendApiError(reply, 415, 'INVALID_IMAGE', 'Use a PNG, JPEG, WebP or GIF image')
    }
    const imageUrl = `/api/news/${article.id}/image`
    const imageBytes = Uint8Array.from(bytes)
    await prisma.$transaction([
      prisma.platformNewsImage.upsert({
        where: { articleId: article.id },
        create: { articleId: article.id, mime, bytes: imageBytes },
        update: { mime, bytes: imageBytes },
      }),
      prisma.platformNewsArticle.update({ where: { id: article.id }, data: { imageUrl } }),
    ])
    return createApiResponse({ imageUrl })
  })

  app.put('/api/platform/announcements/news/:id', async (request, reply) => {
    if (!(await operator(request, reply))) return reply
    const params = parseInput(ArticleParams, request.params, reply, 'params')
    const body = parseInput(ArticleInput, request.body, reply)
    if (!params || !body) return reply
    const existing = await prisma.platformNewsArticle.findUnique({ where: { id: params.id } })
    if (!existing) return sendApiError(reply, 404, 'NOT_FOUND', 'Article not found')
    const article = await prisma.platformNewsArticle.update({
      where: { id: params.id },
      data: {
        title: body.title,
        body: body.body,
        imageUrl: body.imageUrl,
        youtubeUrl: body.youtubeUrl,
        publishedAt: body.published ? existing.publishedAt ?? new Date() : null,
        publicationVersion: body.published
          ? existing.publicationVersion ?? await nextPublicationVersion() : null,
      },
    })
    return createApiResponse(articleForWire(article))
  })

  app.delete('/api/platform/announcements/news/:id', async (request, reply) => {
    if (!(await operator(request, reply))) return reply
    const params = parseInput(ArticleParams, request.params, reply, 'params')
    if (!params) return reply
    const deleted = await prisma.platformNewsArticle.deleteMany({ where: { id: params.id } })
    if (deleted.count === 0) return sendApiError(reply, 404, 'NOT_FOUND', 'Article not found')
    return createApiResponse({ deleted: true })
  })
}
