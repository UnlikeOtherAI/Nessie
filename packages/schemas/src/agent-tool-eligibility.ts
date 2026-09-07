/** Structural eligibility for an ordinary shared agent's tool policy. */
export const isSharedAgentToolEligible = (tool: {
  personalAssistantOnly?: boolean
  projectDelegatedOnly?: boolean
}): boolean => tool.personalAssistantOnly !== true || tool.projectDelegatedOnly === true
