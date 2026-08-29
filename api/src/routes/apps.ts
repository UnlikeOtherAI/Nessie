import { AppCategorySchema } from '@nessie/schemas'
import { getStoreApp, listStoreAppCategories, listStoreApps } from '@nessie/mcp-manage'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'

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
 */

const AppListQuerySchema = z.object({
  query: z.string().max(200).optional(),
  category: AppCategorySchema.optional(),
  // A query string carries no booleans, and the catalogue's filter control has
  // exactly one narrowing today ("Installed"), so the enum is the vocabulary.
  installed: z.enum(['true', 'false']).optional(),
})

const AppSlugParamsSchema = z.object({
  slug: z.string().min(1).max(200),
})

const AppIconParamsSchema = z.object({
  id: z.string().uuid(),
})

export const registerAppRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

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
   * browser announce the store visit to a third-party host. Icons become
   * Nessie-served attachments in the registry-sync phase; until a row carries
   * one the presenter emits null and nothing requests this, so a request that
   * does arrive is for an icon this instance has not cached.
   */
  app.get('/api/apps/:id/icon', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const params = parseInput(AppIconParamsSchema, request.params, reply, 'id')
    if (!params) return reply

    sendApiError(reply, 404, 'APP_ICON_NOT_FOUND', 'This app has no cached icon')
    return reply
  })
}
