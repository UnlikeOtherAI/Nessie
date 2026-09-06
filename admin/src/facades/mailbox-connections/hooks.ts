import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  MailboxConnectionRecord,
  MailboxConnectionScope,
  MailboxDiscoveryResult,
  MailboxTransportSecurity,
} from '../../lib/api-client'
import { mailboxConnectionKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * Connected SMTP/IMAP mailboxes. One list for both homes — the panel narrows by
 * scope rather than the API returning a different set per surface, so the two
 * surfaces cannot disagree about what exists.
 */
export const useMailboxConnections = () => {
  const apiClient = useApiClient()
  return useQuery<{ connections: MailboxConnectionRecord[] }>({
    placeholderData: keepPreviousData,
    queryFn: () => apiClient.get('/api/mailbox-connections'),
    queryKey: mailboxConnectionKeys.list,
  })
}

export type ConnectMailboxInput = {
  scope: MailboxConnectionScope
  teamId?: string | null
  label: string
  address: string
  username: string
  password: string
  imapHost: string
  imapPort: number
  imapSecurity: MailboxTransportSecurity
  smtpHost: string
  smtpPort: number
  smtpSecurity: MailboxTransportSecurity
}

export const useConnectMailbox = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ConnectMailboxInput) =>
      apiClient.post<MailboxConnectionRecord>('/api/mailbox-connections', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mailboxConnectionKeys.list })
    },
  })
}

/**
 * Finds a provider and safe connection strategy before the credential form can
 * render. Kept in the mailbox facade so components never carry `/api` paths or
 * knowledge of the discovery wire format.
 */
export const useDiscoverMailbox = () => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: (input: DiscoverMailboxInput) =>
      apiClient.post<MailboxDiscoveryResult>(
        '/api/mailbox-connections/discover',
        mailboxDiscoveryRequest(input),
      ),
  })
}

export type DiscoverMailboxInput = {
  email: string
  scope: MailboxConnectionScope
  teamId?: string
}

/** Keeps optional team scope absent instead of serialising an invalid null UUID. */
export const mailboxDiscoveryRequest = ({ email, scope, teamId }: DiscoverMailboxInput) => ({
  email,
  scope,
  ...(teamId ? { teamId } : {}),
})

export const useTestMailboxConnection = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (connectionId: string) =>
      apiClient.post<{ ok: boolean; detail: string }>(
        `/api/mailbox-connections/${connectionId}/test`,
        {},
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mailboxConnectionKeys.list })
    },
  })
}

export const useDisconnectMailbox = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (connectionId: string) =>
      apiClient.delete<void>(`/api/mailbox-connections/${connectionId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mailboxConnectionKeys.list })
    },
  })
}

export const useSetMailboxAgentAccess = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { connectionId: string; agentId: string; allowed: boolean }) =>
      apiClient.post<MailboxConnectionRecord>(
        `/api/mailbox-connections/${input.connectionId}/agent-access`,
        { agentId: input.agentId, allowed: input.allowed },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mailboxConnectionKeys.list })
    },
  })
}
