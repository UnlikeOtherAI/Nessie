const STANDING_CONSENT_TOOL_NAMES = new Set([
  'calendar_event_create',
  'calendar_event_update',
  'calendar_event_cancel',
])

/**
 * Sending an email is different from an ordinary tool decision: the approver
 * must see the frozen message, not just its safe summary in a chat card.
 */
export const EMAIL_APPROVAL_REVIEW_TOOL_NAMES = new Set([
  'email_send',
  'gmail_draft_send',
  'mailbox_send',
])

export const APPROVAL_GATE_ACTIONS = {
  approve: 'Approve action',
  reject: 'Reject',
  standingConsent: 'Approve, and don’t ask again',
} as const

/**
 * Calendar actions can trade one approval for a standing rule. Email sends
 * never do so from a chat card: their exact correspondence has to be reviewed
 * first, and connected mail remains one-time only.
 */
export const canCreateStandingConsentFromApproval = (
  toolName: string,
  context: Record<string, unknown> | null | undefined,
): boolean =>
  STANDING_CONSENT_TOOL_NAMES.has(toolName)
  && typeof context?.approvedGoogleConnectionId === 'string'

export const requiresEmailApprovalReview = (toolName: string): boolean =>
  EMAIL_APPROVAL_REVIEW_TOOL_NAMES.has(toolName)

export const approvalGateActionLabels = (
  toolName: string,
  context: Record<string, unknown> | null | undefined,
): readonly string[] => [
  APPROVAL_GATE_ACTIONS.approve,
  APPROVAL_GATE_ACTIONS.reject,
  ...(canCreateStandingConsentFromApproval(toolName, context)
    ? [APPROVAL_GATE_ACTIONS.standingConsent]
    : []),
]
