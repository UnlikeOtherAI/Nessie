import type { FastifyInstance } from 'fastify'

import {
  AdapterNotRegisteredError,
  type ContainerDescription,
  resolveBoardSourceAdapter,
} from '@nessie/board-sources'
import {
  BOARD_SOURCE_SYNC_INITIAL_TOPIC,
  BoardSourceDetailRecordSchema,
  BoardSourceRecordSchema,
  CreateBoardSourceBodySchema,
  PutBoardSourceMappingsBodySchema,
  UpdateBoardSourceBodySchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { enqueueQueueJob } from '@nessie/db'
import {
  createBoardSource,
  createTaskFieldDefinition,
  deleteBoardSource,
  getBoardSourceDetail,
  isBoardSourceError,
  listBoardSources,
  listTaskFieldDefinitions,
  loadBoardSourceConnectionContext,
  isBoardSourceCredentialError,
  putBoardSourceMappings,
  updateBoardSource,
} from '@nessie/team-admin'

import { createApiResponse, parseInput, sendApiError } from '../../lib/api.js'
import type { RouteDeps } from '../types.js'

/**
 * A project's data sources. Reading them is part of reading the project;
 * attaching, mapping and removing them is administering it — with the extra
 * rule that the connection a source runs under must belong to whoever attaches
 * it, because a sync carries that person's delegated authority.
 */
export const registerBoardSourceRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, config, requireActorContext, requireProjectAdmin, isProjectAccessibleToActor } =
    deps

  const loadProject = async (actorContext: AuthorizedActionContext, projectId: string) => {
    if (!(await isProjectAccessibleToActor(actorContext, projectId))) return null
    return prisma.project.findFirst({
      where: { id: projectId, organizationId: actorContext.tenant.organizationId },
      select: { id: true, organizationId: true },
    })
  }

  const sourceError = (
    reply: Parameters<typeof sendApiError>[0],
    result: { error: string; detail?: string },
  ): void => {
    switch (result.error) {
      case 'SOURCE_NOT_FOUND':
        sendApiError(reply, 404, 'SOURCE_NOT_FOUND', 'Source not found')
        return
      case 'CONNECTION_NOT_FOUND':
        sendApiError(reply, 404, 'CONNECTION_NOT_FOUND', 'Connection not found')
        return
      case 'CONNECTION_NOT_OWNED':
        sendApiError(
          reply,
          403,
          'CONNECTION_NOT_OWNED',
          'A source runs under its connection owner’s account, so only they can point it at a project. Connect your own account first.',
        )
        return
      case 'CONTAINER_ALREADY_ATTACHED':
        sendApiError(
          reply,
          409,
          'CONTAINER_ALREADY_ATTACHED',
          'That container already feeds this project.',
        )
        return
      default:
        sendApiError(reply, 400, 'SOURCE_INVALID', result.detail ?? 'Source request refused')
    }
  }

  /** The adapter's description of a container, or null when it cannot be read. */
  const describe = async (
    connectionId: string,
    provider: 'jira' | 'linear' | 'trello' | 'github',
    container: Record<string, unknown>,
  ): Promise<ContainerDescription | null> => {
    const context = await loadBoardSourceConnectionContext(
      prisma,
      connectionId,
      config.auth.secret ?? '',
    )
    if (isBoardSourceCredentialError(context)) return null
    try {
      return await resolveBoardSourceAdapter(provider).describeContainer(context, container)
    } catch {
      return null
    }
  }

  /**
   * Take this source's webhook down with it.
   *
   * Best-effort by design: a source must stay removable when the provider is
   * unreachable or the credential has already been revoked. What it prevents is
   * the person's Linear or GitHub accumulating a callback per removed source,
   * each pointed at a URL that will answer 202 and drop the delivery forever.
   */
  const unregisterWebhook = async (projectId: string, sourceId: string): Promise<void> => {
    const source = await prisma.boardSource.findFirst({
      where: { id: sourceId, projectId },
      select: {
        connectionId: true,
        container: true,
        provider: true,
        webhookExternalId: true,
      },
    })
    if (!source?.webhookExternalId) return
    try {
      const adapter = resolveBoardSourceAdapter(source.provider)
      if (!adapter.removeWebhook) return
      const context = await loadBoardSourceConnectionContext(
        prisma,
        source.connectionId,
        config.auth.secret ?? '',
      )
      if (isBoardSourceCredentialError(context)) return
      await adapter.removeWebhook(
        context,
        source.container as Record<string, unknown>,
        source.webhookExternalId,
      )
    } catch {
      // Deliberately swallowed: see above.
    }
  }

  app.get('/api/projects/:projectId/sources', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { projectId } = request.params as { projectId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    return createApiResponse(
      BoardSourceRecordSchema.array().parse(await listBoardSources(prisma, project.id)),
    )
  })

  app.post('/api/projects/:projectId/sources', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { projectId } = request.params as { projectId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
    const body = parseInput(CreateBoardSourceBodySchema, request.body, reply)
    if (!body) return reply

    const connection = await prisma.boardSourceConnection.findFirst({
      where: { id: body.connectionId, organizationId: project.organizationId },
      select: { id: true, provider: true },
    })
    if (!connection) {
      sendApiError(reply, 404, 'CONNECTION_NOT_FOUND', 'Connection not found')
      return reply
    }

    let adapter
    try {
      adapter = resolveBoardSourceAdapter(connection.provider)
    } catch (cause) {
      if (cause instanceof AdapterNotRegisteredError) {
        sendApiError(reply, 503, 'PROVIDER_NOT_CONFIGURED', 'That provider is not configured.')
        return reply
      }
      throw cause
    }

    const description = await describe(connection.id, connection.provider, body.container)
    if (!description) {
      sendApiError(
        reply,
        502,
        'CONTAINER_UNREADABLE',
        'That container could not be read with this connection.',
      )
      return reply
    }

    // The adapter's fields become custom fields of the project, reusing an
    // existing definition of the same name rather than making a duplicate.
    const existing = await listTaskFieldDefinitions(prisma, project.id)
    const fieldTargets: Record<string, string> = {}
    for (const field of description.fields) {
      const match = existing.find(
        (definition) => definition.name === field.label && definition.type === field.type,
      )
      if (match) {
        fieldTargets[field.key] = `field:${match.id}`
        continue
      }
      const created = await createTaskFieldDefinition(prisma, project, {
        name: field.label,
        type: field.type,
        ...(field.options ? { options: field.options } : {}),
        createdByUserId: actorContext.actor.actorId,
      })
      if ('id' in created) fieldTargets[field.key] = `field:${created.id}`
    }

    const containers = await adapter.listContainers(
      (await loadBoardSourceConnectionContext(
        prisma,
        connection.id,
        config.auth.secret ?? '',
      )) as Parameters<typeof adapter.listContainers>[0],
    )
    const descriptor = containers.find(
      (candidate) =>
        JSON.stringify(candidate.container) === JSON.stringify(body.container),
    )
    if (!descriptor) {
      sendApiError(reply, 404, 'CONTAINER_NOT_FOUND', 'That container is not reachable.')
      return reply
    }

    const result = await createBoardSource(prisma, {
      projectId: project.id,
      organizationId: project.organizationId,
      connectionId: connection.id,
      provider: connection.provider,
      container: body.container,
      containerKey: descriptor.key,
      name: body.name ?? descriptor.label,
      createdByUserId: actorContext.actor.actorId,
      description,
      fieldTargets,
    })
    if (isBoardSourceError(result)) {
      sourceError(reply, result)
      return reply
    }

    await enqueueQueueJob(prisma, {
      idempotencyKey: `board-source:initial:${result.id}`,
      payload: { sourceId: result.id },
      topic: BOARD_SOURCE_SYNC_INITIAL_TOPIC,
    })
    return reply.code(201).send(createApiResponse(BoardSourceRecordSchema.parse(result)))
  })

  app.get('/api/projects/:projectId/sources/:sourceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { projectId, sourceId } = request.params as { projectId: string; sourceId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    const source = await prisma.boardSource.findFirst({
      where: { id: sourceId, projectId: project.id },
      select: { connectionId: true, provider: true, container: true },
    })
    if (!source) {
      sendApiError(reply, 404, 'SOURCE_NOT_FOUND', 'Source not found')
      return reply
    }
    const description = await describe(
      source.connectionId,
      source.provider,
      source.container as Record<string, unknown>,
    )
    const detail = await getBoardSourceDetail(prisma, project.id, sourceId, description)
    if (isBoardSourceError(detail)) {
      sourceError(reply, detail)
      return reply
    }
    return createApiResponse(BoardSourceDetailRecordSchema.parse(detail))
  })

  app.patch('/api/projects/:projectId/sources/:sourceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { projectId, sourceId } = request.params as { projectId: string; sourceId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
    const body = parseInput(UpdateBoardSourceBodySchema, request.body, reply)
    if (!body) return reply

    const result = await updateBoardSource(prisma, project.id, sourceId, {
      ...body,
      actorUserId: actorContext.actor.actorId,
    })
    if (isBoardSourceError(result)) {
      sourceError(reply, result)
      return reply
    }
    return createApiResponse(BoardSourceRecordSchema.parse(result))
  })

  app.put('/api/projects/:projectId/sources/:sourceId/mappings', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { projectId, sourceId } = request.params as { projectId: string; sourceId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
    const body = parseInput(PutBoardSourceMappingsBodySchema, request.body, reply)
    if (!body) return reply

    const result = await putBoardSourceMappings(prisma, project.id, sourceId, {
      ...body,
      actorUserId: actorContext.actor.actorId,
    })
    if (isBoardSourceError(result)) {
      sourceError(reply, result)
      return reply
    }
    return createApiResponse(BoardSourceRecordSchema.parse(result))
  })

  // The explicit health transitions. Recovery is a person's decision, never a
  // side effect of a page load — docs/standards/capability-health-alerts.md.
  for (const [suffix, patch] of [
    ['sync', { nextRunAt: new Date(0) }],
    ['pause', { healthState: 'paused' as const, healthReason: 'PAUSED_BY_PERSON', nextRunAt: null }],
    ['resume', { healthState: 'active' as const, healthReason: null, nextRunAt: new Date(0) }],
    [
      'retry',
      {
        healthState: 'active' as const,
        healthReason: null,
        consecutiveFailures: 0,
        nextRunAt: new Date(0),
      },
    ],
  ] as const) {
    app.post(`/api/projects/:projectId/sources/:sourceId/${suffix}`, async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      const { projectId, sourceId } = request.params as { projectId: string; sourceId: string }
      const project = await loadProject(actorContext, projectId)
      if (!project) {
        sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
        return reply
      }
      if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply

      const updated = await prisma.boardSource.updateMany({
        where: { id: sourceId, projectId: project.id },
        // `new Date(0)` means "due now" without letting a caller schedule the
        // future: the sweep claims anything whose `nextRunAt` has passed.
        data: 'nextRunAt' in patch && patch.nextRunAt instanceof Date
          ? { ...patch, nextRunAt: new Date() }
          : patch,
      })
      if (updated.count === 0) {
        sendApiError(reply, 404, 'SOURCE_NOT_FOUND', 'Source not found')
        return reply
      }
      return createApiResponse({ ok: true })
    })
  }

  app.delete('/api/projects/:projectId/sources/:sourceId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { projectId, sourceId } = request.params as { projectId: string; sourceId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply

    await unregisterWebhook(project.id, sourceId)
    const result = await deleteBoardSource(prisma, project.id, sourceId)
    if (isBoardSourceError(result)) {
      sourceError(reply, result)
      return reply
    }
    return createApiResponse({ ok: true })
  })
}
