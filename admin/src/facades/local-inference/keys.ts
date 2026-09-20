export const localInferenceKeys = {
  all: ['local-inference'] as const,
  bindingStatus: (agentId: string | undefined, bindingId: string | undefined) =>
    ['local-inference', 'binding-status', agentId, bindingId] as const,
  hosts: ['local-inference', 'hosts'] as const,
}
