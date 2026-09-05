/**
 * Dashboard HTTP surface.
 *
 * Every handler resolves the acting member from the live OrganizationMember row
 * and then calls the same service function the agent tools call. Nothing here
 * makes an authorization decision of its own — that lives in
 * `resolveDashboardAccess` inside the services, so the HTTP and tool paths
 * cannot drift apart.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  DASHBOARD_STATIC_IMPORT_FORMATS,
  DASHBOARD_REFRESH_TOPIC,
  DashboardAccessError,
  importStaticDashboardSource,
  listDashboardSourceNotes,
} from '@nessie/dashboard'
import { DashboardFetchError, DashboardNormalizeError } from '@nessie/dashboard'
import { formatZodIssues } from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  readIfMatchRevision,
  sendMalformedIfMatch,
  sendRevisionConflict,
} from '../lib/if-match.js'
import {
  DashboardServiceError,
  DashboardRevisionConflictError,
  applyDashboardDelta,
  createDashboard,
  getDashboardWithWidgets,
  listDashboardsForActor,
} from '../services/dashboards.js'
import {
  loadSnapshotProjection,
  loadWidgetProjection,
} from '../services/dashboard-widgets.js'
import {
  createDashboardSource,
  listDashboardSources,
  probeSource,
  setSourceCredential,
} from '../services/dashboard-sources.js'
import {
  createDashboardMembership,
  resolveDashboardActor,
} from '../services/dashboard-membership.js'
import {
  createEmbedPlacement,
  freezeWidgetSnapshot,
  grantDashboardAccess,
  listDashboardGrants,
  resolveEmbedForViewer,
  revokeDashboardGrant,
} from '@nessie/dashboard'
import { createDashboardDatasetLoader } from '../services/dashboard-runtime.js'
import type { RouteDeps } from './types.js'
import type { DashboardEgressPolicy } from '@nessie/dashboard'
import { DashboardDeltaSchema, DashboardLayoutSchema } from '@nessie/schemas'
import { randomUUID } from 'node:crypto'
import { enqueueQueueJob } from '../queue/pgqueue.js'

const HomeSchema = z.enum(['organization', 'project', 'team', 'channel', 'personal'])

const CreateDashboardBodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  home: HomeSchema,
  projectId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  channelId: z.string().uuid().optional(),
}).strict()

const CreateSourceBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  origin: z.string().trim().min(1).max(300),
  path: z.string().trim().max(500).optional(),
  queryParams: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  transform: z.string().trim().min(1),
  outputColumns: z.unknown(),
  refreshMode: z.enum(['manual', 'interval']).optional(),
  intervalMinutes: z.number().int().optional(),
}).strict()

const ImportStaticSourceBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  format: z.enum(DASHBOARD_STATIC_IMPORT_FORMATS),
  // XLSX is base64 over this JSON API, which expands a 256 KiB binary source
  // to at most 350 KiB before the importer rechecks the decoded byte cap.
  content: z.string().min(1).max(350 * 1024),
  // The importer re-authorizes this attachment against the live actor and
  // retains a dashboard-owned copy of its bytes. It is never a bare download.
  originalAttachmentId: z.string().uuid().optional(),
  sourceReference: z.string().trim().min(1).max(500).optional(),
  canonicalUrl: z.string().url().max(2_000).optional(),
  provenance: z.record(z.string().max(80), z.unknown()).optional(),
}).strict()

const ProbeBodySchema = z.object({
  sourceId: z.string().uuid().optional(),
  origin: z.string().trim().max(300).optional(),
  path: z.string().trim().max(500).optional(),
  queryParams: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  transform: z.string().trim().min(1).optional(),
  outputColumns: z.unknown().optional(),
}).strict()

/**
 * Note what this schema does NOT accept: a credential reference. Only plaintext
 * arrives, exactly once, and only a server-minted ref is ever persisted.
 */
const CredentialBodySchema = z.object({
  mode: z.enum(['bearer', 'header']),
  headerName: z.string().trim().max(64).optional(),
  plaintext: z.string().min(1).max(4096),
}).strict()

const IdParamsSchema = z.object({ id: z.string().uuid() }).strict()

const EmbedBodySchema = z.object({
  mode: z.enum(['live', 'static']),
  widgetId: z.string().uuid().optional(),
  widgetSnapshotId: z.string().uuid().optional(),
  targetType: z.enum(['message', 'knowledge_page_version']),
  targetId: z.string().uuid(),
}).strict()

const GrantBodySchema = z.object({
  subjectType: z.enum(['user', 'agent', 'channel', 'team', 'project', 'knowledge_space']),
  subjectId: z.string().uuid(),
  level: z.enum(['view', 'edit']),
}).strict()

const sendDashboardError = (reply: Parameters<typeof sendApiError>[0], error: unknown): boolean => {
  if (error instanceof z.ZodError) {
    // A malformed widget definition is an author error, not a server fault.
    // Without this the contract still rejects the payload — but as a 500 with
    // no usable message, which makes an agent retry blindly instead of fixing
    // the field it got wrong.
    const detail = formatZodIssues(error, { emptyPathLabel: 'body', separator: ': ' })
    sendApiError(reply, 400, 'DASHBOARD_WIDGET_INVALID', detail)
    return true
  }
  if (error instanceof DashboardAccessError) {
    // `not_found` for an unreachable resource: a viewer with no path to a
    // dashboard should not learn that the id exists.
    const status = error.decision.reason === 'not_found' ? 404 : 403
    sendApiError(reply, status, `DASHBOARD_${error.decision.reason.toUpperCase()}`, 'not available')
    return true
  }
  if (error instanceof DashboardRevisionConflictError) {
    sendRevisionConflict(
      reply as never,
      error.code,
      error.message,
      error.currentRevision,
    )
    return true
  }
  if (error instanceof DashboardServiceError) {
    sendApiError(reply, error.httpStatus, error.code, error.message)
    return true
  }
  if (error instanceof DashboardFetchError || error instanceof DashboardNormalizeError) {
    // A stable code and an operator-safe detail. Never an upstream body.
    sendApiError(reply, 422, error.code, error.detail ?? error.code)
    return true
  }
  return false
}

export const registerDashboardRoutes = (
  app: FastifyInstance,
  deps: RouteDeps & { egressPolicy: DashboardEgressPolicy; credentials: Parameters<typeof setSourceCredential>[2] },
): void => {
  const { prisma, requireActorContext, requireUserActor, egressPolicy, credentials, realtimeHub } = deps
  const membership = createDashboardMembership(prisma)

  const contextFor = async (request: unknown, reply: never) => {
    const actorContext = requireActorContext(request as never, reply)
    if (!actorContext) return null
    if (!requireUserActor(actorContext, reply)) return null

    const actor = await resolveDashboardActor(prisma, {
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!actor) {
      sendApiError(reply, 403, 'DASHBOARD_FORBIDDEN', 'membership is not active')
      return null
    }
    return { prisma, membership, actor }
  }
  const dashboardForWidget = async (context: NonNullable<Awaited<ReturnType<typeof contextFor>>>, widgetId: string) => {
    const widget = await prisma.dashboardWidget.findFirst({
      where: { id: widgetId, organizationId: context.actor.organizationId },
      select: { dashboardId: true },
    })
    if (!widget) throw new DashboardServiceError(404, 'DASHBOARD_WIDGET_NOT_FOUND', 'widget not found')
    return getDashboardWithWidgets(context, widget.dashboardId)
  }

  const applyAndPublish = async (
    context: NonNullable<Awaited<ReturnType<typeof contextFor>>>,
    input: Parameters<typeof applyDashboardDelta>[1],
  ) => {
    const result = await applyDashboardDelta(context, input)
    if (!result.replayed) {
      await realtimeHub.publishWs([{ kind: 'dashboard', dashboardId: result.dashboard.id }], {
        event: 'dashboard.updated',
        data: { dashboardId: result.dashboard.id, revision: result.dashboard.revision },
      })
    }
    return result
  }

  app.get('/api/dashboards', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const query = request.query as { home?: string; projectId?: string }
    const dashboards = await listDashboardsForActor(context, {
      ...(query.home ? { home: HomeSchema.parse(query.home) } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
    })
    return createApiResponse(dashboards)
  })

  app.post('/api/dashboards', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const body = parseInput(CreateDashboardBodySchema, request.body, reply, 'body')
    if (!body) return reply
    try {
      return createApiResponse(await createDashboard(context, body))
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/dashboards/:id', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      return createApiResponse(await getDashboardWithWidgets(context, params.id))
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.put('/api/dashboards/:id/layout', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const layout = parseInput(DashboardLayoutSchema, request.body, reply, 'body')
    if (!layout) return reply
    // The admin's edit mode auto-saves, so it states the revision it edited.
    // A stale editor is refused rather than silently overwriting a widget an
    // agent moved a second ago; the client renders the choice in place.
    const ifMatch = readIfMatchRevision(request)
    if (ifMatch.kind === 'malformed') return sendMalformedIfMatch(reply as never)

    try {
      const dashboard = await getDashboardWithWidgets(context, params.id)
      const baseRevision = ifMatch.kind === 'revision' ? ifMatch.revision : dashboard.revision
      const result = await applyAndPublish(context, {
        dashboardId: params.id,
        schemaVersion: 1,
        mutationId: randomUUID(),
        baseRevision,
        operations: [{ type: 'set_layout', layout }],
      })
      return createApiResponse(result.dashboard)
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/dashboards/:id/source-notes', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      return createApiResponse(await listDashboardSourceNotes(context, params.id))
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  // The canonical mutation contract. Clients retry the same mutation id after
  // reconnect; stale or out-of-order revisions receive a visible 409 and make
  // no partial change. Legacy UI routes below are thin adapters onto this path.
  app.post('/api/dashboards/:id/deltas', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const body = parseInput(DashboardDeltaSchema, request.body, reply, 'body')
    if (!body) return reply
    try {
      return createApiResponse(await applyAndPublish(context, {
        dashboardId: params.id,
        ...body,
      }))
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/dashboards/:id/widgets', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      const dashboard = await getDashboardWithWidgets(context, params.id)
      const widgetId = randomUUID()
      await applyAndPublish(context, {
        dashboardId: params.id,
        schemaVersion: 1,
        mutationId: randomUUID(),
        baseRevision: dashboard.revision,
        operations: [{ type: 'add_widget', widgetId, definition: request.body }],
      })
      const widget = await prisma.dashboardWidget.findUniqueOrThrow({ where: { id: widgetId } })
      return createApiResponse(widget)
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.put('/api/dashboard-widgets/:id', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      const dashboard = await dashboardForWidget(context, params.id)
      await applyAndPublish(context, {
        dashboardId: dashboard.id,
        schemaVersion: 1,
        mutationId: randomUUID(),
        baseRevision: dashboard.revision,
        operations: [{ type: 'update_widget', widgetId: params.id, definition: request.body }],
      })
      return createApiResponse(await prisma.dashboardWidget.findUniqueOrThrow({ where: { id: params.id } }))
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/dashboard-widgets/:id', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      const dashboard = await dashboardForWidget(context, params.id)
      await applyAndPublish(context, {
        dashboardId: dashboard.id,
        schemaVersion: 1,
        mutationId: randomUUID(),
        baseRevision: dashboard.revision,
        operations: [{ type: 'remove_widget', widgetId: params.id }],
      })
      return createApiResponse({ removed: true })
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.put('/api/dashboard-widgets/:id/lock', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const body = parseInput(z.object({ locked: z.boolean() }).strict(), request.body, reply, 'body')
    if (!body) return reply
    try {
      const dashboard = await dashboardForWidget(context, params.id)
      const result = await applyAndPublish(context, {
        dashboardId: dashboard.id,
        schemaVersion: 1,
        mutationId: randomUUID(),
        baseRevision: dashboard.revision,
        operations: [{ type: 'set_widget_lock', widgetId: params.id, locked: body.locked }],
      })
      return createApiResponse(result.dashboard)
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/dashboard-widgets/:id/data', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const query = request.query as { compact?: string }
    try {
      const projection = await loadWidgetProjection(
        context,
        {
          widgetId: params.id,
          loadDataset: createDashboardDatasetLoader(
            deps.fileService,
            context.actor.organizationId,
          ),
        },
        { compact: query.compact === 'true' },
      )
      return createApiResponse(projection)
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/dashboard-widgets/:id/refresh', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      const widget = await prisma.dashboardWidget.findFirst({
        where: { id: params.id, organizationId: context.actor.organizationId },
        select: {
          id: true,
          source: {
            select: {
              archivedAt: true,
              id: true,
              kind: true,
            },
          },
        },
      })
      if (!widget) {
        throw new DashboardServiceError(404, 'DASHBOARD_WIDGET_NOT_FOUND', 'widget not found')
      }
      await dashboardForWidget(context, params.id)
      if (widget.source.archivedAt) {
        throw new DashboardServiceError(404, 'DASHBOARD_SOURCE_NOT_FOUND', 'data source not found')
      }
      if (widget.source.kind !== 'http') {
        return createApiResponse({ enqueued: false, reason: 'static_source' })
      }
      const enqueued = await enqueueQueueJob(prisma, {
        payload: { sourceId: widget.source.id },
        topic: DASHBOARD_REFRESH_TOPIC,
      })
      return createApiResponse({ enqueued })
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/dashboard-sources', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    return createApiResponse(await listDashboardSources(context))
  })

  app.post('/api/dashboard-sources', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const body = parseInput(CreateSourceBodySchema, request.body, reply, 'body')
    if (!body) return reply
    try {
      return createApiResponse(await createDashboardSource(context, body, egressPolicy))
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/dashboard-sources/import', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const body = parseInput(ImportStaticSourceBodySchema, request.body, reply, 'body')
    if (!body) return reply
    try {
      return createApiResponse(await importStaticDashboardSource(context, {
        ...body,
        // HTTP uploads are private to the submitting user until an entitled
        // source basis is established by an agent run. This is never inferred
        // from an arbitrary client-supplied locator.
        accessBasis: [{ scopeId: context.actor.userId, scopeType: 'user' }],
      }, deps.fileService))
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/dashboard-sources/probe', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const body = parseInput(ProbeBodySchema, request.body, reply, 'body')
    if (!body) return reply
    try {
      return createApiResponse(await probeSource(context, body, egressPolicy, credentials))
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.put('/api/dashboard-sources/:id/credential', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const body = parseInput(CredentialBodySchema, request.body, reply, 'body')
    if (!body) return reply
    try {
      const result = await setSourceCredential(
        context,
        { sourceId: params.id, ...body },
        credentials,
      )
      // The response carries no part of the value, no ref, and no length.
      return createApiResponse(result)
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  // Freeze the current moment. A snapshot is what makes a widget quotable:
  // it pins the spec and the exact dataset so a later edit or a retention
  // sweep cannot change what somebody quoted into a conversation.
  app.post('/api/dashboard-widgets/:id/freeze', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      const snapshot = await freezeWidgetSnapshot(context, { widgetId: params.id })
      return createApiResponse({ snapshotId: snapshot.id, createdAt: snapshot.createdAt })
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/dashboard-embeds', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const body = parseInput(EmbedBodySchema, request.body, reply, 'body')
    if (!body) return reply
    try {
      const placement = await createEmbedPlacement(context, body)
      return createApiResponse({ embedId: placement.id })
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  // The one read path all three surfaces share. Both checks run here, so a
  // copied embed id is worth nothing on its own.
  app.get('/api/dashboard-embeds/:id', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      const resolved = await resolveEmbedForViewer(context, { embedId: params.id })
      if (!resolved.visible) {
        return createApiResponse({ visible: false })
      }
      const widgetId = resolved.mode === 'live' ? resolved.widgetId : null
      const projection = widgetId
        ? await loadWidgetProjection(
          context,
          {
            widgetId,
            loadDataset: createDashboardDatasetLoader(
              deps.fileService,
              context.actor.organizationId,
            ),
          },
          { compact: true },
        )
        : await loadSnapshotProjection(
          context,
          resolved.widgetSnapshotId as string,
          createDashboardDatasetLoader(deps.fileService, context.actor.organizationId),
        )
      return createApiResponse({ visible: true, mode: resolved.mode, projection })
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/dashboards/:id/grants', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      return createApiResponse(await listDashboardGrants(context, { dashboardId: params.id }))
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/dashboards/:id/grants', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    const body = parseInput(GrantBodySchema, request.body, reply, 'body')
    if (!body) return reply
    try {
      const grant = await grantDashboardAccess(context, { dashboardId: params.id, ...body })
      return createApiResponse(grant)
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/dashboard-grants/:id', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      await revokeDashboardGrant(context, { grantId: params.id })
      return createApiResponse({ revoked: true })
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })

  app.get('/api/dashboards/:id/versions', async (request, reply) => {
    const context = await contextFor(request, reply as never)
    if (!context) return reply
    const params = parseInput(IdParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      await getDashboardWithWidgets(context, params.id)
      const versions = await prisma.dashboardVersion.findMany({
        where: { dashboardId: params.id, organizationId: context.actor.organizationId },
        orderBy: { versionNumber: 'desc' },
        take: 50,
      })
      return createApiResponse(versions)
    } catch (error) {
      if (sendDashboardError(reply, error)) return reply
      throw error
    }
  })
}
