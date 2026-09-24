import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import {
  DocumentTriggerDeliveryPayloadSchema,
  TRIGGER_DOCUMENT_DISPATCH_TOPIC,
  TriggerDocumentDispatchJobPayloadSchema,
} from '@nessie/schemas'
import {
  createAgentTrigger,
  documentTriggerOnPagePublished,
  documentTriggerOnVersionCreated,
} from '@nessie/team-admin'

import { dispatchDocumentChange } from '../../src/control/document-trigger-dispatch.js'
import type { TicketWorkSeed } from './ticket-work-fixture.js'

// A project's Documents space with a Specs folder, and a `document_changed`
// trigger of the ticket-work seed's own agent watching that space, created
// through the real resolution — the shape every document-trigger suite starts
// from. Not a test file itself: `test:db` globs `*.test.ts`.

export const DOCUMENT_INSTRUCTIONS = { general: 'Review the edit and say what changed in the thread.' }

export const seedDocumentTrigger = async (
  prisma: PrismaClient,
  s: TicketWorkSeed,
  config: Record<string, unknown> = {},
  options: { targetChannelId?: string } = {},
) => {
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: s.editorId,
      name: 'Project Documents',
      organizationId: s.organizationId,
      projectId: s.projectId,
      visibility: 'project',
      metadata: { projectDocuments: true },
    },
  })
  // Saves through the provider every document-writing process wires: the
  // quiet window opens inside the save.
  const provider = createNativeKnowledgeProvider(prisma, {
    onVersionCreated: documentTriggerOnVersionCreated,
    onPagePublished: documentTriggerOnPagePublished,
  })
  const scope = {
    authorId: s.editorId,
    authorType: 'user' as const,
    createdBy: s.editorId,
    organizationId: s.organizationId,
    projectId: s.projectId,
    spaceId: space.id,
  }
  const specs = await provider.createPage({ ...scope, kind: 'folder', title: 'Specs' })
  const trigger = await createAgentTrigger(prisma, s.agentId, {
    config: { instructions: DOCUMENT_INSTRUCTIONS, ...config },
    name: 'Review spec edits',
    targetChannelId: options.targetChannelId ?? s.channelId,
    type: 'document_changed',
  }, { authorUserId: s.editorId })
  if (!trigger) throw new Error('seedDocumentTrigger: the trigger was not created')
  return { spaceId: space.id, specsId: specs.id, documentTriggerId: trigger.id, provider, scope }
}
export type DocumentTriggerSeed = Awaited<ReturnType<typeof seedDocumentTrigger>>

/** As the agent itself saves: `kb_document_edit` and its siblings write agent-authored versions. */
export const agentScope = (s: TicketWorkSeed, d: DocumentTriggerSeed, agentId = s.agentId) =>
  ({ ...d.scope, authorId: agentId, authorType: 'agent' as const, createdBy: agentId })

/**
 * Run every document dispatch job this seed's saves put on the queue and this
 * suite has not run yet, oldest first, as its quiet window would have closed.
 */
export const drainDocumentJobs = async (prisma: PrismaClient, s: TicketWorkSeed, seen: Set<string>) => {
  const jobs = await prisma.queueJob.findMany({
    where: { topic: TRIGGER_DOCUMENT_DISPATCH_TOPIC, payload: { path: ['organizationId'], equals: s.organizationId } },
    orderBy: { enqueuedAt: 'asc' },
  })
  let ran = 0
  for (const job of jobs) {
    if (seen.has(job.id)) continue
    seen.add(job.id)
    ran += 1
    await dispatchDocumentChange(prisma, TriggerDocumentDispatchJobPayloadSchema.parse(job.payload))
  }
  return ran
}

export const documentDeliveries = async (prisma: PrismaClient, triggerId: string) =>
  (await prisma.agentTriggerDelivery.findMany({ where: { triggerId }, orderBy: { createdAt: 'asc' } }))
    .map((row) => ({ ...row, parsed: DocumentTriggerDeliveryPayloadSchema.parse(row.payload) }))

export const versionIds = async (prisma: PrismaClient, pageId: string) =>
  (await prisma.knowledgePageVersion.findMany({ where: { pageId }, orderBy: { versionNumber: 'asc' }, select: { id: true } }))
    .map((version) => version.id)

export const uniqueTitle = (base: string) => `${base} ${randomUUID().slice(0, 4)}`
