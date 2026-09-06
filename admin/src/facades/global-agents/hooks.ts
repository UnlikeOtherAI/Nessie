import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ChannelRecord, GlobalAgentHomeResponse } from '../../lib/api-client'
import { channelKeys } from '../channels/keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { upsertChannel } from '../channels/channel-cache'

/**
 * The Agent Designer's blueprint slug. It is a durable server-side
 * discriminator, so the client addresses the chat by it rather than guessing
 * which system-agent DM belongs to which blueprint.
 */
export const AGENT_DESIGNER_SLUG = 'agent-designer'
export const DASHBOARD_DESIGNER_SLUG = 'dashboard-designer'

/**
 * Open a global agent's home DM, provisioning it if this person has none.
 *
 * Every client — web, the Tauri desktop shells on macOS/Windows/Linux, and the
 * iOS/Android WebView shells — runs this same admin SPA, so this one hook is
 * the doorway on all of them. It is a mutation rather than a query because the
 * call ensures rows: login-time bootstrap is best-effort by design, and a
 * doorway that assumed the channel already existed would fail silently for the
 * people it did not run for.
 */
export const useOpenGlobalAgentHome = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (slug: string) =>
      apiClient.post<GlobalAgentHomeResponse>(`/api/global-agents/${slug}/home`),
    onSuccess: (response) => {
      queryClient.setQueryData<ChannelRecord[] | undefined>(
        channelKeys.all,
        (current) => upsertChannel(current, response.channel),
      )
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
    },
  })
}
