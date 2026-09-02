import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentCardPresenter } from '@nessie/schemas'

import { agentCardKeys, threadKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/** The card id is opaque; the server resolves every viewer-scoped fact. */
export const useAgentCard = (cardId: string | undefined) => {
  const apiClient = useApiClient()

  return useQuery<AgentCardPresenter>({
    enabled: Boolean(cardId),
    queryFn: () => apiClient.get(`/api/agent-cards/${cardId}`),
    queryKey: agentCardKeys.card(cardId),
  })
}

export type RespondToAgentCardInput = {
  actionKey: string
  cardId: string
  threadId: string
  values?: Record<string, string | number | boolean>
  /**
   * Masked field values. Held only in component state and sent only here; the
   * server places them in the encrypted credential store and records that they
   * were provided, never what they were. Never put one in a query cache.
   */
  secrets?: Record<string, string>
}

export const useRespondToAgentCard = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: RespondToAgentCardInput) =>
      apiClient.post<{ cardId: string; responseMessageId: string; status: string }>(
        `/api/agent-cards/${input.cardId}/respond`,
        {
          actionKey: input.actionKey,
          ...(input.values ? { values: input.values } : {}),
          ...(input.secrets ? { secrets: input.secrets } : {}),
        },
      ),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: agentCardKeys.card(input.cardId) })
      // The press wrote a real reply, so the feed and the reply panel refresh
      // through the path they already use for any other message.
      void queryClient.invalidateQueries({ queryKey: threadKeys.messages(input.threadId) })
    },
  })
}
