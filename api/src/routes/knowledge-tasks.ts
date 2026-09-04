import type { PrismaClient } from '@prisma/client'
import type { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { attributionFromActorContext } from '@nessie/runtime'
import { mapPage, pageInclude, type KnowledgePageRecord } from '@nessie/knowledge'
import {
  CreateTaskDocumentBodySchema,
  MyDocsSpaceResponseSchema,
} from '../contracts/knowledge-base.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  ensureMyDocsSpace,
  ensureProjectDocumentsSpace,
  ensureTaskFolder,
  type TaskFolderTask,
} from '../services/knowledge-provisioning.js'
import { sendFileServiceError } from './uploads.js'
import {
  actorAuthorType,
  attachPageEnvelope,
  canViewerReachProject,
  createKnowledgeAccess,
  requireKnowledgePolicy,
  requireProjectId,
  requestIds,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'
import { sendKnowledgeMutationError } from './knowledge-base-errors.js'

// Ticket-bound documents + personal-space provisioning. Every /tasks/:taskId/*
// route resolves the same "ticket team" — the org-wide "Project
// Documents" space plus this ticket's document folder inside it — before
// branching per method, so a GET can 404/403 exactly like the writes and the
// folder always exists by the time a client lists or creates a document.
const loadTask = (
  prisma: PrismaClient,
  organizationId: string,
  taskId: string,
): Promise<TaskFolderTask & { projectId: string | null } | null> =>
  prisma.task.findFirst({
    where: { id: taskId, organizationId },
    select: { id: true, title: true, projectId: true },
  })

export const registerKnowledgeTaskRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { prisma, requireActorContext, fileService } = deps
  const { provider, buildViewer, accessSpace } = createKnowledgeAccess(deps)

  // ─── Provision the caller's personal "My Docs" space ──────────────────────
  app.post('/api/knowledge-base/my-docs', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(
        reply,
        403,
        'ACTOR_TYPE_NOT_ALLOWED',
        'Only a user can provision a personal My Docs space',
      )
      return reply
    }
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_space', 'create')
    if (!decision) return reply
    const projectId = requireProjectId(actorContext, undefined, reply)
    if (!projectId) return reply

    const { spaceId, created } = await ensureMyDocsSpace(prisma, {
      organizationId: actorContext.tenant.organizationId,
      projectId,
      userId: actorContext.actor.actorId,
    })
    if (created) {
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.space.created',
        resourceType: 'knowledge_space',
        resourceId: spaceId,
        outcome: 'success',
        metadata: { name: 'My Docs', personal: true },
        ...requestIds(request),
      })
    }
    return createApiResponse(MyDocsSpaceResponseSchema.parse({ spaceId }))
  })

  // Shared setup for every /tasks/:taskId/* route: load the task, resolve its
  // project, and ensure the project's document space + this ticket's folder
  // exist. Returns null (having already replied) when the caller may not
  // proceed.
  const resolveTicketTeam = async (
    _request: FastifyRequest,
    reply: FastifyReply,
    actorContext: AuthorizedActionContext,
    taskId: string,
    mode: 'read' | 'write',
  ) => {
    const task = await loadTask(prisma, actorContext.tenant.organizationId, taskId)
    if (!task) {
      sendApiError(reply, 404, 'TASK_NOT_FOUND', 'Task not found')
      return null
    }
    const projectId = requireProjectId(actorContext, task.projectId ?? undefined, reply)
    if (!projectId) return null

    const viewer = await buildViewer(actorContext)
    // Prove entitlement before either provisioner writes. Otherwise a caller
    // who merely knows a foreign ticket id can become the creator of its
    // lazily-provisioned Project Documents space and bypass the project fence.
    if (!canViewerReachProject(viewer, projectId)) {
      sendApiError(
        reply,
        403,
        'POLICY_DENIED',
        'Knowledge base access denied: PROJECT_ACCESS_REQUIRED',
      )
      return null
    }
    const { spaceId: docsSpaceId } = await ensureProjectDocumentsSpace(prisma, {
      organizationId: actorContext.tenant.organizationId,
      projectId,
      actorId: actorContext.actor.actorId,
    })
    if (!(await accessSpace(actorContext, docsSpaceId, viewer, mode, reply))) return null

    const folderId = await ensureTaskFolder(prisma, provider, {
      organizationId: actorContext.tenant.organizationId,
      projectId,
      spaceId: docsSpaceId,
      task,
      actorId: actorContext.actor.actorId,
      authorType: actorAuthorType(actorContext),
    })

    return { task, projectId, docsSpaceId, folderId }
  }

  // ─── List a ticket's documents ─────────────────────────────────────────────
  app.get('/api/knowledge-base/tasks/:taskId/pages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'view')
    if (!decision) return reply
    const { taskId } = request.params as { taskId: string }

    const team = await resolveTicketTeam(request, reply, actorContext, taskId, 'read')
    if (!team) return reply

    const pages = await prisma.knowledgePage.findMany({
      where: {
        taskId,
        organizationId: actorContext.tenant.organizationId,
        projectId: team.projectId,
        spaceId: team.docsSpaceId,
        deletedAt: null,
        status: { not: 'archived' },
      },
      include: pageInclude,
      orderBy: [{ createdAt: 'asc' }],
    })
    return createApiResponse(pages.map((page) => attachPageEnvelope(mapPage(page), decision)))
  })

  // ─── Create a ticket document ───────────────────────────────────────────────
  app.post('/api/knowledge-base/tasks/:taskId/pages', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(CreateTaskDocumentBodySchema, request.body, reply)
    if (!body) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'create')
    if (!decision) return reply
    const { taskId } = request.params as { taskId: string }

    const team = await resolveTicketTeam(request, reply, actorContext, taskId, 'write')
    if (!team) return reply

    let page: KnowledgePageRecord
    try {
      page = await provider.createPage({
        organizationId: actorContext.tenant.organizationId,
        projectId: team.projectId,
        spaceId: team.docsSpaceId,
        parentPageId: team.folderId,
        taskId,
        title: body.title,
        body: body.body ?? null,
        authorId: actorContext.actor.actorId,
        authorType: actorAuthorType(actorContext),
        createdBy: actorContext.actor.actorId,
      })
    } catch (error) {
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_PAGE_INVALID',
        message: 'Ticket document could not be created',
        statusCode: 400,
      })
    }
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'kb.page.created',
      resourceType: 'knowledge_page',
      resourceId: page.id,
      outcome: 'success',
      metadata: { spaceId: team.docsSpaceId, taskId, title: page.title },
      ...requestIds(request),
    })
    return reply.code(201).send(createApiResponse(attachPageEnvelope(page, decision)))
  })

  // ─── Upload a ticket file document ──────────────────────────────────────────
  // NOTE: the store→create-page→rollback-on-failure sequence below duplicates
  // the pattern in knowledge-base-files.ts's `POST /spaces/:spaceId/files`
  // (owned by a different workstream in this change) rather than extracting a
  // shared helper — extraction would require editing that file, which this
  // task does not own. Keep the two in sync if the upload/rollback shape ever
  // changes.
  app.post('/api/knowledge-base/tasks/:taskId/files', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'create')
    if (!decision) return reply
    const { taskId } = request.params as { taskId: string }

    const team = await resolveTicketTeam(request, reply, actorContext, taskId, 'write')
    if (!team) return reply

    const file = await request.file()
    if (!file) {
      sendApiError(reply, 400, 'NO_FILE', 'No file part found in the upload')
      return reply
    }
    const mime = file.mimetype || 'application/octet-stream'
    const filename = file.filename || 'upload.bin'

    let attachmentId: string
    try {
      const stored = await fileService.store({
        attribution: attributionFromActorContext(actorContext),
        organizationId: actorContext.tenant.organizationId,
        uploaderId: actorContext.actor.actorId,
        filename,
        mime,
        body: file.file,
        scope: { projectId: team.projectId, spaceId: team.docsSpaceId },
      })
      attachmentId = stored.attachment.id
      if (file.file.truncated) {
        await fileService.delete(
          attachmentId,
          actorContext.tenant.organizationId,
          attributionFromActorContext(actorContext),
        )
        sendApiError(reply, 413, 'FILE_TOO_LARGE', 'File exceeds the upload limit')
        return reply
      }
    } catch (error) {
      if (sendFileServiceError(reply, error)) return reply
      throw error
    }

    try {
      const page = await provider.createPage({
        organizationId: actorContext.tenant.organizationId,
        projectId: team.projectId,
        spaceId: team.docsSpaceId,
        parentPageId: team.folderId,
        taskId,
        kind: 'file',
        title: filename,
        attachmentId,
        authorId: actorContext.actor.actorId,
        authorType: actorAuthorType(actorContext),
        createdBy: actorContext.actor.actorId,
      })
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.page.created',
        resourceType: 'knowledge_page',
        resourceId: page.id,
        outcome: 'success',
        metadata: { spaceId: team.docsSpaceId, taskId, title: page.title, kind: 'file' },
        ...requestIds(request),
      })
      return reply.code(201).send(createApiResponse(attachPageEnvelope(page, decision)))
    } catch (error) {
      await fileService
        .delete(attachmentId, actorContext.tenant.organizationId, attributionFromActorContext(actorContext))
        .catch(() => undefined)
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_PAGE_INVALID',
        message: 'Ticket file document could not be created',
        statusCode: 400,
      })
    }
  })
}
