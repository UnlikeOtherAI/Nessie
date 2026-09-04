const STANDING_CONSENT_TOOL_NAMES = new Set([
  'gmail_draft_send',
  'calendar_event_create',
  'calendar_event_update',
  'calendar_event_cancel',
])

export const APPROVAL_GATE_ACTIONS = {
  approve: 'Approve action',
  reject: 'Reject',
  standingConsent: 'Approve, and don’t ask again',
} as const

/**
 * Only server-frozen Google actions can trade one approval for a standing rule.
 * Mailbox and account lifecycle actions remain one-time decisions.
 */
export const canCreateStandingConsentFromApproval = (
  toolName: string,
  context: Record<string, unknown> | null | undefined,
): boolean =>
  STANDING_CONSENT_TOOL_NAMES.has(toolName)
  && typeof context?.approvedGoogleConnectionId === 'string'

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
