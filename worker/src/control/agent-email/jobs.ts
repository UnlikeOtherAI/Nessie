import type { PrismaClient } from '@prisma/client'
import { parseSesNotification, type AgentMailConfig, type AgentMailTransport } from '@nessie/agent-mail'
import type { FileService, PgRealtimeTransport } from '@nessie/runtime'
import type {
  AgentEmailInboundJobPayload,
  AgentEmailRetentionJobPayload,
  AgentEmailSendJobPayload,
} from '@nessie/schemas'

import {
  applySesDeliveryEvent,
  sweepInboundRetention,
  sweepStuckSends,
} from './delivery-events.js'
import { processInboundReceipt } from './inbound.js'
import { dispatchQueuedEmail } from './outbound.js'

/**
 * Queue handlers for hosted agent mail. The public route has already verified
 * the SNS signature and the topic before any of this runs — everything here
 * treats the payload as structurally trustworthy but semantically untrusted:
 * an unrecognised SES shape is dropped rather than guessed at.
 */

export type AgentEmailJobDeps = {
  prisma: PrismaClient
  realtimeTransport: PgRealtimeTransport
  files: FileService
  transport: AgentMailTransport
  config: AgentMailConfig
}

export const processAgentEmailInboundJob = async (
  deps: AgentEmailJobDeps,
  payload: AgentEmailInboundJobPayload,
): Promise<void> => {
  const notification = parseSesNotification(payload.sesPayload)
  if (!notification) {
    console.warn('[agent-email] unrecognised SES payload dropped', {
      snsMessageId: payload.snsMessageId,
    })
    return
  }

  if (notification.kind === 'inbound') {
    await processInboundReceipt(deps, notification)
    return
  }

  // bounce / complaint / delivery — the consumer that keeps the suppression
  // list real, without which the send path's refusal floor is inert.
  await applySesDeliveryEvent(deps.prisma, notification)
}

export const processAgentEmailSendJob = async (
  deps: AgentEmailJobDeps,
  payload: AgentEmailSendJobPayload,
): Promise<void> => {
  await dispatchQueuedEmail(deps, payload.emailMessageId)
}

export const processAgentEmailRetentionJob = async (
  deps: AgentEmailJobDeps,
  payload: AgentEmailRetentionJobPayload,
): Promise<void> => {
  await sweepInboundRetention(
    {
      prisma: deps.prisma,
      retentionDays: deps.config.inboundRetentionDays,
      transport: deps.transport,
    },
    payload.limit,
  )
  // Rides the same sweep: a send whose worker died mid-claim would otherwise
  // sit in `sending` forever, telling nobody whether it went out.
  await sweepStuckSends(deps.prisma)
}
