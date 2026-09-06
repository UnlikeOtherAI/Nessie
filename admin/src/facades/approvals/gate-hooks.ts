import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../../providers/ApiClientProvider'
import { gmailKeys } from '../gmail/keys'

/**
 * "Don't ask me again", from the in-thread approval gate.
 *
 * Reading and resolving an approval already live in `./hooks.ts`; this is only
 * the standing-rule mutation, which no other surface has. The client names the
 * approval rather than the mailbox: the server resolves which account it
 * belongs to and refuses when the caller has two connected, rather than
 * spending consent on a guess.
 */

export type ApprovalDuration = '10m' | 'today' | '30d' | 'forever'

export const useGrantFromApproval = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      approvalId: string
      duration: ApprovalDuration
      mode?: 'always' | 'judged'
      boundary?: string
    }) =>
      apiClient.post<{ id: string; expiresAt: string | null }>(
        '/api/gmail/send-grants/from-approval',
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gmailKeys.sendGrants })
    },
  })
}
