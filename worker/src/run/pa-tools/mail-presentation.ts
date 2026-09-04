import { Prisma } from '@prisma/client'
import {
  MailPresentToolInputSchema,
  MailPresentToolOutputSchema,
  type AgentCardSpec,
} from '@nessie/schemas'
import { resolveConnectedMailPresentationAccess } from '@nessie/team-admin'
import { z } from 'zod'

import { createAgentMessage } from '../execute/agent-message.js'
import { applyRunReplyBookkeeping } from '../execute/lifecycle.js'
import { publishMessageCreated } from '../execute/realtime.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveEffectiveUserId } from './access.js'
import {
  mailPresentationReference,
  reviewUrlForMailPresentation,
} from './mail-presentation-reference.js'

const MailboxComposeSchema = z.object({ connectionId: z.string().uuid().optional() }).strict()

const accessFor = async (
  context: BuiltinToolRuntimeContext,
  input: {
    accountId?: string
    draftId?: string
    mode: 'account' | 'thread' | 'compose'
    source: 'gmail' | 'mailbox'
  },
) => resolveConnectedMailPresentationAccess(context.prisma, {
  accountId: input.accountId,
  draftId: input.draftId,
  agentId: context.agentId,
  effectiveUserId: resolveEffectiveUserId(context),
  mode: input.mode,
  organizationId: context.channel.organizationId,
  source: input.source,
})

/**
 * Present an already-authorized connected-mail surface in the conversation.
 *
 * The message contains a strict, content-free pointer. Mail stays behind the
 * normal no-store API read path, and this tool has no send or content inputs.
 */
export const runMailPresentTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = MailPresentToolInputSchema.parse(input)
  const runContext = context.runContext
  if (!runContext) throw new Error('Unable to resolve the current conversation.')

  const access = await accessFor(context, args)
  // A doorway is derived from a private account even though it reads no body.
  // Stamp before the durable message write; otherwise an exception could leave
  // a pointer to somebody's mailbox unrestricted in a shared conversation.
  context.consumedSources?.add(access.basis)

  const created = await createAgentMessage(context.prisma, runContext, {
    agentId: context.agentId,
    content: 'Open mail.',
    metadata: {
      mailSurfaceDoorway: MailPresentToolInputSchema.parse(args),
    } as Prisma.InputJsonValue,
    role: 'assistant',
    threadId: context.run.threadId,
    ...(runContext.replyRootMessageId ? { rootMessageId: runContext.replyRootMessageId } : {}),
  })
  const reply = runContext.replyRootMessageId
    ? await applyRunReplyBookkeeping(context.prisma, runContext, created.createdAt)
    : undefined
  // The normal restricted-aware message signal is the only realtime effect.
  await publishMessageCreated(context.realtimeTransport, runContext, {
    content: created.content,
    messageId: created.id,
    role: 'assistant',
    ...(created.basis.length > 0 ? { restricted: true } : {}),
    ...(reply ? { reply } : {}),
  })

  const output = MailPresentToolOutputSchema.parse({
    messageId: created.id,
    reviewUrl: reviewUrlForMailPresentation(args),
  })
  return {
    inputSummary: `source=${args.source}; mode=${args.mode}; account=${args.accountId}`,
    outputPreview: JSON.stringify(output),
    toolName: 'mail_present',
  }
}

/**
 * Give the model a card_post-compatible compose form, never an email renderer.
 * The card press is only a normal user message; sending still requires the
 * existing mailbox_send approval path on the follow-up run.
 */
export const runMailboxComposeTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = MailboxComposeSchema.parse(input)
  const access = await accessFor(context, {
    accountId: args.connectionId,
    mode: 'compose',
    source: 'mailbox',
  })
  context.consumedSources?.add(access.basis)

  const card: AgentCardSpec = {
    actions: [
      { key: 'send', label: 'Send', style: 'primary', submits: true },
      { key: 'dismiss', label: 'Dismiss', style: 'secondary', submits: false },
    ],
    blocks: [
      { type: 'input', key: 'to', label: 'To', input: 'text', required: true },
      { type: 'input', key: 'cc', label: 'Cc', input: 'text' },
      { type: 'input', key: 'bcc', label: 'Bcc', input: 'text' },
      { type: 'input', key: 'subject', label: 'Subject', input: 'text', required: true },
      {
        type: 'input',
        key: 'body',
        label: 'Message',
        input: 'textarea',
        maxLength: 100_000,
        required: true,
      },
    ],
    schemaVersion: 1,
    service: { key: 'mail', label: 'Mail' },
    title: `Compose from ${access.accountId}`,
  }
  return {
    inputSummary: `connection=${access.accountId}`,
    outputPreview: JSON.stringify({
      card,
      connectionId: access.accountId,
      mailPresentation: mailPresentationReference({
        accountId: access.accountId,
        mode: 'compose',
        source: 'mailbox',
      }),
      instruction:
        'Post this with card_post. A Send press is only a response; use mailbox_send afterwards so approval is still required.',
    }),
    toolName: 'mailbox_compose',
  }
}
