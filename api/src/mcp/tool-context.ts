import type { AgentAccessScope, PrismaClient } from '@prisma/client'
import type { ZodTypeAny } from 'zod'
import type { KnowledgeProvider, SpaceViewer } from '@nessie/knowledge'
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
  /**
   * The granting human, resolved fresh from the credential on every call.
   *
   * Its `tenant.projectId` / `tenant.teamId` are pinned at pairing time and are
   * **attribution, not authority**. Only organisation membership and role are
   * re-read per call, so a tool must never treat the pinned project or team as
   * proof of access — derive that from the live predicates instead
   * (`isProjectAccessibleToActor`, `getTask`'s visibility narrowing,
   * `canReadSpace` / `canWriteSpace`, `checkPolicy`). Every tool here does; a
   * new one that reads `tenant.projectId` to decide what a caller may see
   * would be the first to get this wrong.
   */
  actorContext: AuthorizedActionContext
  /**
   * The deployment auth secret, which the task mutations need: they build the
   * board-source write-back collaborator from it, and that collaborator is what
   * pushes a change to Linear or refuses because the source is read-only.
   */
  authSecret: string
  /** The shared policy engine, exactly as the routes call it. */
  checkPolicy: (
    prisma: PrismaClient,
    actorContext: AuthorizedActionContext,
    resourceType: 'knowledge_page' | 'knowledge_space',
    action: 'view' | 'read' | 'create' | 'edit' | 'approve',
  ) => Promise<{ allowed: boolean; reasonCode: string }>
  getTask: (taskId: string) => Promise<TaskWithOrigin | null>
  isProjectAccessibleToActor: (
    actorContext: AuthorizedActionContext,
    projectId: string,
  ) => Promise<boolean>
  /**
   * The knowledge-base access seam the routes build with
   * `createKnowledgeAccess` — the same provider and the same viewer builder, so
   * a tool cannot read or write by a different rule than a click does. Null on
   * a deployment with no knowledge provider configured.
   */
  knowledge: KnowledgeAccess | null
  prisma: PrismaClient
  scopes: AgentAccessScope[]
}

/** The parts of a task record these tools read. */
export type TaskWithOrigin = {
  externalLink: { externalUrl: string; provider: string; writeMode: string } | null
  id: string
}

/**
 * The knowledge seam, typed against the real provider interface rather than a
 * local restatement of its shape — a second declaration is a second thing that
 * can drift from the one that actually runs.
 */
export type KnowledgeAccess = {
  buildViewer: (actorContext: AuthorizedActionContext) => Promise<SpaceViewer>
  provider: KnowledgeProvider
}

export type McpToolDefinition = {
  description: string
  /** Raw Zod shape, which is what the MCP SDK turns into a JSON schema. */
  inputSchema: Record<string, ZodTypeAny>
  name: string
  run: (context: McpToolContext, input: Record<string, unknown>) => Promise<unknown>
}
