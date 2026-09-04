import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { buildBrowserActApprovalHook } from '../browser-cloud/act-approval-gate.js'
import { reviewProposedToolAction } from './auto-review.js'
import { buildEmailSendApprovalHook } from './email-send-gate.js'
import { buildMailboxSendApprovalHook } from './mailbox-send-gate.js'
import { composeStructuralGates } from './structural-gates.js'
import { authorizeToolExecution } from './tool-authorization.js'
import type { DeepWaterHandoffGuard } from '../deepwater-handoff-guard.js'
import type { RunInference } from './run-inference.js'
import type { RunContext } from './types.js'
import type { InvocationRecord } from '@nessie/runtime'

export const createMainToolAuthorizer = (input: {
  actorContext: AuthorizedActionContext
  allowedToolIds: Set<string>
  context: RunContext
  deepWaterHandoffGuard: DeepWaterHandoffGuard
  executorToolNames: Set<string>
  externalToolNames: Set<string>
  identityToolIds: ReadonlySet<string>
  inference: RunInference
  interactive: boolean
  invocationSink: InvocationRecord[]
  isHandoffTurn: boolean
  messageId: string
  mcpToolNames: ReadonlySet<string>
  prisma: PrismaClient
  resolvedToolIds: Set<string>
  toolPolicy: Record<string, boolean> | null
}) => (
  toolName: string,
  args: Record<string, unknown>,
  toolCallId: string,
  options: {
    consumeApprovalProof?: boolean
    maySuspendForApproval?: boolean
    revalidateApprovalBoundary?: boolean
    skipAutoReview?: boolean
  } = {},
) => authorizeToolExecution(
  input.prisma,
  input.actorContext,
  input.context,
  toolName,
  args,
  toolCallId,
  {
    agentKind: input.context.agent.agentKind,
    allowedToolIds: input.allowedToolIds,
    consumeApprovalProof: options.consumeApprovalProof,
    executorToolNames: input.executorToolNames,
    externalToolNames: input.externalToolNames,
    identityToolIds: input.identityToolIds,
    maySuspendForApproval: options.maySuspendForApproval ?? !input.isHandoffTurn,
    mcpToolNames: input.mcpToolNames,
    parentAgentId: input.context.agent.parentAgentId,
    resolvedBuiltinToolIds: input.resolvedToolIds,
    resumeState: {
      actorContext: input.actorContext,
      interactive: input.interactive,
      messageId: input.messageId,
    },
    revalidateApprovalBoundary: options.revalidateApprovalBoundary,
    skipAutoReview: options.skipAutoReview,
    structuralGate: composeStructuralGates([
      buildEmailSendApprovalHook(input.prisma, input.context, input.interactive),
      buildBrowserActApprovalHook(input.prisma, input.context),
      buildMailboxSendApprovalHook(
        input.prisma,
        input.context,
        input.actorContext.actionContext.effectiveUserId ?? null,
      ),
    ]),
    toolPolicy: input.toolPolicy,
    runUtility: async (prompt: string) => {
      const result = await input.inference.runUtility([{ content: prompt, role: 'user' }], [])
      input.invocationSink.push(...result.invocations)
      return result.outputText
    },
  },
  {
    deepWaterHandoffGuard: input.deepWaterHandoffGuard,
    reviewProposedAction: async (reviewInput) => {
      const reviewed = await reviewProposedToolAction(input.inference.runUtility, reviewInput)
      input.invocationSink.push(...reviewed.invocations)
      return reviewed
    },
  },
)
