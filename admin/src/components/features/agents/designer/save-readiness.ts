export type SaveBlockerInput = {
  action: 'create' | 'save'
  hasModel: boolean
  hasName: boolean
}

/**
 * The save action is gated on a name and a resolvable model, and a gate the
 * form never explains reads as a broken button — the Design Assistant reports
 * the agent is configured while Create sits dead. Return the one sentence that
 * names what the person still has to do, or `null` when nothing is missing.
 */
export const saveBlockedReason = ({ action, hasModel, hasName }: SaveBlockerInput): string | null => {
  const suffix = action === 'create' ? 'to create this agent.' : 'to save changes.'

  if (!hasName && !hasModel) return `Add a name and pick a model ${suffix}`
  if (!hasName) return `Add a name ${suffix}`
  if (!hasModel) return `Pick a model ${suffix}`
  return null
}
