import { canReadSpace } from '@nessie/knowledge'
import { z } from 'zod'

import { requireScope } from '../scopes.js'
import type { McpToolDefinition } from '../tool-context.js'

/**
 * Documents — the knowledge base.
 *
 * Reads go through the same provider and the same `canReadSpace` predicate the
 * HTTP routes use. That matters more here than anywhere else in this first tool
 * set: what a person may read is decided by space visibility, project
 * membership, personal spaces and per-agent private pages together, and
 * re-deriving any of it in a tool would be a second, weaker answer to a
 * question the platform already answers correctly.
 *
 * The routes' own `accessSpace` helper cannot be called from here because it
 * writes its refusal into a Fastify reply, which a tool does not have. The
 * predicate underneath it is what actually decides, and that is what these use.
 */

const NOT_AVAILABLE = {
  error: 'The knowledge base is not available on this deployment.',
} as const

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
      // spaces callers were entitled to read — see the note on the equivalent
      // route.
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
      // One answer for "no such space" and "not yours": which it was is not
      // something an agent should be able to learn by enumerating ids.
      if (!space || !canReadSpace(space, viewer)) {
        return { error: 'Space not found, or not one this account can read.' }
      }

      return { pages: await access.provider.listPages({ organizationId, spaceId }) }
    },
  },
  {
    description:
      'Read one document by id, including its body and publication status.',
    inputSchema: { pageId: z.string().uuid() },
    name: 'nessie_doc_get',
    run: async (context, input) => {
      requireScope(context.scopes, 'documents_read')
      const access = context.knowledge
      if (!access) return NOT_AVAILABLE

      const organizationId = context.actorContext.tenant.organizationId
      const page = await access.provider.getPage(organizationId, input.pageId as string)
      if (!page) return { error: 'Document not found, or not one this account can read.' }

      // The page is reachable only through a space the viewer may read, which
      // is the same gate the HTTP route applies after fetching.
      const space = await access.provider.getSpace(organizationId, page.spaceId)
      const viewer = await access.buildViewer(context.actorContext)
      if (!space || !canReadSpace(space, viewer)) {
        return { error: 'Document not found, or not one this account can read.' }
      }

      return { page }
    },
  },
]
