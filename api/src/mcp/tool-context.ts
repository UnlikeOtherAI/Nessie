import type { AgentAccessScope, PrismaClient } from '@prisma/client'
import type { ZodTypeAny } from 'zod'
import type {
  KnowledgePageRecord,
  KnowledgeProvider,
  SpaceViewer,
  SpreadsheetServiceDeps,
} from '@nessie/knowledge'
import type {
  DisclosureViewer,
  EncryptionKeyRingInput,
  FileService,
  PgRealtimeTransport,
} from '@nessie/runtime'
import type { AuthorizedActionContext, TaskEventOrigin, TaskLabelSummary } from '@nessie/schemas'

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
   * The deployment at-rest key ring. Task mutations build their board-source
   * write-back collaborator from it so provider credentials stay separate from
   * signing material.
   */
  encryptionKeyRing: EncryptionKeyRingInput
  /** The shared policy engine, exactly as the routes call it. */
  checkPolicy: (
    prisma: PrismaClient,
    actorContext: AuthorizedActionContext,
    resourceType: 'knowledge_page' | 'knowledge_space',
    action: 'view' | 'read' | 'create' | 'edit' | 'approve',
  ) => Promise<{ allowed: boolean; reasonCode: string }>
  /**
   * The process's one file service — the chokepoint every stored byte goes
   * through, as the upload and attachment routes use it. Optional so a caller
   * that builds a partial context (tests of tools that touch no file) keeps
   * compiling; a file tool refuses plainly when it is absent.
   */
  fileService?: FileService | null
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
  /**
   * The realtime hub the routes publish through, so a comment an agent adds
   * refreshes an open ticket dialog exactly as a person's does. Optional for
   * partial test contexts; absent means nothing is announced.
   */
  realtime?: Pick<PgRealtimeTransport, 'publishWs'> | null
  scopes: AgentAccessScope[]
  /**
   * The process's one spreadsheet service — the same instance the HTTP routes
   * and the live lane hold.
   *
   * Shared rather than built per request because the model cache and the
   * presence budget are its closure state: a second instance would give this
   * endpoint its own cache of every workbook a paired agent touched, paid for
   * again on the next call. Null on a deployment with no spreadsheet service,
   * which makes the tools say so plainly.
   */
  spreadsheet: SpreadsheetServiceDeps | null
  /**
   * The origin every ticket change this call makes carries: the agent access
   * credential, as `token`. An MCP call is a member's credential acting
   * without that member at a screen, so it never starts or steers an agent's
   * ticket work (docs/standards/ticket-work.md). Optional for partial test
   * contexts; absent, the events are `system`, which starts nothing either.
   */
  taskEventOrigin?: TaskEventOrigin
}

/** The parts of a task record these tools read. */
export type TaskWithOrigin = {
  commentCount?: number
  externalLink: { externalUrl: string; provider: string; writeMode: string } | null
  id: string
  labels?: TaskLabelSummary[]
  projectId?: string | null
  status?: string
}

/**
 * The knowledge seam, typed against the real provider interface rather than a
 * local restatement of its shape — a second declaration is a second thing that
 * can drift from the one that actually runs.
 */
export type KnowledgeAccess = {
  buildDisclosureViewer: (viewer: SpaceViewer) => DisclosureViewer | null
  buildViewer: (actorContext: AuthorizedActionContext) => Promise<SpaceViewer>
  filterReadablePages: (
    viewer: SpaceViewer,
    pages: readonly KnowledgePageRecord[],
  ) => Promise<KnowledgePageRecord[]>
  provider: KnowledgeProvider
}

export type McpToolDefinition = {
  description: string
  /** Raw Zod shape, which is what the MCP SDK turns into a JSON schema. */
  inputSchema: Record<string, ZodTypeAny>
  name: string
  run: (context: McpToolContext, input: Record<string, unknown>) => Promise<unknown>
}
