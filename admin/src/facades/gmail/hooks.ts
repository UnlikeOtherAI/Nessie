import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * React-Query facade for the owner-gated Gmail draft surface. Every route is
 * scoped server-side to the session user and answers an indistinguishable 404
 * otherwise, so the client passes no owner id and a non-owner simply gets an
 * error it renders as nothing.
 */

export type GmailDraftView = {
  id: string
  state: 'draft' | 'sending' | 'sent' | 'discarded'
  revision: number
  contentFingerprint: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  attachments: { filename: string; mimeType: string; sizeBytes: number }[]
}

export const gmailKeys = {
  draft: (id: string) => ['gmail', 'draft', id] as const,
  sendGrants: ['gmail', 'send-grants'] as const,
}

export const useGmailDraft = (id: string | null) => {
  const apiClient = useApiClient()
  return useQuery<GmailDraftView>({
    queryKey: gmailKeys.draft(id ?? 'none'),
    queryFn: () => apiClient.get(`/api/gmail/drafts/${id}`),
    enabled: id !== null,
    // A non-owner gets an indistinguishable 404; retrying it would just burn
    // requests to reach the same answer.
    retry: false,
  })
}

export const useSendGmailDraft = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; expectedFingerprint?: string }) =>
      apiClient.post<{ status: string; sendAfter?: string }>(
        `/api/gmail/drafts/${input.id}/send`,
        input.expectedFingerprint
          ? { expectedFingerprint: input.expectedFingerprint }
          : {},
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: gmailKeys.draft(input.id) })
    },
  })
}

export const useUndoGmailSend = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ state: string }>(`/api/gmail/drafts/${id}/undo`),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: gmailKeys.draft(id) })
    },
  })
}

export const useDiscardGmailDraft = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ state: string }>(`/api/gmail/drafts/${id}`),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: gmailKeys.draft(id) })
    },
  })
}

export type SendGrant = {
  id: string
  agentId: string
  agentName: string
  connectionId: string
  /** Which mailbox — ambiguous without it once two accounts are connected. */
  accountEmail: string
  mode: 'always' | 'judged'
  boundary: string | null
  decidedCount: number
  askedCount: number
  expiresAt: string | null
  createdAt: string
}

export type GrantSendInput = {
  connectionId: string
  agentId: string
  duration: '10m' | 'today' | '30d' | 'forever'
  mode?: 'always' | 'judged'
  boundary?: string
}

export const useGrantSendAuthorization = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: GrantSendInput) =>
      apiClient.post<{ id: string; expiresAt: string | null }>(
        '/api/gmail/send-grants',
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gmailKeys.sendGrants })
    },
  })
}

export const useSendGrants = () => {
  const apiClient = useApiClient()
  return useQuery<{ grants: SendGrant[] }>({
    queryKey: gmailKeys.sendGrants,
    queryFn: () => apiClient.get('/api/gmail/send-grants'),
  })
}

export const useRevokeSendGrant = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ revoked: boolean }>(`/api/gmail/send-grants/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gmailKeys.sendGrants })
    },
  })
}
