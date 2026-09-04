export const denyRule = (toolId: string): Record<string, unknown> => ({
  action: 'invoke',
  bindings: [{ actorId: '*', actorType: 'user' }],
  conditions: null,
  effect: 'deny',
  id: 'rule-deny',
  priority: 1,
  resourceType: 'tool',
  scope: 'tool',
  scopeId: toolId,
})

export const approvalRule = (toolId: string): Record<string, unknown> => ({
  action: 'invoke',
  bindings: [{ actorId: '*', actorType: 'user' }],
  conditions: { approvalActionType: 'tool.invoke', requiresApproval: true },
  effect: 'allow',
  id: 'rule-approval',
  priority: 1,
  resourceType: 'tool',
  scope: 'tool',
  scopeId: toolId,
})

export const autoReviewRule = (toolId: string): Record<string, unknown> => ({
  action: 'invoke',
  bindings: [{ actorId: '*', actorType: 'user' }],
  conditions: { reviewMode: 'auto' },
  effect: 'allow',
  id: 'rule-auto-review',
  priority: 1,
  resourceType: 'tool',
  scope: 'tool',
  scopeId: toolId,
})
