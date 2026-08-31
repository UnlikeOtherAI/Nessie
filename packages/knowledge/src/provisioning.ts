import { Prisma, type PrismaClient } from '@prisma/client'
import type { KnowledgeAuthorType, KnowledgeProvider } from './types.js'

const MY_DOCS_SPACE_NAME = 'My Docs'
const PROJECT_DOCS_SPACE_NAME = 'Project Documents'

export type EnsureSpaceResult = {
  spaceId: string
  // True only when this call actually inserted the space row — false when an
  // existing space was found. Callers use this to gate one-time side effects
  // (e.g. the kb.space.created audit event) so a repeat "ensure" call (the
  // idempotent case) never re-emits them.
  created: boolean
}

// Ensures the caller's personal "My Docs" knowledge space exists, returning
// its id. Guarded by a Postgres advisory xact lock keyed on (userId,
// 'my_docs') — mirrors the ensure*-pattern in personal-assistant.ts — so two
// concurrent calls (e.g. a double-click) can never race into two personal
// spaces for the same user.
//
// The existence check and the insert both run against the same locked `tx`,
// not the KnowledgeProvider's `createSpace` (which always writes through the
// provider's own PrismaClient, not the caller's transaction client) — calling
// through the provider here would let a second racer's check run against a
// connection that hasn't seen the first racer's still-uncommitted insert,
// which defeats the lock. The insert below intentionally mirrors the shape
// `provider.createSpace` would have produced for these inputs (no members).
export const ensureMyDocsSpace = async (
  prisma: PrismaClient,
  input: { organizationId: string; projectId: string; userId: string },
): Promise<EnsureSpaceResult> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${input.userId}),
        hashtext('my_docs')
      )
    `)

    const existing = await tx.knowledgeSpace.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.userId,
        visibility: 'private',
        deletedAt: null,
        metadata: { path: ['personal'], equals: true },
      },
      select: { id: true },
    })
    if (existing) return { spaceId: existing.id, created: false }

    const space = await tx.knowledgeSpace.create({
      data: {
        name: MY_DOCS_SPACE_NAME,
        organizationId: input.organizationId,
        projectId: input.projectId,
        userId: input.userId,
        visibility: 'private',
        metadata: { personal: true },
        createdBy: input.userId,
      },
      select: { id: true },
    })
    return { spaceId: space.id, created: true }
  })

// Ensures the project's shared "Project Documents" knowledge space exists —
// the space every ticket-bound document/folder is filed under. Same
// same-transaction advisory-lock reasoning as ensureMyDocsSpace, keyed on
// (projectId, 'project_docs') so two tickets provisioned concurrently in the
// same project never create two "Project Documents" spaces.
export const ensureProjectDocumentsSpace = async (
  prisma: PrismaClient,
  input: { organizationId: string; projectId: string; actorId: string },
): Promise<EnsureSpaceResult> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${input.projectId}),
        hashtext('project_docs')
      )
    `)

    const existing = await tx.knowledgeSpace.findFirst({
      where: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        visibility: 'project',
        deletedAt: null,
        metadata: { path: ['projectDocuments'], equals: true },
      },
      select: { id: true },
    })
    if (existing) return { spaceId: existing.id, created: false }

    const space = await tx.knowledgeSpace.create({
      data: {
        name: PROJECT_DOCS_SPACE_NAME,
        organizationId: input.organizationId,
        projectId: input.projectId,
        visibility: 'project',
        metadata: { projectDocuments: true },
        createdBy: input.actorId,
      },
      select: { id: true },
    })
    return { spaceId: space.id, created: true }
  })

/**
 * Ensures a non-system agent's private documents home exists. The personal
 * assistant is system-managed: its authored documents belong to the person
 * and go in that person's My Docs, never in a singleton agent home.
 */
export const ensureAgentDocsSpace = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    projectId: string
    agentId: string
    agentName: string
  },
): Promise<EnsureSpaceResult> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${input.agentId}),
        hashtext('agent_docs')
      )
    `)

    const agent = await tx.agent.findFirst({
      where: { id: input.agentId, organizationId: input.organizationId },
      select: { systemManaged: true },
    })
    if (!agent || agent.systemManaged) {
      throw new Error('Agent documents are unavailable for a system-managed or unknown agent')
    }

    const existing = await tx.knowledgeSpace.findFirst({
      where: {
        organizationId: input.organizationId,
        ownerAgentId: input.agentId,
        deletedAt: null,
      },
      select: { id: true },
    })
    if (existing) return { spaceId: existing.id, created: false }

    const space = await tx.knowledgeSpace.create({
      data: {
        name: `${input.agentName} — Documents`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        // `privateToAgentId` restricts a machine reader; it is deliberately
        // not a disclosure-basis scope. `ownerAgentId` names the human audience.
        privateToAgentId: input.agentId,
        ownerAgentId: input.agentId,
        visibility: 'private',
        metadata: { agentDocs: true },
        createdBy: input.agentId,
      },
      select: { id: true },
    })
    return { spaceId: space.id, created: true }
  })

export type TaskFolderTask = {
  id: string
  title: string | null
}

// Ensures a ticket has a document folder inside `spaceId` (the project's
// "Project Documents" space) and returns its page id — every ticket-bound
// document/file is created as a child of this folder. Idempotent: a folder is
// identified by (kind: document, metadata.folder: true, metadata.taskId).
// No advisory lock here (unlike the two space-ensure functions above) — a
// duplicate folder is a cosmetic annoyance, not a data-integrity problem, and
// the spec for this helper does not call for one.
export const ensureTaskFolder = async (
  prisma: PrismaClient,
  provider: KnowledgeProvider,
  input: {
    organizationId: string
    projectId: string
    spaceId: string
    task: TaskFolderTask
    actorId: string
    authorType: KnowledgeAuthorType
  },
): Promise<string> => {
  const existing = await prisma.knowledgePage.findFirst({
    where: {
      organizationId: input.organizationId,
      spaceId: input.spaceId,
      kind: 'document',
      deletedAt: null,
      AND: [
        { metadata: { path: ['folder'], equals: true } },
        { metadata: { path: ['taskId'], equals: input.task.id } },
      ],
    },
    select: { id: true },
  })
  if (existing) return existing.id

  const created = await provider.createPage({
    organizationId: input.organizationId,
    projectId: input.projectId,
    spaceId: input.spaceId,
    kind: 'document',
    title: input.task.title?.trim() || `Task ${input.task.id}`,
    metadata: { folder: true, taskId: input.task.id },
    taskId: input.task.id,
    authorId: input.actorId,
    authorType: input.authorType,
    createdBy: input.actorId,
  })
  return created.id
}
