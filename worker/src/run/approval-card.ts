import type { PrismaClient } from '@prisma/client'
import {
  postApprovalCards,
  resolveApprovalCardTargets,
  type ApprovalCardTarget,
} from '@nessie/team-admin'
import {
  parseAgentId,
  parseChannelId,
  parseThreadId,
  type ApprovalGateMetadata,
} from '@nessie/schemas'
import type { PgRealtimeTransport } from '@nessie/runtime'

import { buildRealtimeScopesForChannel } from './pa-tools/message-destination.js'

/**
 * Open an approval's card, in every conversation it has to appear in.
 *
 * The three approval kinds a person proposes through an agent —
 * `knowledge.page.publish`, `agent.todo_template.publish` and
 * `workflow.template.adopt` — used to create a request and post nothing, which
 * is what made them reachable only from the approvals page. They call this.
 *
 * The run tool gate does not: it suspends the run, and posting its card is one
 * step of a larger transition that also writes a checkpoint and parks the run
 * (`execute/approval-suspend.ts`). It writes the same `approvalGate` metadata.
 */
export const openApprovalCard = async (
  deps: { prisma: PrismaClient; realtimeTransport: PgRealtimeTransport },
  input: {
    agentId: string
    approverUserIds: string[]
    content: string
    gate: ApprovalGateMetadata
    organizationId: string
    originChannelId: string
    originSystemChannelType?: string | null
    originThreadId: string
  },
): Promise<ApprovalCardTarget[]> => {
  const targets = await resolveApprovalCardTargets(deps.prisma, {
    approverUserIds: input.approverUserIds,
    organizationId: input.organizationId,
    originChannelId: input.originChannelId,
    originSystemChannelType: input.originSystemChannelType ?? null,
    originThreadId: input.originThreadId,
  })
  const written = await postApprovalCards(deps.prisma, {
    agentId: input.agentId,
    content: input.content,
    gate: input.gate,
    targets,
  })

  for (const card of written) {
    // Announced on the destination channel's own scopes rather than the run's:
    // a copy in an owner's assistant conversation lands in a thread this run
    // has never spoken in, which is the same case `agent-conversations.ts`
    // handles when its opener lands elsewhere.
    //
    // Best-effort, for the reason `raiseApprovalAlert` gives about the bell:
    // the card row is the durable surface, and an approval that exists but
    // arrived a refresh late is recoverable while one rolled back because the
    // announcement failed is not.
    try {
      await deps.realtimeTransport.publishWs(
        buildRealtimeScopesForChannel({
          channelId: card.channelId,
          organizationId: input.organizationId,
          systemChannelType: card.systemChannelType as Parameters<
            typeof buildRealtimeScopesForChannel
          >[0]['systemChannelType'],
        }),
        {
          data: {
            agentId: parseAgentId(input.agentId),
            channelId: parseChannelId(card.channelId),
            contentPreview: input.content.slice(0, 200),
            messageId: card.messageId,
            role: 'assistant' as const,
            threadId: parseThreadId(card.threadId),
          },
          event: 'message.new',
        },
      )
    } catch (error) {
      console.error('[worker.approval-card] could not announce card', card.messageId, error)
    }
  }
  return written
}
