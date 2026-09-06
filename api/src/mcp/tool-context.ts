import type { AgentAccessScope, PrismaClient } from '@prisma/client'
import type { ZodTypeAny } from 'zod'
import type {
  KnowledgePageRecord,
  KnowledgeSpaceRecord,
  SpaceViewer,
} from '@nessie/knowledge'
import type { AuthorizedActionContext } from '@nessie/schemas'

/**
 * What a tool is handed, and what a tool is.
 *
 * The context carries the resolved actor for the credential that authenticated
 * the call, the scopes that credential holds, and the *same* access predicates
 * and service functions the HTTP routes use. That last part is the rule: a tool
 * is an adapter over the function a person's click calls, never a second
 * implementation of it, so an agent cannot reach anything its granting human
 * could not — the standard `docs/standards/personal-assistant-tools.md` already
 * sets for the assistant's own tools.
 */
export type McpToolContext = {
  actorContext: AuthorizedActionContext
  /** Shared with the routes: `listAccessibleProjectIds` narrowed per caller. */
  getTask: (
    prisma: PrismaClient,
    input: { actorContext: AuthorizedActionContext; taskId: string },
  ) => Promise<
    | null
    | { externalLink: { externalUrl: string; provider: string; writeMode: string } | null }
  >
  isProjectAccessibleToActor: (
    actorContext: AuthorizedActionContext,
    projectId: string,
  ) => Promise<boolean>
  /**
   * The knowledge-base access seam the routes build with
   * `createKnowledgeAccess` — the same provider and the same viewer builder, so
   * a tool cannot read by a different rule than a click does. Null on a
   * deployment without a knowledge provider configured.
   */
  knowledge: KnowledgeAccess | null
  prisma: PrismaClient
  scopes: AgentAccessScope[]
}

/** The subset of `createKnowledgeAccess`'s result the tools actually use. */
export type KnowledgeAccess = {
  buildViewer: (actorContext: AuthorizedActionContext) => Promise<SpaceViewer>
  provider: {
    getPage: (organizationId: string, pageId: string) => Promise<KnowledgePageRecord | null>
    getSpace: (
      organizationId: string,
      spaceId: string,
    ) => Promise<KnowledgeSpaceRecord | null>
    listPages: (input: {
      organizationId: string
      spaceId: string
    }) => Promise<unknown[]>
    listSpaces: (input: {
      includePersonal?: boolean
      limit?: number
      organizationId: string
      projectId?: string
      viewer?: SpaceViewer
    }) => Promise<{ data: KnowledgeSpaceRecord[] }>
  }
}

export type McpToolDefinition = {
  description: string
  /** Raw Zod shape, which is what the MCP SDK turns into a JSON schema. */
  inputSchema: Record<string, ZodTypeAny>
  name: string
  run: (
    context: McpToolContext,
    input: Record<string, unknown>,
  ) => Promise<unknown>
}
