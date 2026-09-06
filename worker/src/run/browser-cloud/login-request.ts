import {
  ensureAgentBrowser,
  isCloudBrowserError,
  releaseSessionsForRun,
  type CloudBrowserDeps,
} from '@nessie/browser-cloud'
import type { Prisma } from '@prisma/client'
import { AgentCardMessageMetadataSchema, type AgentCardSpec } from '@nessie/schemas'
import { renderAgentCardPlainText } from '@nessie/team-admin'

import { resolveBrowserPrincipal } from './browser-principal.js'
import { createAgentMessage } from '../execute/agent-message.js'
import { applyRunReplyBookkeeping } from '../execute/lifecycle.js'
import { publishMessageCreated } from '../execute/realtime.js'
import { alertCardRespondents } from '../mention-alerts.js'
import { buildRealtimeScopesForChannel } from '../pa-tools/message-destination.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { releaseCdp } from './session-pool.js'

/**
 * `browser_login_request` — the agent asks a person to sign its browser in.
 *
 * The shape was forced by three facts that broke the obvious design:
 *
 * 1. The card machinery is one-shot: an action press resolves the card and
 *    resumes the run, so "Open browser" and "Done" cannot be two presses on
 *    one card. The link is a *block*, not an action; the single action is Done.
 * 2. Browserbase ends a session when its automation connection closes unless
 *    the paid keepAlive is set, so a session the parked worker abandoned would
 *    be a dead iframe on the free tier. The run therefore releases its session
 *    first and the viewer mints a fresh, human-only one.
 * 3. Nothing is metered while a person takes their time, precisely because the
 *    parked run holds no session at all.
 */

const CARD_EXPIRY_SECONDS = 15 * 60

export type LoginRequestOutcome = {
  output: string
  success: boolean
  cardId?: string
}

const deploymentClampedExpiry = (): Date =>
  new Date(Date.now() + CARD_EXPIRY_SECONDS * 1000)

export const requestBrowserLogin = async (
  deps: CloudBrowserDeps,
  context: BuiltinToolRuntimeContext & {
    agentIdentity?: { visibility: 'team' | 'private'; ownerUserId: string | null }
  },
  args: { service: string; reason: string },
): Promise<LoginRequestOutcome> => {
  const runContext = context.runContext
  if (!runContext) {
    return { output: 'Unable to resolve the current conversation.', success: false }
  }
  // Only the person who asked can be handed the controls; an unattended run
  // has nobody to ask, and asking the room would invite the wrong person.
  const requesterId = context.run.originatingUserId ?? context.run.principalUserId ?? null
  if (!requesterId) {
    return {
      output:
        'Nobody is available to sign in — this run was not started by a person. '
        + 'Use a throwaway browser for public pages instead.',
      success: false,
    }
  }

  let browserId: string
  try {
    const browser = await ensureAgentBrowser(deps, {
      organizationId: context.channel.organizationId,
      agentId: context.agentId,
      agentVisibility: context.agentIdentity?.visibility ?? 'team',
      agentOwnerUserId: context.agentIdentity?.ownerUserId ?? null,
      principalUserId: await resolveBrowserPrincipal(context),
    })
    browserId = browser.id
  } catch (error) {
    if (isCloudBrowserError(error)) return { output: error.message, success: false }
    throw error
  }

  // Release before parking: a session nobody is driving still bills, and the
  // person signs in through a fresh one the viewer mints.
  const live = await deps.prisma.cloudBrowserSession.findFirst({
    where: {
      runId: context.run.id,
      status: { in: ['allocating', 'active', 'releasing'] },
    },
    select: { id: true },
  })
  if (live) releaseCdp(live.id)
  await releaseSessionsForRun(deps, {
    runId: context.run.id,
    releasedBy: 'login_handoff',
  })

  const service = args.service.trim().slice(0, 80)
  const card: AgentCardSpec = {
    schemaVersion: 1,
    title: `Sign in to ${service}`,
    subtitle: args.reason.trim().slice(0, 200),
    blocks: [
      {
        type: 'text',
        markdown:
          `Open my browser from the Browser tool beside this conversation, sign in `
          + `to ${service}, then press Done. You type directly into the browser — `
          + 'nothing you enter passes through this team, and nobody, including '
          + 'me, can see it.',
      },
      {
        // The routed doorway to the agent's browser panel — the same one the
        // tool rail opens. An earlier placeholder pointed at a host that does
        // not exist, which made the card's only link a dead end.
        type: 'link',
        href: `/channels/${context.channel.id}/tools/browser`,
        label: 'Open the browser',
      },
    ],
    actions: [{ key: 'done', label: 'Done', style: 'primary', submits: true }],
  }

  const content = renderAgentCardPlainText(card)
  const expiresAt = deploymentClampedExpiry()

  const created = await deps.prisma.$transaction(async (tx) => {
    const message = await createAgentMessage(tx, runContext, {
      agentId: context.agentId,
      content,
      role: 'assistant',
      threadId: context.run.threadId,
      ...(runContext.replyRootMessageId
        ? { rootMessageId: runContext.replyRootMessageId }
        : {}),
    })
    const row = await tx.agentCard.create({
      data: {
        agentId: context.agentId,
        browserLogin: { agentBrowserId: browserId, service } as Prisma.InputJsonValue,
        channelId: context.channel.id,
        expiresAt,
        messageId: message.id,
        organizationId: context.channel.organizationId,
        respondentUserIds: [requesterId],
        runId: context.run.id,
        spec: card as unknown as Prisma.InputJsonValue,
        threadId: context.run.threadId,
      },
      select: { id: true },
    })
    await tx.message.update({
      data: {
        metadata: AgentCardMessageMetadataSchema.parse({
          agentCard: { cardId: row.id, schemaVersion: 1 },
        }) as unknown as Prisma.InputJsonValue,
      },
      where: { id: message.id },
    })
    return { cardId: row.id, message }
  })

  const reply = runContext.replyRootMessageId
    ? await applyRunReplyBookkeeping(deps.prisma, runContext, created.message.createdAt)
    : undefined
  await publishMessageCreated(context.realtimeTransport, runContext, {
    content: created.message.content,
    messageId: created.message.id,
    role: 'assistant',
    ...(created.message.basis.length > 0 ? { restricted: true } : {}),
    ...(reply ? { reply } : {}),
  })
  await alertCardRespondents(context, {
    channelId: context.channel.id,
    messageCreatedAt: created.message.createdAt,
    messageId: created.message.id,
    organizationId: context.channel.organizationId,
    recipientUserIds: [requesterId],
    scopes: buildRealtimeScopesForChannel({
      channelId: context.channel.id,
      organizationId: context.channel.organizationId,
      systemChannelType: context.channel.systemChannelType ?? null,
    }),
    threadId: context.run.threadId,
  })

  return {
    cardId: created.cardId,
    output:
      `Asked for a sign-in to ${service}. Waiting for them to finish; your `
      + 'browser is closed until then, so nothing is being metered.',
    success: true,
  }
}
