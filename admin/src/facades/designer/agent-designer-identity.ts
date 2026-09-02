import { useMutation } from '@tanstack/react-query'
import { AGENT_DESIGNER_SLUG } from '@nessie/schemas'

import type { AgentRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAgents } from '../agents/hooks'
import type { AgentFormState } from '../../components/features/agents/designer/useAgentDesigner'

/**
 * The sidebar is the Agent Designer, not a generic "Design Assistant".
 *
 * One brain, two doorways (D9): the panel on this page and the private DM are
 * the same specialist, so the panel wears its name and its picture from the
 * identity directory rather than a hard-coded label and a speech-bubble glyph.
 * The row is found by `systemSlug` — a structural fact the server writes —
 * never by matching a display name.
 */
export const useAgentDesignerAgent = (): AgentRecord | null => {
  // `scope: 'all'` is what includes the read-only system tier; the same query
  // the identity directory and the Agents page already run, so this costs
  // nothing extra.
  const { data: agents = [] } = useAgents({ scope: 'all' })
  return agents.find((agent) => agent.systemSlug === AGENT_DESIGNER_SLUG) ?? null
}

export type ContinueInChatResult = {
  agentId: string
  channelId: string
  started: boolean
  threadId: string
}

/**
 * "Continue in chat": hand the open draft to the person's own Agent Designer
 * conversation and go there. The server writes it as the same kind of hidden
 * briefing `agent_handoff` writes — never a message impersonating the person.
 */
export const useContinueDesignInChat = () => {
  const apiClient = useApiClient()

  return useMutation({
    mutationFn: (input: {
      editingAgentId?: string
      formState: AgentFormState
    }) =>
      apiClient.post<ContinueInChatResult>('/api/designer/continue-in-chat', {
        ...(input.editingAgentId ? { editingAgentId: input.editingAgentId } : {}),
        formState: {
          model: input.formState.model,
          name: input.formState.name,
          provider: input.formState.provider,
          role: input.formState.role,
          systemPrompt: input.formState.systemPrompt,
          tools: input.formState.tools,
        },
      }),
  })
}
