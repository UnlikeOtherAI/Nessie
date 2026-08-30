import { AppCategorySchema } from '@nessie/schemas'
import {
  CATEGORY_PAGE_LIMIT,
  CATEGORY_PAGE_LIMIT_MAX,
  getStoreApp,
  listStoreAppCategories,
  listStoreApps,
  storeCatalogWhere,
} from '@nessie/mcp-manage'
import { attributionFromActorContext } from '@nessie/runtime'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'

import { streamAttachmentDownload } from './uploads.js'
import type { RouteDeps } from './types.js'

/**
 * App Store read surface (`docs/plans/2026-08-29-mcp-app-store/`).
 *
 * `/api/apps` is a projection of `McpCatalogEntry`, not a second view of
 * `/api/mcp/catalog`. The connector surface answers "how is this server
 * configured" for whoever governs the catalog; this one answers "which apps can
 * I connect, and which have I connected already" for any active member. That
 * difference in audience is what decides the payload: every member of the
 * instance can read these routes, so nothing here carries an endpoint,
 * transport, auth config, or credential ref — the presenter in
 * `@nessie/mcp-manage` builds the records, and no handler below reaches past it
 * to a raw row.
 *
 * Listing, search, the tenancy floor, the moderation/trust gate, and the
 * entitlement-scoped connection counts all live in that shared package so the
 * worker's assistant tools can answer the same questions from the same rows.
 * These handlers validate input and pick a status code; nothing else.
 *
 * **`GET /api/apps` is bounded and always has been counted separately.** The
 * registry puts thousands of apps in this catalogue, so the response body is a
 * slice — the featured strip plus a shelf per category, one category's page, or
 * a search's top results — while `totalCount`, `installedCount`, and every
 * `categories[].count` remain SQL aggregates over the whole set. A client that
 * needs more of one category asks for the next page; it never infers a total
 * from what it was handed.
 */

const AppListQuerySchema = z.object({
  query: z.string().max(200).optional(),
  category: AppCategorySchema.optional(),
  // A query string carries no booleans, and the catalogue's filter control has
  // exactly one narrowing today ("Installed"), so the enum is the vocabulary.
  installed: z.enum(['true', 'false']).optional(),
  // Paging is a property of a category page. The default shelf and a search
  // have fixed sizes the server owns, so `limit`/`offset` are simply ignored
  // there rather than quietly resizing a view the client did not ask to page.
  limit: z.coerce.number().int().min(1).max(CATEGORY_PAGE_LIMIT_MAX).optional(),
  // Offset rather than an opaque cursor: `SHELF_ORDER` is a total order on
  // (label, id), so a page boundary is stable without one, and a deep link to
  // "the third page of Development" stays a readable URL.
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
})

const AppSlugParamsSchema = z.object({
  slug: z.string().min(1).max(200),
})

const AppIconParamsSchema = z.object({
  id: z.string().uuid(),
})

export const registerAppRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, fileService } = deps

  app.get('/api/apps', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = parseInput(AppListQuerySchema, request.query ?? {}, reply, 'query')
    if (!query) return reply

    const result = await listStoreApps(prisma, actorContext, {
      query: query.query,
      category: query.category,
      // An absent filter is not `installed=false`: the control's "All" asks for
      // no narrowing, while `false` would ask for the apps I have *not*
      // connected — a filter nobody offered.
      installed: query.installed === undefined ? undefined : query.installed === 'true',
      limit: query.limit ?? CATEGORY_PAGE_LIMIT,
      offset: query.offset,
    })
    return createApiResponse(result)
  })

  app.get('/api/apps/categories', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const categories = await listStoreAppCategories(prisma, actorContext)
    return createApiResponse({ categories })
  })

  app.get('/api/apps/:slug', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const params = parseInput(AppSlugParamsSchema, request.params, reply, 'slug')
    if (!params) return reply

    // An app hidden by tenancy, moderation, or a `blocked` trust level answers
    // exactly as an app that never existed. The store's membership is not a
    // secret worth a 403 that confirms the slug.
    const record = await getStoreApp(prisma, actorContext, params.slug)
    if (!record) {
      sendApiError(reply, 404, 'APP_NOT_FOUND', 'App not found')
      return reply
    }
    return createApiResponse(record)
  })

  /**
   * Icon bytes for one app, keyed by the catalog entry's id.
   *
   * Every app record's `iconUrl` names this path or is null — an upstream icon
   * URL never reaches a client, because rendering one would have every member's
   * browser announce the store visit to a third-party host and fetch untrusted
   * SVG. The bytes served here are the Nessie-cached attachment the registry
   * sync validated (MIME-sniffed to PNG/JPEG/WebP, size-capped) and stored
   * through the one `FileService`.
   *
   * Gated by the same `storeCatalogWhere` floor as the detail route, so an app a
   * caller cannot see in the store cannot have its icon fished out by id either.
   * The icon attachment is owned by whichever org cached it — registry rows are
   * instance-global, so that is the sync-triggering org, not the viewer's — so
   * the bytes are streamed under the attachment's *own* org, which is why its
   * `organizationId` is looked up first (metadata only; the bytes still flow
   * through `FileService.openStream`). A dangling reference (its org deleted, the
   * cascade took the bytes) simply 404s and the client falls back to a monogram.
   */
  app.get('/api/apps/:id/icon', async (request, reply) => {
    const startedAt = Date.now()
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const params = parseInput(AppIconParamsSchema, request.params, reply, 'id')
    if (!params) return reply

    const entry = await prisma.mcpCatalogEntry.findFirst({
      where: {
        AND: [{ id: params.id, iconAttachmentId: { not: null } }, storeCatalogWhere(actorContext)],
      },
      select: { iconAttachmentId: true },
    })
    if (!entry?.iconAttachmentId) {
      sendApiError(reply, 404, 'APP_ICON_NOT_FOUND', 'This app has no cached icon')
      return reply
    }

    const owner = await prisma.attachment.findUnique({
      where: { id: entry.iconAttachmentId },
      select: { organizationId: true },
    })
    const opened = owner
      ? await fileService.openStream(entry.iconAttachmentId, owner.organizationId)
      : null
    if (!opened) {
      sendApiError(reply, 404, 'APP_ICON_NOT_FOUND', 'This app has no cached icon')
      return reply
    }

    return streamAttachmentDownload(request, reply, opened, {
      attribution: attributionFromActorContext(actorContext),
      prisma,
      source: 'api.apps.icon',
      startedAt,
    })
  })
}
