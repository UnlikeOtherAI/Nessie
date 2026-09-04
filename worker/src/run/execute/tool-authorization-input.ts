import {
  EMAIL_SEND_TOOL_ID,
  GMAIL_DRAFT_SEND_TOOL_ID,
  hasStrictToolAuthorizationInput,
  parseToolAuthorizationArgs,
} from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'

import { bindAgentEmailApprovalProposal, sealedAgentEmailProposalIsLive } from './agent-email-approval.js'
import { bindGmailDraftApprovalFingerprint } from './gmail-draft-approval.js'
import { auditToolAuthorizationDenial } from './tool-approval.js'
import type {
  ToolActorContext,
  ToolAuthorizationAuditEmitter,
  ToolAuthorizationDecision,
} from './tool-authorization-contract.js'
import type { RunContext } from './types.js'

type PreparedToolAuthorizationInput =
  | Extract<ToolAuthorizationDecision, { decision: 'deny' }>
  | { args: Record<string, unknown>; decision: 'ready' }

/**
 * Canonicalize credential-bound tool input before any policy, approval, audit,
 * or dispatch code can observe it. Gmail drafts and hosted-mail proposals are
 * mutable server records, so each is bound to its reviewed target here.
 */
export const prepareToolAuthorizationInput = async (
  prisma: PrismaClient,
  context: RunContext,
  toolName: string,
  args: Record<string, unknown>,
  toolActorContext: ToolActorContext,
  emitAudit: ToolAuthorizationAuditEmitter,
  revalidateApprovalBoundary: boolean | undefined,
): Promise<PreparedToolAuthorizationInput> => {
  let canonicalArgs: Record<string, unknown>
  try {
    canonicalArgs = parseToolAuthorizationArgs(toolName, args)
  } catch {
    // These are credential-boundary tools. An unrecognised field can be a
    // password or authorization code, so it must not reach any durable sink.
    await auditToolAuthorizationDenial(emitAudit, toolActorContext, context, toolName, {
      source: 'worker_tool_authorization',
    }, 'invalid_tool_input')
    return {
      decision: 'deny',
      result: {
        inputSummary: 'Invalid tool input.',
        output: hasStrictToolAuthorizationInput(toolName)
          ? 'The tool arguments were invalid. Use only the documented fields.'
          : 'The tool arguments were invalid.',
        success: false,
      },
    }
  }

  if (toolName === GMAIL_DRAFT_SEND_TOOL_ID) {
    const approvedArgs = await bindGmailDraftApprovalFingerprint(
      prisma, toolActorContext, context.channel.organizationId, canonicalArgs,
    )
    if (!approvedArgs) {
      await auditToolAuthorizationDenial(emitAudit, toolActorContext, context, toolName, {
        source: 'worker_tool_authorization',
      }, 'invalid_tool_target')
      return {
        decision: 'deny',
        result: {
          inputSummary: 'Unavailable Gmail draft.',
          output: 'I cannot find that draft.',
          success: false,
        },
      }
    }
    canonicalArgs = approvedArgs
  }

  if (toolName === EMAIL_SEND_TOOL_ID) {
    if (revalidateApprovalBoundary) {
      // A continuation must use the target that was reviewed, but the mailbox
      // itself still has to belong to this live agent in this live tenant.
      // Never reconstruct a reply from a possibly changed conversation here.
      if (!await sealedAgentEmailProposalIsLive(prisma, context, canonicalArgs)) {
        await auditToolAuthorizationDenial(emitAudit, toolActorContext, context, toolName, {
          source: 'worker_tool_authorization',
        }, 'invalid_tool_target')
        return {
          decision: 'deny',
          result: {
            inputSummary: 'Unavailable agent mailbox.',
            output: 'The approved mailbox is no longer available. Please prepare the email again.',
            success: false,
          },
        }
      }
    } else {
      // The model may never choose the hidden proposal shape. It is resolved
      // once from its narrow public input and replaces any untrusted value
      // before policy, approval, audit, or queue handling observes it.
      const sealedArgs = await bindAgentEmailApprovalProposal(prisma, context, canonicalArgs)
      if (!sealedArgs) {
        await auditToolAuthorizationDenial(emitAudit, toolActorContext, context, toolName, {
          source: 'worker_tool_authorization',
        }, 'invalid_tool_target')
        return {
          decision: 'deny',
          result: {
            inputSummary: 'Unable to prepare email.',
            output: 'I could not prepare that email. Check the recipient or conversation and try again.',
            success: false,
          },
        }
      }
      canonicalArgs = sealedArgs
    }
  }

  return { args: canonicalArgs, decision: 'ready' }
}
