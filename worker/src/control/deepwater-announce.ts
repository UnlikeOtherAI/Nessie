import type { Prisma, PrismaClient } from '@prisma/client'
import { publishMessageEnvelope, type DeepWaterBriefRun, type PgRealtimeTransport } from '@nessie/runtime'
import {
  isDelegatedSystemDmChannelType,
  parseChannelId,
  parseOrganizationId,
  parseThreadId,
  parseUserId,
  type WsScope,
} from '@nessie/schemas'

/**
 * What a committed DeepWater change tells realtime (Water plan nessie.md §7.7,
 * amendments C3): the messages it posted, the alerts it raised for the person
 * who asked, and `integration.run.updated` for the run itself, so a result or
 * notice appears — and rings — without a reload, and no client polls.
 *
 * Everything is collected inside the transaction and published only after it
 * commits: an event about a rolled-back row would announce something that
 * never happened. A publish failure is logged and never undoes the delivery —
 * the rows are the record of truth, and a missed event costs a refresh.
 */

export type DeepWaterRealtime = Pick<PgRealtimeTransport, 'publishWs'>

export type DeepWaterAnnounceDeps = {
  prisma: PrismaClient
  realtime: DeepWaterRealtime
}

type AnnouncedMessage = {
  channelId: string
  threadId: string
  id: string
  content: string
  role: 'assistant' | 'user'
  agentId: string | null
  userId: string | null
  createdAt: Date
  /** It carries a disclosure basis, so it is announced without its content. */
  restricted: boolean
  reply: { rootMessageId: string; replyCount: number; lastReplyAt: Date | null; replyParticipantIds: string[] } | null
}

type AnnouncedAlert = {
  channelId: string
  threadId: string
  messageId: string
  createdAt: Date
  userIds: string[]
  /** The durable alert's event key; each recipient's event is keyed `<eventKey>:<userId>` (C3). */
  eventKey: string
}

type AnnouncedRun = {
  organizationId: string
  runId: string
  requesterUserId: string | null
  /** The origin channel, once the run has a card there or an agent opened it there. */
  channelId: string | null
}

export type DeepWaterRunAnnouncement = Pick<
  DeepWaterBriefRun,
  'id' | 'organizationId' | 'requestedByUserId' | 'channelId' | 'cardMessageId' | 'originKind'
>

/** The collector a DeepWater transaction writes its announcements into. */
export class DeepWaterAnnouncements {
  readonly messages: AnnouncedMessage[] = []
  readonly alerts: AnnouncedAlert[] = []
  private readonly runs = new Map<string, AnnouncedRun>()

  message(message: AnnouncedMessage): void {
    this.messages.push(message)
  }

  alert(alert: AnnouncedAlert): void {
    if (alert.userIds.length > 0) this.alerts.push(alert)
  }

  /** The run changed in a way a viewer sees; the latest state decides its lanes. */
  run(run: DeepWaterRunAnnouncement): void {
    const channelVisible = run.cardMessageId !== null || run.originKind === 'agent'
    this.runs.set(run.id, {
      organizationId: run.organizationId,
      runId: run.id,
      requesterUserId: run.requestedByUserId,
      channelId: channelVisible ? run.channelId : null,
    })
  }

  get runUpdates(): AnnouncedRun[] {
    return [...this.runs.values()]
  }
}

/**
 * The lanes a message in this room is announced on — the API's rule
 * (`buildChannelRealtimeScopes`): the channel, plus the organisation for a
 * public room that is not a delegated system DM.
 */
const roomScopes = async (prisma: PrismaClient, channelIds: string[]): Promise<Map<string, WsScope[]>> => {
  const channels = await prisma.channel.findMany({
    where: { id: { in: [...new Set(channelIds)] } },
    select: { id: true, organizationId: true, visibility: true, systemChannelType: true },
  })
  return new Map(channels.map((channel) => [channel.id, [
    { kind: 'channel' as const, channelId: parseChannelId(channel.id) },
    ...(channel.visibility === 'public' && !isDelegatedSystemDmChannelType(channel.systemChannelType)
      ? [{ kind: 'organization' as const, organizationId: parseOrganizationId(channel.organizationId) }]
      : []),
  ]]))
}

const publishMessage = async (realtime: DeepWaterRealtime, scopes: WsScope[], message: AnnouncedMessage) => {
  const ts = message.createdAt.toISOString()
  await publishMessageEnvelope(realtime, scopes, {
    channelId: message.channelId,
    message: {
      agentId: message.agentId,
      content: message.content,
      id: message.id,
      ...(message.restricted ? { restricted: true } : {}),
      role: message.role,
      userId: message.userId,
    },
    ...(message.reply ? { rootMessageId: message.reply.rootMessageId } : {}),
    threadId: message.threadId,
  }, { idempotencyKey: `deep-water:message:${message.id}`, timestamp: ts })
  // A restricted reply's counts are metadata of a withheld row: only its
  // readers refetch them (the run executor's rule).
  if (!message.reply || message.restricted) return
  await realtime.publishWs(scopes, {
    data: {
      channelId: parseChannelId(message.channelId),
      threadId: parseThreadId(message.threadId),
      rootMessageId: message.reply.rootMessageId,
      replyCount: message.reply.replyCount,
      lastReplyAt: message.reply.lastReplyAt?.toISOString(),
      replyParticipantIds: message.reply.replyParticipantIds,
    },
    event: 'message.reply.meta',
    idempotencyKey: `deep-water:message:${message.id}:reply-meta`,
    ts,
  })
}

const publishAlert = async (realtime: DeepWaterRealtime, scopes: WsScope[], alert: AnnouncedAlert) => {
  for (const userId of alert.userIds) {
    await realtime.publishWs(scopes, {
      data: {
        userId: parseUserId(userId),
        kind: 'mention' as const,
        messageId: alert.messageId,
        threadId: parseThreadId(alert.threadId),
        channelId: parseChannelId(alert.channelId),
        createdAt: alert.createdAt.toISOString(),
      },
      event: 'alert.created',
      idempotencyKey: `${alert.eventKey}:${userId}`,
      ts: alert.createdAt.toISOString(),
    })
  }
}

/** One event per lane: a durable event row records one channel or one recipient. */
const publishRun = async (realtime: DeepWaterRealtime, run: AnnouncedRun) => {
  const data = { productSlug: 'deep-water', runId: run.runId }
  if (run.requesterUserId) {
    await realtime.publishWs([{
      kind: 'user',
      organizationId: parseOrganizationId(run.organizationId),
      userId: parseUserId(run.requesterUserId),
    }], { data, event: 'integration.run.updated' })
  }
  if (run.channelId) {
    await realtime.publishWs([{ kind: 'channel', channelId: parseChannelId(run.channelId) }], {
      data,
      event: 'integration.run.updated',
    })
  }
}

const logged = async (what: string, publish: () => Promise<void>): Promise<void> => {
  try {
    await publish()
  } catch (error) {
    console.error(`[deep-water] realtime ${what} failed; the change is committed and a refresh shows it`, error)
  }
}

/** Publish what a committed transaction collected. Never throws. */
export const publishDeepWaterAnnouncements = async (
  deps: DeepWaterAnnounceDeps,
  announce: DeepWaterAnnouncements,
): Promise<void> => {
  const channelIds = [...announce.messages, ...announce.alerts].map((entry) => entry.channelId)
  let scopes = new Map<string, WsScope[]>()
  if (channelIds.length > 0) {
    await logged('room lookup', async () => { scopes = await roomScopes(deps.prisma, channelIds) })
  }
  for (const message of announce.messages) {
    const room = scopes.get(message.channelId)
    if (room) await logged(`announcement of message ${message.id}`, () => publishMessage(deps.realtime, room, message))
  }
  for (const alert of announce.alerts) {
    const room = scopes.get(alert.channelId)
    if (room) await logged(`alert for message ${alert.messageId}`, () => publishAlert(deps.realtime, room, alert))
  }
  for (const run of announce.runUpdates) {
    await logged(`update of run ${run.runId}`, () => publishRun(deps.realtime, run))
  }
}

/**
 * Run `work` in one transaction, then publish what it announced. The collector
 * belongs to this attempt alone, so a transaction that throws announces nothing.
 */
export const runDeepWaterTransaction = async <T>(
  deps: DeepWaterAnnounceDeps,
  work: (tx: Prisma.TransactionClient, announce: DeepWaterAnnouncements) => Promise<T>,
): Promise<T> => {
  const announce = new DeepWaterAnnouncements()
  const result = await deps.prisma.$transaction((tx) => work(tx, announce))
  await publishDeepWaterAnnouncements(deps, announce)
  return result
}
