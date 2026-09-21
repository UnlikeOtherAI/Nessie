import { isDeepStrictEqual } from 'node:util'
import type { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema, TaskSetDisclosureSchema, TaskSetReceiverSchema, TaskSetSourceSchema } from '@nessie/schemas'
import { authorizeTaskSetSource } from '@nessie/team-admin'
import { assertTaskSetDeliveryDestination } from '../task-sets/delivery.js'

/** Revalidate the captured task-set capability at delivery, including after a mailbox retry. */
export const authorizeTaskSetMailbox = async (prisma: PrismaClient, mail: {
  taskSetId: string; organizationId: string; actorId: string | null; actorType: string | null;
  toAgentId: string; channelId: string | null; basis: unknown; disclosureSources: unknown; uoaIdentity: unknown;
}): Promise<'ready' | 'paused'> => {
  const set = await prisma.taskSet.findFirstOrThrow({ where: {
    id: mail.taskSetId, organizationId: mail.organizationId, ownerUserId: mail.actorId ?? '',
  } })
  if (mail.actorType !== 'user' || set.status === 'cancelled') throw new Error('Task set delivery is no longer authorized.')
  if (set.status === 'paused') return 'paused'
  const receiver = TaskSetReceiverSchema.parse(set.receiver)
  if (receiver.agentId !== mail.toAgentId || receiver.channelId !== mail.channelId) {
    throw new Error('Task set delivery destination changed.')
  }
  const actor = AuthorizedActionContextSchema.parse(set.launchOrigin)
  if (!isDeepStrictEqual(actor.actionContext.uoaIdentity ?? null, mail.uoaIdentity ?? null)) {
    throw new Error('Task set delivery identity changed.')
  }
  const disclosure = TaskSetDisclosureSchema.parse({
    classified: true, basisScopes: mail.basis, disclosureSources: mail.disclosureSources,
  })
  const saved = TaskSetDisclosureSchema.parse((set.outputState as { disclosure?: unknown } | null)?.disclosure)
  if (!isDeepStrictEqual(disclosure, saved)) throw new Error('Task set delivery disclosure changed.')
  if (set.source) {
    const source = await authorizeTaskSetSource(prisma, actor, TaskSetSourceSchema.parse(set.source), {
      processingAgentId: set.executionAgentId,
    })
    if (source.attachmentId !== set.sourceAttachmentId) throw new Error('Task set source revision changed.')
  }
  await assertTaskSetDeliveryDestination(prisma, set, actor, disclosure)
  return 'ready'
}
