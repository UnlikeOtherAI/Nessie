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

/**
 * Every server field is optional, matching the route: the form sends what the
 * person has actually told it and the server resolves the rest by trying the
 * standard endpoints with the credential. Sending a field is an instruction, so
 * the form must leave one out rather than fill it with a guess of its own —
 * a placeholder port posted as a value is indistinguishable from a chosen one.
 */
export type ConnectMailboxInput = {
  scope: MailboxConnectionScope
  teamId?: string | null
  label: string
  address: string
  username?: string
  password: string
  /** One hostname for both legs. A leg's own host wins over it. */
  server?: string
  imapHost?: string
  imapPort?: number
  imapSecurity?: MailboxTransportSecurity
  smtpHost?: string
  smtpPort?: number
  smtpSecurity?: MailboxTransportSecurity
}

export const useConnectMailbox = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ConnectMailboxInput) =>
      apiClient.post<MailboxConnectionRecord>('/api/mailbox-connections', input),
    /**
     * The connect dialog is this mutation's failure surface, and the only
     * caller. It reads the per-leg diagnosis off the refusal and turns it into
     * the next question, so declaring the handler here keeps the app-wide
     * "Something went wrong" toast floor from firing as well: that floor checks
     * `useMutation`'s own `onError` and cannot see a per-call one, so without
     * this a generic toast lands on top of the sentence that says which of the
     * two servers we could not reach.
     */
    onError: () => undefined,
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
