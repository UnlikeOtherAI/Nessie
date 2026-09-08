import { canReadSpace, canWriteSpace } from '@nessie/knowledge'
import { z } from 'zod'

import {
  createApprovalRequestOnce,
  TooManyPendingApprovalsError,
} from '../../services/approvals.js'
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
 * **Publishing is a request, never a grant.** The route refuses publication for
 * an `agent` actor outright — "agents draft; only a human may publish" — and
 * sends it to an approval. An MCP credential resolves as the human who approved
 * it, so that check cannot catch it: the rule would be bypassed by exactly the
 * kind of caller it was written for.
 *
 * This was once answered with a `documents_publish` scope — a tick at pairing
 * time saying this agent may publish. That was the wrong shape. It decided,
 * once and for ninety days, a question this product asks per document
 * everywhere else, and it decided it before the document existed; a person
 * ticking it had no way to know what they were agreeing to publish. So the
 * scope is gone and `nessie_doc_publish` opens the same
 * `knowledge.page.publish` approval `kb_publish_request` opens, pinned to the
 * person whose account the credential borrows. One rule, one vocabulary, one
 * Approvals page — and the agent gets a real answer either way instead of a
 * permanent refusal.
 */

const NOT_AVAILABLE = {
  error: 'The knowledge base is not available on this deployment.',
} as const

/** Named the way the agent should report it back to whoever is reading. */
const PUBLISH_APPROVER_HINT = 'the person whose account this agent works as'

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

      return {
        pages: await access.provider.listPages({
          disclosureViewer: access.buildDisclosureViewer(viewer) ?? undefined,
          organizationId,
          spaceId,
        }),
      }
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
      if ((await access.filterReadablePages(viewer, [page])).length === 0) {
        return PAGE_UNREACHABLE
      }

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
      if ((await access.filterReadablePages(viewer, [existing])).length === 0) {
        return PAGE_UNREACHABLE
      }

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
      'Ask for a document to be published. Publication is a human decision here, '
      + 'so this does not publish: it opens an approval for the person whose '
      + 'account this credential acts as, and returns its id. They approve it in '
      + 'Nessie and the page goes live. Calling again for the same draft returns '
      + 'the request already waiting rather than opening a second one.',
    inputSchema: {
      pageId: z.string().uuid(),
      reason: z.string().max(2000).optional(),
    },
    name: 'nessie_doc_publish',
    run: async (context, input) => {
      // Publishing grants nothing, so this is not the publish permission — it is
      // the document permission. Without it a credential holding only
      // `boards_read` could name a page id, learn from the answer whether that
      // document is reachable, and put a request in front of a person, none of
      // which its grant covers. `documents_write` is the scope that says this
      // agent works on documents at all, and asking for one to go live is part
      // of that work.
      requireScope(context.scopes, 'documents_write')
      const access = context.knowledge
      if (!access) return NOT_AVAILABLE

      // `approve`, not `edit`. Publishing is a different decision from writing,
      // and the policy engine already says so — this is the gate on whether the
      // granting human could publish this page at all. It is not a substitute
      // for the approval below: the question that gate answers is "may this
      // account publish here", and the question left over is "did a person
      // actually decide to publish *this*".
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
      if ((await access.filterReadablePages(viewer, [existing])).length === 0) {
        return PAGE_UNREACHABLE
      }

      const versionId = existing.latestVersion?.id
      if (!versionId) {
        return { error: 'That page has no draft to publish.' }
      }

      const credentialId = context.actorContext.actionContext.agentCredentialId
      if (!credentialId) {
        // Every call on this endpoint arrives on a credential, so this is
        // unreachable rather than a case — but publishing straight through
        // because a marker was missing is the exact failure this tool exists to
        // prevent, so it refuses rather than assuming.
        return { error: 'This call carries no agent credential, so it cannot request publication.' }
      }

      // One request per draft, even if the agent polls or two replicas race:
      // the check and the create happen under one lock inside the approvals
      // service, which is where that concern belongs.
      let opened: Awaited<ReturnType<typeof createApprovalRequestOnce>>
      try {
        opened = await createApprovalRequestOnce(context.prisma, {
          action: 'knowledge.page.publish',
          actorContext: context.actorContext,
          context: {
            pageId: existing.id,
            spaceId: existing.spaceId,
            title: existing.title,
            versionId,
          },
          lockKey: `mcp-doc-publish:${credentialId}:${pageId}:${versionId}`,
          matches: (rowContext) =>
            rowContext?.['pageId'] === pageId && rowContext?.['versionId'] === versionId,
          reason:
            (input.reason as string | undefined)?.trim()
            || 'Requested by a paired agent through the MCP endpoint.',
          requester: {
            agentAccessCredentialId: credentialId,
            requiredApproverUserId: context.actorContext.actor.actorId,
          },
        })
      } catch (error) {
        // A refusal the agent can act on — it names the actual problem and what
        // would clear it — rather than a stack trace it will retry into a loop.
        if (error instanceof TooManyPendingApprovalsError) {
          return { error: error.message, retryable: false }
        }
        throw error
      }

      const { approval, created } = opened

      if (!created) {
        return {
          status: 'awaiting_approval',
          approvalId: approval.id,
          message:
            'Publication was already requested for this draft and is waiting for '
            + `${PUBLISH_APPROVER_HINT}.`,
        }
      }

      return {
        status: 'awaiting_approval',
        approvalId: approval.id,
        message:
          'Publication requested. Agents draft; a person publishes — this is now '
          + `waiting for ${PUBLISH_APPROVER_HINT}.`,
      }
    },
  },
]
