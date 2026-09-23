import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentCardPresenter, AgentCardRespondResult } from '@nessie/schemas'

import { threadKeys } from '../threads/keys'
import { agentCardKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/** The card id is opaque; the server resolves every viewer-scoped fact. */
export const useAgentCard = (cardId: string | undefined) => {
  const apiClient = useApiClient()

  return useQuery<AgentCardPresenter>({
    enabled: Boolean(cardId),
    placeholderData: keepPreviousData,
    queryFn: () => apiClient.get(`/api/agent-cards/${cardId}`),
    queryKey: agentCardKeys.card(cardId),
  })
}

export type RespondToAgentCardInput = {
  actionKey: string
  cardId: string
  threadId: string
  values?: Record<string, string | number | boolean>
  /** Exact private browser session for a temporary-login Done press. */
  handoverSessionId?: string
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
      apiClient.post<AgentCardRespondResult>(
        `/api/agent-cards/${input.cardId}/respond`,
        {
          actionKey: input.actionKey,
          ...(input.values ? { values: input.values } : {}),
          ...(input.secrets ? { secrets: input.secrets } : {}),
          ...(input.handoverSessionId ? { handoverSessionId: input.handoverSessionId } : {}),
        },
      ),
    // On settle, not on success: a press can fail after the server resolved
    // the card (a dropped connection, or another door winning the claim), and
    // refreshing only on success left a resolved card looking pressable.
    onSettled: (_result, _error, input) => {
      void queryClient.invalidateQueries({ queryKey: agentCardKeys.card(input.cardId) })
      // The press wrote a real reply, so the feed and the reply panel refresh
      // through the path they already use for any other message.
      void queryClient.invalidateQueries({ queryKey: threadKeys.messages(input.threadId) })
    },
  })
}
