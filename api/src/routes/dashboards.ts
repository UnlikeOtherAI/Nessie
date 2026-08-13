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
import { DashboardAccessError } from '@nessie/dashboard'
import { DashboardFetchError, DashboardNormalizeError } from '@nessie/dashboard'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  DashboardServiceError,
  createDashboard,
  getDashboardWithWidgets,
  listDashboardsForActor,
  recordDashboardVersion,
  summarizeChange,
  validateLayout,
} from '../services/dashboards.js'
import {
  addWidget,
  loadSnapshotProjection,
  loadWidgetProjection,
  removeWidget,
  setWidgetLock,
  updateWidget,
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
import type { DashboardLayout } from '@nessie/schemas'
import { DashboardLayoutSchema } from '@nessie/schemas'

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
    const detail = error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ')
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
  const { prisma, requireActorContext, requireUserActor, egressPolicy, credentials } = deps
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

    try {
      const dashboard = await getDashboardWithWidgets(context, params.id)
      const kinds = new Map(
        dashboard.widgets.map((widget) => [widget.id, widget.kind as never]),
      )
      validateLayout(layout, kinds)

      const before = {
        widgets: dashboard.widgets.map((widget) => ({ id: widget.id, kind: widget.kind })),
        layout: dashboard.layout as unknown as DashboardLayout,
      }
      const after = { widgets: before.widgets, layout }

      const updated = await prisma.$transaction(async (tx) => {
        const saved = await tx.dashboard.update({
          where: { id: dashboard.id },
          data: { layout: layout as never, revision: { increment: 1 } },
        })
        await recordDashboardVersion(tx, {
          organizationId: context.actor.organizationId,
          dashboardId: dashboard.id,
          layout,
          widgets: dashboard.widgets.map((widget) => ({
            id: widget.id,
            kind: widget.kind,
            spec: widget.spec,
          })),
          authorType: 'user',
          authorId: context.actor.userId,
          summary: summarizeChange(before, after),
        })
        return saved
      })
      return createApiResponse(updated)
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
      const widget = await addWidget(context, {
        dashboardId: params.id,
        definition: request.body,
      })
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
      const widget = await updateWidget(context, {
        widgetId: params.id,
        definition: request.body,
        byAgent: false,
      })
      return createApiResponse(widget)
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
      await removeWidget(context, { widgetId: params.id, byAgent: false })
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
      return createApiResponse(await setWidgetLock(context, { widgetId: params.id, locked: body.locked }))
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
