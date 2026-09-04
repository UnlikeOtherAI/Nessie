/**
 * Browser-safe approval projection.
 *
 * Tool approvals retain their exact executable arguments in `resumeState`.
 * This presenter is the only list/detail projection and deliberately turns an
 * email proposal into fixed copy, including historic rows written before that
 * boundary existed.
 */

type ApprovalPresenterRow = {
  id: string
  organizationId: string
  projectId: string | null
  teamId: string | null
  channelId: string | null
  taskId: string | null
  runId: string | null
  agentId: string
  requesterId: string
  action: string
  reason: string
  context: unknown
  status: string
  resolverId: string | null
  resolvedAt: Date | null
  resolution: string | null
  resolutionNote: string | null
  requiredApproverRole: string | null
  continuationToken: string
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
  toolName?: string | null
}

const PRIVATE_EMAIL_TOOL_NAMES = new Set(['email_send', 'gmail_draft_send', 'mailbox_send'])

const presentApprovalReason = (reason: string, toolName: string | null): string =>
  PRIVATE_EMAIL_TOOL_NAMES.has(toolName ?? '')
    ? 'Review the email before deciding whether to send it.'
    : reason

/**
 * Historic rows may already contain a generic input summary. Never present an
 * email proposal from that public blob: its recipients, subject and body are
 * only materialized from `resumeState` through the exact-approver review API.
 */
const presentApprovalContext = (
  context: unknown,
  toolName: string | null,
): Record<string, unknown> | null => {
  if (!PRIVATE_EMAIL_TOOL_NAMES.has(toolName ?? '')) {
    return context as Record<string, unknown> | null
  }

  const raw = context !== null && typeof context === 'object' && !Array.isArray(context)
    ? context as Record<string, unknown>
    : {}
  const emailSummary = toolName === 'gmail_draft_send'
    ? {
      audience: 'The recipients will receive it',
      headline: 'Send an email as you',
    }
    : toolName === 'mailbox_send'
      ? {
        audience: 'The recipients will receive it',
        headline: 'Send an email from a connected mailbox',
      }
      : {
        audience: 'The recipients will receive it',
        headline: 'Send an email from the agent mailbox',
      }

  // Gmail's standing-consent shortcut needs only the frozen connection id.
  // It is not a recipient/body/subject and remains visible only through the
  // pin-aware approval presenter.
  const approvedGoogleConnectionId = raw['approvedGoogleConnectionId']
  return {
    ...emailSummary,
    ...(typeof approvedGoogleConnectionId === 'string'
      ? { approvedGoogleConnectionId }
      : {}),
    toolName,
  }
}

export const mapApproval = (approval: ApprovalPresenterRow) => ({
  id: approval.id,
  organizationId: approval.organizationId,
  projectId: approval.projectId,
  teamId: approval.teamId,
  channelId: approval.channelId,
  taskId: approval.taskId,
  runId: approval.runId,
  agentId: approval.agentId,
  requesterId: approval.requesterId,
  action: approval.action,
  reason: presentApprovalReason(approval.reason, approval.toolName ?? null),
  context: presentApprovalContext(approval.context, approval.toolName ?? null),
  status: approval.status,
  resolverId: approval.resolverId,
  resolvedAt: approval.resolvedAt?.toISOString() ?? null,
  resolution: approval.resolution,
  resolutionNote: approval.resolutionNote,
  requiredApproverRole: approval.requiredApproverRole,
  expiresAt: approval.expiresAt.toISOString(),
  createdAt: approval.createdAt.toISOString(),
  updatedAt: approval.updatedAt.toISOString(),
})
