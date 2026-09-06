import { canReadSpace, canWriteSpace } from '@nessie/knowledge'
import { z } from 'zod'

import { emitAuditEvent } from '../../services/audit.js'
import { requireScope } from '../scopes.js'
import type { McpToolContext, McpToolDefinition } from '../tool-context.js'

/**
 * Documents — the knowledge base.
 *
 * Every call goes through the same provider and the same `canReadSpace` /
 * `canWriteSpace` predicates the HTTP routes use, and every mutation is checked
 * against the same policy engine first. That matters more here than anywhere
 * else in this tool set: what a person may read or write is decided by space
 * visibility, project membership, personal spaces, agent-owned notebooks and
 * the write-restricted switch together, and re-deriving any of it in a tool
 * would be a second, weaker answer to a question the platform already answers.
 *
 * The routes' own `accessSpace` helper cannot be called from here because it
 * writes its refusal into a Fastify reply, which a tool does not have. The
 * predicates underneath it are what actually decide, and those are what these
 * call.
 *
 * **Publishing has its own scope, and that is the whole design.** The route
 * refuses publication for an `agent` actor outright — "agents draft; only a
 * human may publish" — and sends it to an approval. An MCP credential resolves
 * as the human who approved it, so that check does not catch it: the rule would
 * be bypassed by exactly the kind of caller it was written for.
 *
 * Dropping the rule was not acceptable, and refusing publication forever left
 * an agent unable to finish work a person asked it to do. So the decision stays
 * human and moves to pairing time: `documents_publish` is granted only by
 * ticking a box that says this agent may publish, it is deliberately not
 * pre-selected the way the other scopes are, and it can be revoked. A person
 * decides once, explicitly, instead of per document or never.
 */

const NOT_AVAILABLE = {
  error: 'The knowledge base is not available on this deployment.',
} as const

/**
 * One answer for "no such space" and "not yours".
 *
 * Which it was is not something an agent should be able to learn by walking
 * ids, and the distinction would be the only interesting thing in the reply.
 */
const SPACE_UNREACHABLE = {
  error: 'Space not found, or not one this account can use.',
} as const

const PAGE_UNREACHABLE = {
  error: 'Document not found, or not one this account can use.',
} as const

/**
 * Record that a write arrived through an agent credential.
 *
 * The actor is the granting human either way — that is what the credential
 * means — so without this the audit log could not tell a person's own edit from
 * one their agent made on their behalf. `via` is the difference.
 */
const auditDocumentWrite = async (
  context: McpToolContext,
  input: {
    action: 'kb.page.created' | 'kb.page.updated'
    metadata: Record<string, unknown>
    resourceId: string
  },
): Promise<void> => {
  await emitAuditEvent(context.prisma, {
    action: input.action,
    actorContext: context.actorContext,
    metadata: { ...input.metadata, via: 'mcp_agent_credential' },
    outcome: 'success',
    resourceId: input.resourceId,
    resourceType: 'knowledge_page',
  })
}

export const documentTools = (): McpToolDefinition[] => [
  {
    description:
      'List the knowledge spaces this account can read. Spaces are the '
      + 'top-level containers documents live in.',
    inputSchema: {
      includePersonal: z.boolean().optional(),
      projectId: z.string().uuid().optional(),
    },
    name: 'nessie_space_list',
    run: async (context, input) => {
      requireScope(context.scopes, 'documents_read')
      const access = context.knowledge
      if (!access) return NOT_AVAILABLE

      const viewer = await access.buildViewer(context.actorContext)
      // Org-wide unless the caller narrows it. The session's own project claim
      // is an accident of how the account was created, and narrowing by it hid
      // spaces callers were entitled to read — see the note on the route.
      const result = await access.provider.listSpaces({
        includePersonal: input.includePersonal === true,
        limit: 50,
        organizationId: context.actorContext.tenant.organizationId,
        ...(typeof input.projectId === 'string' ? { projectId: input.projectId } : {}),
        viewer,
      })
      return { spaces: result.data }
    },
  },
  {
    description: 'List the documents in a knowledge space.',
    inputSchema: { spaceId: z.string().uuid() },
    name: 'nessie_doc_list',
    run: async (context, input) => {
      requireScope(context.scopes, 'documents_read')
      const access = context.knowledge
      if (!access) return NOT_AVAILABLE

      const organizationId = context.actorContext.tenant.organizationId
      const spaceId = input.spaceId as string
      const space = await access.provider.getSpace(organizationId, spaceId)
      const viewer = await access.buildViewer(context.actorContext)
      if (!space || !canReadSpace(space, viewer)) return SPACE_UNREACHABLE

      return { pages: await access.provider.listPages({ organizationId, spaceId }) }
    },
  },
  {
    description: 'Read one document by id, including its body and status.',
    inputSchema: { pageId: z.string().uuid() },
    name: 'nessie_doc_get',
    run: async (context, input) => {
      requireScope(context.scopes, 'documents_read')
      const access = context.knowledge
      if (!access) return NOT_AVAILABLE

      const organizationId = context.actorContext.tenant.organizationId
      const page = await access.provider.getPage(organizationId, input.pageId as string)
      if (!page) return PAGE_UNREACHABLE

      // A page is reachable only through a space the viewer may read — the same
      // gate the route applies after fetching.
      const space = await access.provider.getSpace(organizationId, page.spaceId)
      const viewer = await access.buildViewer(context.actorContext)
      if (!space || !canReadSpace(space, viewer)) return PAGE_UNREACHABLE

      return { page }
    },
  },
  {
    description:
      'Create a document in a space. It is created as a draft: publishing is a '
      + 'human act and is not available to an agent.',
    inputSchema: {
      body: z.string().optional(),
      spaceId: z.string().uuid(),
      summary: z.string().optional(),
      title: z.string().min(1),
    },
    name: 'nessie_doc_create',
    run: async (context, input) => {
      requireScope(context.scopes, 'documents_write')
      const access = context.knowledge
      if (!access) return NOT_AVAILABLE

      const decision = await context.checkPolicy(
        context.prisma,
        context.actorContext,
        'knowledge_page',
        'create',
      )
      if (!decision.allowed) {
        return { error: `Knowledge base access denied: ${decision.reasonCode}` }
      }

      const organizationId = context.actorContext.tenant.organizationId
      const spaceId = input.spaceId as string
      const space = await access.provider.getSpace(organizationId, spaceId)
      const viewer = await access.buildViewer(context.actorContext)
      if (!space || !canWriteSpace(space, viewer)) return SPACE_UNREACHABLE

      const page = await access.provider.createPage({
        authorId: context.actorContext.actor.actorId,
        authorType: 'user',
        // A page inherits its project from the destination space; accepting one
        // from the caller would let a document claim a project its space is
        // not in.
        createdBy: context.actorContext.actor.actorId,
        organizationId,
        projectId: space.projectId,
        spaceId,
        title: input.title as string,
        ...(typeof input.body === 'string' ? { body: input.body } : {}),
        ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
      })

      await auditDocumentWrite(context, {
        action: 'kb.page.created',
        metadata: { spaceId, title: page.title },
        resourceId: page.id,
      })
      return { page }
    },
  },
  {
    description:
      'Update a document. Edits the draft; the published version is unchanged '
      + 'until a person publishes it.',
    inputSchema: {
      body: z.string().optional(),
      /**
       * The revision the agent read. Supplying it makes the write refuse rather
       * than silently overwrite a change made since.
       */
      expectedRevision: z.number().int().optional(),
      pageId: z.string().uuid(),
      summary: z.string().optional(),
      title: z.string().min(1).optional(),
    },
    name: 'nessie_doc_update',
    run: async (context, input) => {
      requireScope(context.scopes, 'documents_write')
      const access = context.knowledge
      if (!access) return NOT_AVAILABLE

      const decision = await context.checkPolicy(
        context.prisma,
        context.actorContext,
        'knowledge_page',
        'edit',
      )
      if (!decision.allowed) {
        return { error: `Knowledge base access denied: ${decision.reasonCode}` }
      }

      const organizationId = context.actorContext.tenant.organizationId
      const existing = await access.provider.getPage(organizationId, input.pageId as string)
      if (!existing) return PAGE_UNREACHABLE

      const space = await access.provider.getSpace(organizationId, existing.spaceId)
      const viewer = await access.buildViewer(context.actorContext)
      if (!space || !canWriteSpace(space, viewer)) return PAGE_UNREACHABLE

      const fields = {
        ...(typeof input.body === 'string' ? { body: input.body } : {}),
        ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
      }
      if (Object.keys(fields).length === 0) {
        return { error: 'No updatable fields were provided.' }
      }

      try {
        const page = await access.provider.updatePage(input.pageId as string, {
          ...fields,
          authorId: context.actorContext.actor.actorId,
          authorType: 'user',
          organizationId,
          ...(typeof input.expectedRevision === 'number'
            ? { expectedRevision: input.expectedRevision }
            : {}),
        })
        if (!page) return PAGE_UNREACHABLE

        await auditDocumentWrite(context, {
          action: 'kb.page.updated',
          metadata: { spaceId: existing.spaceId },
          resourceId: page.id,
        })
        return { page }
      } catch (error) {
        // A stale write is a real answer, not a fault: the agent should re-read
        // and decide, exactly as the editor offers a person the choice.
        if (error instanceof Error && error.name === 'KnowledgePageRevisionConflictError') {
          return {
            error:
              'This document changed since you read it. Read it again and re-apply '
              + 'your edit.',
            retryable: true,
          }
        }
        throw error
      }
    },
  },
  {
    description:
      'Publish a document, making it visible to everyone who can read its '
      + 'space. Needs the separate `documents_publish` scope, which a person '
      + 'grants deliberately — publication is normally a human act.',
    inputSchema: { pageId: z.string().uuid() },
    name: 'nessie_doc_publish',
    run: async (context, input) => {
      requireScope(context.scopes, 'documents_publish')
      const access = context.knowledge
      if (!access) return NOT_AVAILABLE

      // The same policy action the route checks — `approve`, not `edit`.
      // Publishing is a different decision from writing, and the policy engine
      // already says so.
      const decision = await context.checkPolicy(
        context.prisma,
        context.actorContext,
        'knowledge_page',
        'approve',
      )
      if (!decision.allowed) {
        return { error: `Knowledge base access denied: ${decision.reasonCode}` }
      }

      const organizationId = context.actorContext.tenant.organizationId
      const pageId = input.pageId as string
      const existing = await access.provider.getPage(organizationId, pageId)
      if (!existing) return PAGE_UNREACHABLE

      const space = await access.provider.getSpace(organizationId, existing.spaceId)
      const viewer = await access.buildViewer(context.actorContext)
      if (!space || !canWriteSpace(space, viewer)) return PAGE_UNREACHABLE

      const page = await access.provider.publishPage({
        actorUserId: context.actorContext.actor.actorId,
        organizationId,
        pageId,
      })
      if (!page) return PAGE_UNREACHABLE

      await emitAuditEvent(context.prisma, {
        action: 'kb.page.published',
        actorContext: context.actorContext,
        // `via` is what separates a person's own publication from one their
        // agent made for them, which for publishing is the interesting fact.
        metadata: { publishedVersionId: page.publishedVersionId, via: 'mcp_agent_credential' },
        outcome: 'success',
        resourceId: page.id,
        resourceType: 'knowledge_page',
      })
      return { page }
    },
  },
]
